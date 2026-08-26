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
  registerTenant(p: { p_store_name: string; p_owner_name: string; p_email: string; p_password: string; p_store_name_en?: string | null; p_phone?: string | null; p_address?: string | null; p_currency?: string | null }): ApiResult<RpcResult & { organization_id?: string; branch_id?: string; warehouse_id?: string; user_id?: string; membership_role?: string; trial_days?: number }> { return rpc('register_tenant', p); },
  status(p: { p_branch_id: string }): ApiResult<SubscriptionStatus> { return rpc('subscription_status', p); },
  activate(p: { p_branch_id: string; p_plan_id: string; p_billing_period?: 'monthly' | 'yearly'; p_activate?: boolean }): ApiResult<RpcResult & { price_egp?: number }> { return rpc('activate_subscription', p); },
  async listPlans(): ApiResult<SubscriptionPlan[]> {
    const res = await supabase.from('subscription_plans').select('*').order('monthly_price_egp', { ascending: true });
    if (res.error || !res.data) {
      return { data: (res.data as SubscriptionPlan[] | null) ?? null, error: res.error as ApiError | null };
    }
    const normalized = (res.data as Record<string, unknown>[]).map((item) => ({
      ...item,
      features: normalizeFeatures(item.features),
    })) as SubscriptionPlan[];
    return { data: normalized, error: null };
  },
  async savePlan(plan: Partial<SubscriptionPlan> & { name_ar: string }): ApiResult<SubscriptionPlan> {
    const payload = {
      ...plan,
      features: normalizeFeatures(plan.features),
    };
    if (plan.id) {
      const res = await supabase.from('subscription_plans').update(payload).eq('id', plan.id).select().single();
      if (res.data) {
        const item = res.data as Record<string, unknown>;
        return { data: { ...item, features: normalizeFeatures(item.features) } as SubscriptionPlan, error: null };
      }
      return { data: res.data as SubscriptionPlan | null, error: res.error as ApiError | null };
    }
    const res = await supabase.from('subscription_plans').insert(payload).select().single();
    if (res.data) {
      const item = res.data as Record<string, unknown>;
      return { data: { ...item, features: normalizeFeatures(item.features) } as SubscriptionPlan, error: null };
    }
    return { data: res.data as SubscriptionPlan | null, error: res.error as ApiError | null };
  },
  async deletePlan(id: string): ApiResult<void> {
    const res = await supabase.from('subscription_plans').delete().eq('id', id);
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
    return { data: null, error: res.error as ApiError | null };
  },
};

