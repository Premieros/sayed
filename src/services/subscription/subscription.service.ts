import { supabase } from '../../lib/supabase';
import type {
  Plan,
  PlanPrice,
  Feature,
  TenantSubscriptionDetails,
  SubscriptionEvent,
  BranchFeatureOverride,
} from './subscription.types';
import { FeatureGateEngine } from './feature-gate.service';

export class SubscriptionService {
  /**
   * Loads full tenant subscription details with plans, features, branch overrides, usage, and events.
   */
  public static async getTenantSubscriptionDetails(
    tenantId?: string
  ): Promise<TenantSubscriptionDetails> {
    try {
      const { data, error } = await supabase.rpc('get_tenant_subscription_details', {
        p_tenant_id: tenantId || null,
      });

      if (!error && data && !data.error) {
        FeatureGateEngine.setTenantDetails(data as TenantSubscriptionDetails);
        return data as TenantSubscriptionDetails;
      }
    } catch (rpcErr) {
      console.warn('get_tenant_subscription_details RPC failed, using fallback query:', rpcErr);
    }

    // Direct Table Queries Fallback
    try {
      // 1. Fetch current user's organization
      let orgId = tenantId;
      if (!orgId) {
        const { data: member } = await supabase
          .from('organization_members')
          .select('organization_id')
          .limit(1)
          .maybeSingle();
        orgId = member?.organization_id;
      }

      if (!orgId) {
        return { has_subscription: false };
      }

      // 2. Fetch subscription
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('tenant_id', orgId)
        .maybeSingle();

      if (!sub) {
        return { has_subscription: false, tenant_id: orgId };
      }

      // 3. Fetch plan
      const { data: plan } = await supabase
        .from('plans')
        .select('*')
        .eq('id', sub.plan_id)
        .single();

      // 4. Fetch price if set
      let price: PlanPrice | null = null;
      if (sub.plan_price_id) {
        const { data: p } = await supabase
          .from('plan_prices')
          .select('*')
          .eq('id', sub.plan_price_id)
          .maybeSingle();
        price = p;
      }

      // 5. Fetch features and plan features
      const { data: allFeatures } = await supabase
        .from('features')
        .select('*')
        .eq('is_active', true);
      const { data: planFeatures } = await supabase
        .from('plan_features')
        .select('*')
        .eq('plan_id', sub.plan_id);

      const featuresWithDetails = (allFeatures || []).map((f) => {
        const pf = planFeatures?.find((p) => p.feature_id === f.id);
        return {
          key: f.key,
          name: f.name,
          description: f.description,
          category: f.category,
          enabled: pf ? pf.enabled : false,
          limit_value: pf?.limit_value ?? null,
          limit_type: pf?.limit_type ?? 'boolean',
        };
      });

      // 6. Branch overrides
      const { data: overrides } = await supabase
        .from('branch_feature_overrides')
        .select('*, branches(name), features(key, name)')
        .eq('tenant_id', orgId);

      const formattedOverrides: BranchFeatureOverride[] = ((overrides || []) as Array<{
        id: string;
        tenant_id: string;
        branch_id: string;
        branches?: { name?: string };
        feature_id: string;
        features?: { key?: string; name?: string };
        enabled: boolean;
        limit_value?: number | null;
        reason?: string | null;
      }>).map((o) => ({
        id: o.id,
        tenant_id: o.tenant_id,
        branch_id: o.branch_id,
        branch_name: o.branches?.name,
        feature_id: o.feature_id,
        feature_key: o.features?.key || '',
        feature_name: o.features?.name || '',
        enabled: o.enabled,
        limit_value: o.limit_value ?? null,
        reason: o.reason ?? null,
      }));

      // 7. Counts
      const { count: branchCount } = await supabase
        .from('branches')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId);

      const { count: userCount } = await supabase
        .from('organization_members')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('is_active', true);

      const result: TenantSubscriptionDetails = {
        has_subscription: true,
        tenant_id: orgId,
        subscription: sub,
        plan: plan || undefined,
        price: price || undefined,
        features: featuresWithDetails,
        branch_overrides: formattedOverrides,
        usage: {
          branches_count: branchCount || 0,
          users_count: userCount || 0,
          warehouses_count: 0,
        },
      };

      FeatureGateEngine.setTenantDetails(result);
      return result;
    } catch (fallbackErr) {
      console.error('Subscription fallback failed:', fallbackErr);
      return { has_subscription: false };
    }
  }

  /**
   * Retrieves all active public plans with prices and plan features for selection & comparison.
   */
  public static async getPublicPlans(): Promise<Plan[]> {
    try {
      const { data: plans, error: pErr } = await supabase
        .from('plans')
        .select('*, plan_prices(*)')
        .eq('is_active', true)
        .order('display_order', { ascending: true });

      if (pErr) throw pErr;

      // Fetch features for comparison
      const { data: features } = await supabase
        .from('features')
        .select('*')
        .eq('is_active', true);

      const { data: planFeatures } = await supabase
        .from('plan_features')
        .select('*');

      return (plans || []).map((rawPlan) => {
        const plan = rawPlan as Plan & { plan_prices?: PlanPrice[] };
        const pFeats = (features || []).map((f) => {
          const pf = planFeatures?.find(
            (p) => p.plan_id === plan.id && p.feature_id === f.id
          );
          return {
            key: f.key,
            name: f.name,
            description: f.description,
            category: f.category,
            enabled: pf ? pf.enabled : false,
            limit_value: pf?.limit_value ?? null,
            limit_type: pf?.limit_type ?? 'boolean',
          };
        });

        return {
          id: plan.id,
          name: plan.name,
          slug: plan.slug,
          description: plan.description,
          is_active: plan.is_active,
          is_public: plan.is_public,
          display_order: plan.display_order,
          created_at: plan.created_at,
          prices: plan.plan_prices || plan.prices || [],
          features: pFeats,
        };
      }) as Plan[];
    } catch (err) {
      console.error('Failed to get public plans:', err);
      return [];
    }
  }

  /**
   * Retrieves full feature catalog (Super Admin / Management).
   */
  public static async getAllFeatures(): Promise<Feature[]> {
    const { data, error } = await supabase
      .from('features')
      .select('*')
      .order('category', { ascending: true })
      .order('name', { ascending: true });

    if (error) {
      console.error('Failed to fetch features:', error);
      return [];
    }
    return data || [];
  }

  /**
   * Retrieves subscription events log for a tenant.
   */
  public static async getTenantEvents(tenantId: string): Promise<SubscriptionEvent[]> {
    const { data, error } = await supabase
      .from('subscription_events')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Failed to fetch subscription events:', error);
      return [];
    }
    return data || [];
  }

  /**
   * Super Admin: Changes or sets a tenant subscription.
   */
  public static async superAdminChangeSubscription(payload: {
    tenantId: string;
    planId: string;
    status: string;
    currentPeriodEnd?: string;
    trialEndsAt?: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('super_admin_change_subscription', {
        p_tenant_id: payload.tenantId,
        p_plan_id: payload.planId,
        p_status: payload.status,
        p_current_period_end: payload.currentPeriodEnd || null,
        p_trial_ends_at: payload.trialEndsAt || null,
      });

      if (error) throw error;
      return data || { success: true };
    } catch {
      // Fallback direct update
      const { error: upsertErr } = await supabase.from('subscriptions').upsert(
        {
          tenant_id: payload.tenantId,
          plan_id: payload.planId,
          status: payload.status,
          current_period_end: payload.currentPeriodEnd,
          trial_ends_at: payload.trialEndsAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id' }
      );

      if (upsertErr) return { success: false, error: upsertErr.message };
      return { success: true };
    }
  }

  /**
   * Super Admin: Sets a branch feature override.
   */
  public static async setBranchOverride(payload: {
    tenantId: string;
    branchId: string;
    featureKey: string;
    enabled: boolean;
    limitValue?: number | null;
    reason?: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('super_admin_set_branch_override', {
        p_tenant_id: payload.tenantId,
        p_branch_id: payload.branchId,
        p_feature_key: payload.featureKey,
        p_enabled: payload.enabled,
        p_limit_value: payload.limitValue ?? null,
        p_reason: payload.reason || null,
      });

      if (error) throw error;
      return data || { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: msg };
    }
  }

  /**
   * Super Admin: Removes a branch feature override.
   */
  public static async removeBranchOverride(
    branchId: string,
    featureKey: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('super_admin_remove_branch_override', {
        p_branch_id: branchId,
        p_feature_key: featureKey,
      });

      if (error) throw error;
      return data || { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: msg };
    }
  }
}
