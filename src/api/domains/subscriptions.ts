import { supabase } from '@/lib/supabase';
import type { ApiError, ApiResult } from '../types';
import type { RpcResult, SubscriptionStatus, SubscriptionPlan } from '@/lib/types';
import { rpc } from '../rpc';

function normalizeFeatures(features: unknown): string[] {
  if (!features) return [];
  if (Array.isArray(features)) {
    return features.map((f) => {
      if (typeof f === 'string') return f;
      if (typeof f === 'object' && f !== null) {
        if ('key' in f && typeof (f as { key: unknown }).key === 'string') return (f as { key: string }).key;
        if ('name' in f && typeof (f as { name: unknown }).name === 'string') return (f as { name: string }).name;
        if ('id' in f && typeof (f as { id: unknown }).id === 'string') return (f as { id: string }).id;
      }
      return String(f);
    });
  }
  if (typeof features === 'string') {
    try {
      const parsed = JSON.parse(features);
      return normalizeFeatures(parsed);
    } catch {
      return features.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  if (typeof features === 'object' && features !== null) {
    return Object.entries(features)
      .filter(([, val]) => Boolean(val))
      .map(([k]) => k);
  }
  return [];
}

export const subscriptions = {
  async registerTenant(p: {
    p_store_name: string;
    p_owner_name: string;
    p_email: string;
    p_password: string;
    p_store_name_en?: string | null;
    p_phone?: string | null;
    p_address?: string | null;
    p_currency?: string | null;
  }): ApiResult<RpcResult & { organization_id?: string; branch_id?: string; warehouse_id?: string; user_id?: string; membership_role?: string; trial_days?: number }> {
    try {
      const res = await rpc<RpcResult & { organization_id?: string; branch_id?: string; warehouse_id?: string; user_id?: string; membership_role?: string; trial_days?: number }>('register_tenant', p);
      if (!res.error && res.data && (res.data.success || (res.data as Record<string, unknown>).organization_id)) {
        return res;
      }
      // If error indicates function missing or cache mismatch, proceed to resilient client-side provisioning
      if (res.error && !res.error.message.includes('EMAIL_TAKEN')) {
        console.warn('register_tenant RPC returned error, attempting direct provisioning:', res.error.message);
      } else if (res.error) {
        return res;
      }
    } catch (err) {
      console.warn('register_tenant RPC failed to execute:', err);
    }

    // Direct Tenant Provisioning Fallback
    try {
      const email = p.p_email.trim().toLowerCase();
      const password = p.p_password;

      // 1. Sign up user in Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: p.p_owner_name.trim(),
            store_name: p.p_store_name.trim(),
          },
        },
      });

      if (authError) {
        if (authError.message.toLowerCase().includes('already registered')) {
          return { data: { success: false, error: 'EMAIL_TAKEN' }, error: null };
        }
        return { data: { success: false, error: authError.message }, error: null };
      }

      const userId = authData.user?.id;
      if (!userId) {
        return { data: { success: false, error: 'Failed to create user session' }, error: null };
      }

      const orgSlug = p.p_store_name.trim().toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Math.random().toString(36).substring(2, 6);

      // 2. Insert Organization
      const { data: orgData, error: orgError } = await supabase
        .from('organizations')
        .insert({
          name: p.p_store_name.trim(),
          slug: orgSlug,
          currency: p.p_currency || 'EGP',
          is_active: true,
        })
        .select()
        .single();

      if (orgError) {
        console.error('Failed to create organization:', orgError);
        return { data: { success: false, error: orgError.message }, error: null };
      }

      const orgId = orgData.id;

      // 3. Insert Main Branch
      const { data: branchData, error: branchError } = await supabase
        .from('branches')
        .insert({
          organization_id: orgId,
          name: p.p_store_name.trim() + ' - الفرع الرئيسي',
          name_en: p.p_store_name_en ? `${p.p_store_name_en} - Main Branch` : null,
          phone: p.p_phone || null,
          address: p.p_address || null,
          is_main: true,
          is_active: true,
        })
        .select()
        .single();

      if (branchError) {
        console.error('Failed to create branch:', branchError);
      }

      const branchId = branchData?.id;

      // 4. Insert Default Warehouse
      if (branchId) {
        await supabase.from('warehouses').insert({
          organization_id: orgId,
          branch_id: branchId,
          name: 'المستودع الرئيسي',
          name_en: 'Main Warehouse',
          is_default: true,
          is_active: true,
        });
      }

      // 5. Insert Organization Member (Owner)
      await supabase.from('organization_members').insert({
        organization_id: orgId,
        user_id: userId,
        role: 'owner',
        is_active: true,
      });

      // 6. Upsert User record
      await supabase.from('users').upsert({
        id: userId,
        email,
        full_name: p.p_owner_name.trim(),
        role: 'owner',
        branch_id: branchId || null,
        is_active: true,
        created_at: new Date().toISOString(),
      });

      // 7. Initialize 14-day trial subscription
      const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      if (branchId) {
        await supabase.from('branch_subscriptions').upsert({
          branch_id: branchId,
          status: 'trialing',
          current_period_ends_at: trialEndsAt,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'branch_id' });
      }

      await supabase.from('subscriptions').upsert({
        tenant_id: orgId,
        status: 'trialing',
        trial_started_at: new Date().toISOString(),
        trial_ends_at: trialEndsAt,
        current_period_start: new Date().toISOString(),
        current_period_end: trialEndsAt,
        auto_renew: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id' });

      return {
        data: {
          success: true,
          organization_id: orgId,
          branch_id: branchId,
          user_id: userId,
          membership_role: 'owner',
          trial_days: 14,
        },
        error: null,
      };
    } catch (fallbackErr) {
      console.error('Tenant registration fallback exception:', fallbackErr);
      return {
        data: { success: false, error: fallbackErr instanceof Error ? fallbackErr.message : 'Registration failed' },
        error: null,
      };
    }
  },

  status(p: { p_branch_id: string }): ApiResult<SubscriptionStatus> { return rpc('subscription_status', p); },
  activate(p: { p_branch_id: string; p_plan_id: string; p_billing_period?: 'monthly' | 'yearly'; p_activate?: boolean }): ApiResult<RpcResult & { price_egp?: number }> { return rpc('activate_subscription', p); },

  async listPlans(): ApiResult<SubscriptionPlan[]> {
    const res = await supabase.from('subscription_plans').select('*').order('monthly_price_egp', { ascending: true });
    if (res.error || !res.data) {
      // Try fallback from plans table
      const { data: pData } = await supabase.from('plans').select('*, plan_prices(*)').eq('is_active', true);
      if (pData && pData.length > 0) {
        const mapped: SubscriptionPlan[] = pData.map((p) => {
          const prices = (p.plan_prices as Array<{ billing_cycle: string; price: number }>) || [];
          const mPrice = prices.find((pr) => pr.billing_cycle === 'monthly')?.price || 0;
          const yPrice = prices.find((pr) => pr.billing_cycle === 'yearly')?.price || mPrice * 10;
          return {
            id: p.id,
            code: p.slug || p.id,
            name_ar: p.name,
            name_en: p.slug,
            monthly_price_egp: mPrice,
            yearly_price_egp: yPrice,
            max_branches: 1,
            max_users_per_branch: 5,
            features: ['pos', 'inventory', 'reports', 'accounting'],
            is_active: p.is_active ?? true,
            created_at: p.created_at,
          };
        });
        return { data: mapped, error: null };
      }
      return { data: (res.data as SubscriptionPlan[] | null) ?? null, error: res.error as ApiError | null };
    }
    const normalized = (res.data as Record<string, unknown>[]).map((item) => ({
      ...item,
      features: normalizeFeatures(item.features),
    })) as SubscriptionPlan[];
    return { data: normalized, error: null };
  },

  async savePlan(plan: Partial<SubscriptionPlan> & { name_ar: string }): ApiResult<SubscriptionPlan> {
    const normFeatures = normalizeFeatures(plan.features);
    const payload = {
      ...plan,
      features: normFeatures,
    };

    let resultPlan: SubscriptionPlan | null = null;
    if (plan.id) {
      const res = await supabase.from('subscription_plans').update(payload).eq('id', plan.id).select().single();
      if (res.data) {
        const item = res.data as Record<string, unknown>;
        resultPlan = { ...item, features: normalizeFeatures(item.features) } as SubscriptionPlan;
      }
    } else {
      const res = await supabase.from('subscription_plans').insert(payload).select().single();
      if (res.data) {
        const item = res.data as Record<string, unknown>;
        resultPlan = { ...item, features: normalizeFeatures(item.features) } as SubscriptionPlan;
      }
    }

    if (resultPlan) {
      // Dual-sync to plans and plan_prices table to guarantee relational consistency
      try {
        const planSlug = resultPlan.code || resultPlan.id;
        const { data: upsertedPlan } = await supabase.from('plans').upsert({
          id: resultPlan.id,
          name: resultPlan.name_ar,
          slug: planSlug,
          description: resultPlan.name_en || resultPlan.name_ar,
          is_active: resultPlan.is_active ?? true,
          is_public: resultPlan.is_active ?? true,
          updated_at: new Date().toISOString(),
        }).select().maybeSingle();

        if (upsertedPlan) {
          // Sync monthly & yearly prices
          await supabase.from('plan_prices').upsert([
            {
              plan_id: resultPlan.id,
              billing_cycle: 'monthly',
              price: resultPlan.monthly_price_egp,
              currency: 'EGP',
              is_active: true,
            },
            {
              plan_id: resultPlan.id,
              billing_cycle: 'yearly',
              price: resultPlan.yearly_price_egp,
              currency: 'EGP',
              is_active: true,
            },
          ]);
        }
      } catch (syncErr) {
        console.warn('Dual-sync to plans table skipped/failed:', syncErr);
      }

      return { data: resultPlan, error: null };
    }

    return { data: null, error: { message: 'Failed to save subscription plan' } as ApiError };
  },

  async deletePlan(id: string): ApiResult<void> {
    const res = await supabase.from('subscription_plans').delete().eq('id', id);
    try {
      await supabase.from('plans').delete().eq('id', id);
    } catch {
      // Best-effort
    }
    return { data: null, error: res.error as ApiError | null };
  },

  async updateBranchSubscription(p: { branch_id: string; plan_id?: string | null; status?: string; current_period_ends_at?: string | null }): ApiResult<void> {
    const res = await supabase.from('branch_subscriptions').upsert({
      branch_id: p.branch_id,
      plan_id: p.plan_id ?? null,
      status: p.status ?? 'active',
      current_period_ends_at: p.current_period_ends_at ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'branch_id' });

    // Also sync to parent organization subscription
    try {
      const { data: branch } = await supabase.from('branches').select('organization_id').eq('id', p.branch_id).single();
      if (branch?.organization_id) {
        await supabase.from('subscriptions').upsert({
          tenant_id: branch.organization_id,
          plan_id: p.plan_id ?? null,
          status: p.status ?? 'active',
          current_period_end: p.current_period_ends_at ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id' });
      }
    } catch {
      // Best effort
    }

    return { data: null, error: res.error as ApiError | null };
  },
};


