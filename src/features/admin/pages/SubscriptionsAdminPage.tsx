import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  CreditCard,
  Edit2,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  Sparkles,
  Store,
  Trash2,
  Upload,
  X,
  Calendar,
} from 'lucide-react';
import { Navigate } from 'react-router-dom';
import * as api from '@/api';
import type { SubscriptionPlan, SubscriptionStatus } from '@/lib/types';
import { formatCurrency, formatDate } from '@/lib/format';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/Button';
import { Card, PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/Toast';
import { Input, Textarea } from '@/components/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface BranchRow {
  id: string;
  name: string;
  name_en: string | null;
  is_active: boolean;
}

interface PaymentRow {
  id: string;
  branch_id: string;
  plan_id: string | null;
  amount: number;
  billing_period: 'monthly' | 'yearly';
  reference: string | null;
  receipt_url: string | null;
  status: 'pending' | 'approved' | 'rejected';
  submitted_at: string;
  rejection_reason: string | null;
}

interface SubscriptionSettings {
  id?: boolean;
  instapay_id: string | null;
  beneficiary_name: string | null;
  qr_code_url: string | null;
  instructions_ar: string | null;
  instructions_en: string | null;
  trial_days: number;
  warning_days: number;
  grace_days: number;
  require_receipt: boolean;
  allow_monthly: boolean;
  allow_yearly: boolean;
}

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

const AVAILABLE_FEATURES = [
  { id: 'pos', ar: 'نقطة البيع والمبيعات (POS)', en: 'POS & Sales' },
  { id: 'kds', ar: 'شاشة المطبخ (KDS)', en: 'Kitchen Display (KDS)' },
  { id: 'inventory', ar: 'المخزون والمستودعات', en: 'Inventory & Warehouses' },
  { id: 'recipes', ar: 'الوصفات والتصنيع', en: 'Recipes & Manufacturing' },
  { id: 'purchases', ar: 'المشتريات والموردين', en: 'Purchasing & Suppliers' },
  { id: 'costing', ar: 'حساب التكلفة والربحية', en: 'Costing & Profitability' },
  { id: 'accounting', ar: 'المحاسبة والقيود المالية', en: 'Accounting & Journal' },
  { id: 'multi_branch', ar: 'تعدد الفروع والربط المركزي', en: 'Multi-Branch Support' },
  { id: 'reports', ar: 'التقارير التحليلية المتقدمة', en: 'Advanced Reports' },
  { id: 'audit_logs', ar: 'سجل العمليات والتدقيق', en: 'Audit & Security Logs' },
  { id: 'tables', ar: 'إدارة الطاولات والصالة', en: 'Floor Plan & Tables' },
  { id: 'employees', ar: 'إدارة الموظفين والصلاحيات', en: 'Staff & Roles Management' },
];

export function SubscriptionsAdminPage() {
  const { user } = useAuth();
  const { lang } = useLanguage();
  const { show } = useToast();
  const isAr = lang === 'ar';

  const [activeTab, setActiveTab] = useState<'plans' | 'payments' | 'gateway' | 'branches'>('plans');
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [statuses, setStatuses] = useState<Record<string, SubscriptionStatus>>({});
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Payment review state
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectPaymentId, setRejectPaymentId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // Settings state
  const [settings, setSettings] = useState<SubscriptionSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  // Plan editor modal state
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<Partial<SubscriptionPlan> | null>(null);
  const [savingPlan, setSavingPlan] = useState(false);
  const [deletePlanConfirmOpen, setDeletePlanConfirmOpen] = useState(false);
  const [deletingPlanId, setDeletingPlanId] = useState<string | null>(null);

  // Branch override modal state
  const [branchOverrideModalOpen, setBranchOverrideModalOpen] = useState(false);
  const [selectedBranchForOverride, setSelectedBranchForOverride] = useState<BranchRow | null>(null);
  const [overridePlanId, setOverridePlanId] = useState<string>('');
  const [overrideStatus, setOverrideStatus] = useState<string>('active');
  const [overrideDaysToAdd, setOverrideDaysToAdd] = useState<number>(30);
  const [savingBranchOverride, setSavingBranchOverride] = useState(false);

  // Search & filters
  const [searchQuery, setSearchQuery] = useState('');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b, p, pay, s] = await Promise.all([
        api.supabase.from('branches').select('id,name,name_en,is_active').order('name'),
        api.subscriptions.listPlans(),
        api.supabase
          .from('subscription_payments')
          .select('id,branch_id,plan_id,amount,billing_period,reference,receipt_url,status,submitted_at,rejection_reason')
          .order('submitted_at', { ascending: false }),
        api.supabase.rpc('subscription_settings_get'),
      ]);

      if (b.error || pay.error || p.error || s.error) {
        show((b.error || pay.error || p.error || s.error)?.message || 'Load failed', 'error');
      }

      setBranches((b.data as BranchRow[] | null) ?? []);
      setPlans((p.data ?? []));
      setPayments((pay.data as PaymentRow[] | null) ?? []);
      setSettings((s.data as SubscriptionSettings | null) ?? null);

      const map: Record<string, SubscriptionStatus> = {};
      await Promise.all(
        ((b.data as BranchRow[] | null) ?? []).map(async (branch) => {
          const r = await api.subscriptions.status({ p_branch_id: branch.id });
          if (!r.error && r.data) map[branch.id] = r.data;
        })
      );
      setStatuses(map);
    } catch (err) {
      console.error(err);
      show('Failed to fetch subscription data', 'error');
    } finally {
      setLoading(false);
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  // Payment Review Handlers
  const reviewPayment = async (id: string, approve: boolean, reason?: string) => {
    setReviewing(id);
    const { data, error } = await api.supabase.rpc('review_instapay_payment', {
      p_payment_id: id,
      p_approve: approve,
      p_rejection_reason: approve ? null : (reason || (isAr ? 'لم يتم اعتماد التحويل' : 'Transfer was not approved')),
    });
    setReviewing(null);
    setRejectModalOpen(false);
    setRejectPaymentId(null);
    setRejectReason('');

    if (error || !(data as { success?: boolean })?.success) {
      show((data as { error?: string })?.error || error?.message || 'Review failed', 'error');
      return;
    }
    show(
      approve
        ? isAr ? 'تم اعتماد الاشتراك وتفعيل الفرع مباشرة' : 'Subscription approved and activated'
        : isAr ? 'تم رفض التحويل' : 'Payment rejected',
      'success'
    );
    await load();
  };

  // Subscription Settings Handler
  const saveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    const { data, error } = await api.supabase.rpc('subscription_settings_update', {
      p_instapay_id: settings.instapay_id,
      p_beneficiary_name: settings.beneficiary_name,
      p_qr_code_url: settings.qr_code_url,
      p_instructions_ar: settings.instructions_ar,
      p_instructions_en: settings.instructions_en,
      p_trial_days: settings.trial_days,
      p_warning_days: settings.warning_days,
      p_grace_days: settings.grace_days,
      p_require_receipt: settings.require_receipt,
      p_allow_monthly: settings.allow_monthly,
      p_allow_yearly: settings.allow_yearly,
    });
    setSavingSettings(false);
    if (error || !(data as { success?: boolean })?.success) {
      show((data as { error?: string })?.error || error?.message || (isAr ? 'فشل حفظ الإعدادات' : 'Failed to save settings'), 'error');
      return;
    }
    show(isAr ? 'تم حفظ إعدادات الاشتراكات والدفع بنجاح' : 'Subscription & gateway settings saved', 'success');
  };

  // Plan Management Handlers
  const handleOpenPlanModal = (plan?: SubscriptionPlan) => {
    if (plan) {
      setEditingPlan({ ...plan });
    } else {
      setEditingPlan({
        name_ar: '',
        name_en: '',
        monthly_price_egp: 299,
        yearly_price_egp: 2990,
        features: ['pos', 'inventory', 'reports'],
        is_active: true,
      });
    }
    setPlanModalOpen(true);
  };

  const handleSavePlan = async () => {
    if (!editingPlan || !editingPlan.name_ar?.trim()) {
      show(isAr ? 'يرجى إدخال اسم الخطة بالعربية' : 'Please enter plan Arabic name', 'error');
      return;
    }
    setSavingPlan(true);
    const payload = {
      id: editingPlan.id,
      name_ar: editingPlan.name_ar.trim(),
      name_en: editingPlan.name_en?.trim() || editingPlan.name_ar.trim(),
      monthly_price_egp: Number(editingPlan.monthly_price_egp) || 0,
      yearly_price_egp: Number(editingPlan.yearly_price_egp) || 0,
      features: editingPlan.features || [],
      is_active: editingPlan.is_active ?? true,
    };

    const res = await api.subscriptions.savePlan(payload);
    setSavingPlan(false);

    if (res.error) {
      show(res.error.message || 'Failed to save plan', 'error');
      return;
    }

    show(isAr ? 'تم حفظ بيانات الخطة والأسعار بنجاح' : 'Plan and pricing saved successfully', 'success');
    setPlanModalOpen(false);
    setEditingPlan(null);
    await load();
  };

  const handleDeletePlan = async () => {
    if (!deletingPlanId) return;
    const res = await api.subscriptions.deletePlan(deletingPlanId);
    setDeletePlanConfirmOpen(false);
    setDeletingPlanId(null);
    if (res.error) {
      show(res.error.message || 'Failed to delete plan', 'error');
      return;
    }
    show(isAr ? 'تم حذف الخطة' : 'Plan deleted', 'success');
    await load();
  };

  // Branch Override Handlers
  const handleOpenBranchOverride = (branch: BranchRow) => {
    setSelectedBranchForOverride(branch);
    const st = statuses[branch.id];
    setOverridePlanId(st?.plan_id || (plans[0]?.id ?? ''));
    setOverrideStatus(st?.status || 'active');
    setOverrideDaysToAdd(30);
    setBranchOverrideModalOpen(true);
  };

  const handleSaveBranchOverride = async () => {
    if (!selectedBranchForOverride) return;
    setSavingBranchOverride(true);

    const st = statuses[selectedBranchForOverride.id];
    let newEnd = st?.current_period_ends_at ? new Date(st.current_period_ends_at) : new Date();
    if (newEnd.getTime() < Date.now()) {
      newEnd = new Date();
    }
    newEnd.setDate(newEnd.getDate() + (Number(overrideDaysToAdd) || 30));

    const res = await api.subscriptions.updateBranchSubscription({
      branch_id: selectedBranchForOverride.id,
      plan_id: overridePlanId || null,
      status: overrideStatus,
      current_period_ends_at: newEnd.toISOString(),
    });

    setSavingBranchOverride(false);
    if (res.error) {
      show(res.error.message || 'Failed to update branch subscription', 'error');
      return;
    }

    show(isAr ? 'تم تحديث اشتراك الفرع وتمديد الصلاحية بنجاح' : 'Branch subscription updated successfully', 'success');
    setBranchOverrideModalOpen(false);
    setSelectedBranchForOverride(null);
    await load();
  };

  // Computed metrics
  const stats = useMemo(() => {
    const totalBranches = branches.length;
    const activeCount = branches.filter((b) => {
      const st = statuses[b.id];
      return st && !st.expired && (st.status === 'active' || st.status === 'trial');
    }).length;
    const pendingPaymentsCount = payments.filter((p) => p.status === 'pending').length;
    const expiredCount = branches.filter((b) => statuses[b.id]?.expired).length;
    return { totalBranches, activeCount, pendingPaymentsCount, expiredCount };
  }, [branches, statuses, payments]);

  const filteredBranches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => (b.name + ' ' + (b.name_en || '')).toLowerCase().includes(q));
  }, [branches, searchQuery]);

  const filteredPayments = useMemo(() => {
    if (paymentStatusFilter === 'all') return payments;
    return payments.filter((p) => p.status === paymentStatusFilter);
  }, [payments, paymentStatusFilter]);

  if (user?.role !== 'super_admin') {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <PageHeader
          title={isAr ? 'إدارة الاشتراكات والأسعار' : 'Subscription & Pricing Control'}
          subtitle={
            isAr
              ? 'لوحة تحكم السوبر أدمن — إدارة شاملة للخطط، الأسعار، بوابات الدفع واشتراكات الفروع'
              : 'Super Admin Control — Full management of plans, pricing, payment gateways & branch subscriptions'
          }
        />
        <Button variant="outline" onClick={() => void load()} disabled={loading} className="self-start sm:self-auto">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          <span>{isAr ? 'تحديث البيانات' : 'Refresh'}</span>
        </Button>
      </div>

      {/* KPI Stats Overview */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-ui-border bg-ui-surface p-4 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-ui-primary-soft text-ui-primary flex items-center justify-center flex-shrink-0">
            <Store className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs font-semibold text-ui-subtle">{isAr ? 'إجمالي الفروع' : 'Total Branches'}</p>
            <p className="text-2xl font-bold text-ui-text mt-0.5">{stats.totalBranches}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-ui-border bg-ui-surface p-4 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-ui-success-soft text-ui-success flex items-center justify-center flex-shrink-0">
            <BadgeCheck className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs font-semibold text-ui-subtle">{isAr ? 'الاشتراكات النشطة' : 'Active Subscriptions'}</p>
            <p className="text-2xl font-bold text-ui-text mt-0.5">{stats.activeCount}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-ui-border bg-ui-surface p-4 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-ui-warning-soft text-ui-warning flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs font-semibold text-ui-subtle">{isAr ? 'طلبات دفع معلقة' : 'Pending Approvals'}</p>
            <p className="text-2xl font-bold text-ui-text mt-0.5">{stats.pendingPaymentsCount}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-ui-border bg-ui-surface p-4 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-ui-danger-soft text-ui-danger flex items-center justify-center flex-shrink-0">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs font-semibold text-ui-subtle">{isAr ? 'فروع منتهية الصلاحية' : 'Expired Branches'}</p>
            <p className="text-2xl font-bold text-ui-text mt-0.5">{stats.expiredCount}</p>
          </div>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="flex gap-2 border-b border-ui-border pb-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab('plans')}
          className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all whitespace-nowrap ${
            activeTab === 'plans'
              ? 'bg-ui-primary text-ui-primary-fg shadow'
              : 'text-ui-muted hover:bg-ui-page-alt'
          }`}
        >
          <CreditCard className="w-4 h-4" />
          <span>{isAr ? 'الخطط والأسعار والمميزات' : 'Plans & Pricing Matrix'}</span>
          <span className="ms-1 px-2 py-0.5 rounded-full text-xs bg-black/10">{plans.length}</span>
        </button>

        <button
          onClick={() => setActiveTab('payments')}
          className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all whitespace-nowrap ${
            activeTab === 'payments'
              ? 'bg-ui-primary text-ui-primary-fg shadow'
              : 'text-ui-muted hover:bg-ui-page-alt'
          }`}
        >
          <Upload className="w-4 h-4" />
          <span>{isAr ? 'طلبات التحويل والمعاملات' : 'Payment Requests'}</span>
          {stats.pendingPaymentsCount > 0 && (
            <span className="ms-1 px-2 py-0.5 rounded-full text-xs bg-ui-warning font-bold text-black">
              {stats.pendingPaymentsCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('gateway')}
          className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all whitespace-nowrap ${
            activeTab === 'gateway'
              ? 'bg-ui-primary text-ui-primary-fg shadow'
              : 'text-ui-muted hover:bg-ui-page-alt'
          }`}
        >
          <Settings className="w-4 h-4" />
          <span>{isAr ? 'إعدادات InstaPay والبوابة' : 'InstaPay & Gateway Config'}</span>
        </button>

        <button
          onClick={() => setActiveTab('branches')}
          className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all whitespace-nowrap ${
            activeTab === 'branches'
              ? 'bg-ui-primary text-ui-primary-fg shadow'
              : 'text-ui-muted hover:bg-ui-page-alt'
          }`}
        >
          <Store className="w-4 h-4" />
          <span>{isAr ? 'اشتراكات الفروع والتحكم اليدوي' : 'Branch Subscriptions & Overrides'}</span>
        </button>
      </div>

      {/* TAB 1: Plans & Pricing Matrix */}
      {activeTab === 'plans' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-ui-text">
                {isAr ? 'باقات الاشتراك والأسعار المتاحة' : 'Subscription Plans & Tiers'}
              </h3>
              <p className="text-xs text-ui-subtle mt-0.5">
                {isAr
                  ? 'يمكنك إنشاء باقات جديدة، تعديل الأسعار الشهرية والسنوية، وتحديد المميزات المشمولة بكل باقة.'
                  : 'Manage subscription tiers, configure monthly/yearly pricing and feature entitlements.'}
              </p>
            </div>
            <Button onClick={() => handleOpenPlanModal()}>
              <Plus className="w-4 h-4" />
              <span>{isAr ? 'إضافة باقة جديدة' : 'Add New Plan'}</span>
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <Card key={plan.id} className="p-5 flex flex-col justify-between relative overflow-hidden">
                {!plan.is_active && (
                  <div className="absolute top-3 end-3 px-2 py-0.5 rounded text-[11px] font-bold bg-ui-danger-soft text-ui-danger">
                    {isAr ? 'غير مفعلة' : 'Inactive'}
                  </div>
                )}
                <div>
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div>
                      <h4 className="text-xl font-bold text-ui-text">{isAr ? plan.name_ar : plan.name_en || plan.name_ar}</h4>
                      {plan.name_en && plan.name_en !== plan.name_ar && (
                        <p className="text-xs text-ui-subtle">{plan.name_en}</p>
                      )}
                    </div>
                  </div>

                  <div className="my-4 p-3 rounded-xl bg-ui-page-alt border border-ui-border flex items-baseline justify-between">
                    <div>
                      <span className="text-2xl font-black text-ui-text">{formatCurrency(plan.monthly_price_egp)}</span>
                      <span className="text-xs text-ui-subtle ms-1">{isAr ? '/ شهر' : '/ mo'}</span>
                    </div>
                    <div className="text-end">
                      <span className="text-sm font-bold text-ui-text">{formatCurrency(plan.yearly_price_egp)}</span>
                      <span className="text-xs text-ui-subtle ms-1">{isAr ? '/ سنة' : '/ yr'}</span>
                    </div>
                  </div>

                  <div className="space-y-2 mb-6">
                    <p className="text-xs font-bold text-ui-subtle uppercase tracking-wider">
                      {isAr ? 'المميزات المشمولة:' : 'Included Features:'}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {normalizeFeatures(plan.features).map((fKey) => {
                        const feat = AVAILABLE_FEATURES.find((af) => af.id === fKey);
                        return (
                          <span
                            key={fKey}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-ui-primary-soft text-ui-primary"
                          >
                            <Check className="w-3 h-3" />
                            <span>{feat ? (isAr ? feat.ar : feat.en) : fKey}</span>
                          </span>
                        );
                      })}
                      {normalizeFeatures(plan.features).length === 0 && (
                        <span className="text-xs text-ui-subtle italic">
                          {isAr ? 'لا توجد مميزات مخصصة' : 'No custom features'}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-4 border-t border-ui-border">
                  <Button variant="outline" size="sm" onClick={() => handleOpenPlanModal(plan)} className="flex-1">
                    <Edit2 className="w-3.5 h-3.5" />
                    <span>{isAr ? 'تعديل الخطة والأسعار' : 'Edit Plan'}</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDeletingPlanId(plan.id);
                      setDeletePlanConfirmOpen(true);
                    }}
                    className="text-ui-danger hover:bg-ui-danger-soft"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* TAB 2: Payment Requests */}
      {activeTab === 'payments' && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-lg font-bold text-ui-text">
                {isAr ? 'طلبات التحويل والمعاملات المعلقة' : 'Payment Requests & Submissions'}
              </h3>
              <p className="text-xs text-ui-subtle mt-0.5">
                {isAr
                  ? 'قم بمراجعة إيصالات التحويل عبر InstaPay واعتمادها لتفعيل اشتراك الفرع فوريًا.'
                  : 'Review submitted transfer receipts and approve them to immediately activate branch subscriptions.'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={paymentStatusFilter}
                onChange={(e) => setPaymentStatusFilter(e.target.value as never)}
                className="rounded-xl border border-ui-border bg-ui-surface px-3 py-2 text-xs font-semibold text-ui-text outline-none"
              >
                <option value="all">{isAr ? 'جميع الحالات' : 'All Statuses'}</option>
                <option value="pending">{isAr ? 'المعلقة فقط' : 'Pending Only'}</option>
                <option value="approved">{isAr ? 'المعتمدة' : 'Approved'}</option>
                <option value="rejected">{isAr ? 'المرفوضة' : 'Rejected'}</option>
              </select>
            </div>
          </div>

          {filteredPayments.length === 0 ? (
            <Card className="p-12 text-center text-ui-subtle">
              <Upload className="w-10 h-10 mx-auto mb-3 opacity-40 text-ui-muted" />
              <p className="text-base font-bold text-ui-text">
                {isAr ? 'لا توجد طلبات دفع حالياً' : 'No payment requests found'}
              </p>
              <p className="text-xs text-ui-subtle mt-1">
                {isAr ? 'ستظهر هنا طلبات الاشتراكات عند قيام الفروع بإرسال إيصالات الدفع' : 'Payment requests will appear here when branches submit transfers'}
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {filteredPayments.map((pay) => {
                const branch = branches.find((b) => b.id === pay.branch_id);
                const plan = plans.find((p) => p.id === pay.plan_id);

                return (
                  <Card key={pay.id} className="p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2.5">
                          <Store className="h-4 w-4 text-ui-primary" />
                          <span className="font-bold text-base text-ui-text">
                            {branch ? (isAr ? branch.name : branch.name_en || branch.name) : pay.branch_id}
                          </span>
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                              pay.status === 'pending'
                                ? 'bg-ui-warning-soft text-ui-warning'
                                : pay.status === 'approved'
                                ? 'bg-ui-success-soft text-ui-success'
                                : 'bg-ui-danger-soft text-ui-danger'
                            }`}
                          >
                            {pay.status === 'pending'
                              ? isAr ? 'معلق للمراجعة' : 'Pending Review'
                              : pay.status === 'approved'
                              ? isAr ? 'تم الاعتماد' : 'Approved'
                              : isAr ? 'مرفوض' : 'Rejected'}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-3 text-xs text-ui-subtle">
                          <span className="font-semibold text-ui-text">
                            {plan ? (isAr ? plan.name_ar : plan.name_en) : isAr ? 'خطة مخصصة' : 'Custom Plan'}
                          </span>
                          <span>•</span>
                          <span className="font-bold text-ui-primary text-sm">{formatCurrency(pay.amount)}</span>
                          <span>•</span>
                          <span>{pay.billing_period === 'yearly' ? (isAr ? 'اشتراك سنوي' : 'Yearly') : (isAr ? 'اشتراك شهري' : 'Monthly')}</span>
                          <span>•</span>
                          <span>{formatDate(pay.submitted_at, lang)}</span>
                          {pay.reference && (
                            <>
                              <span>•</span>
                              <span className="font-mono bg-ui-page-alt px-2 py-0.5 rounded border border-ui-border">
                                {pay.reference}
                              </span>
                            </>
                          )}
                        </div>

                        {pay.rejection_reason && (
                          <p className="text-xs text-ui-danger font-medium mt-1">
                            {isAr ? 'سبب الرفض: ' : 'Rejection reason: '} {pay.rejection_reason}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {pay.receipt_url && (
                          <a
                            href={pay.receipt_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-xl border border-ui-border bg-ui-surface px-3 py-2 text-xs font-semibold text-ui-text hover:bg-ui-page-alt transition"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            <span>{isAr ? 'معاينة الإيصال' : 'View Receipt'}</span>
                          </a>
                        )}

                        {pay.status === 'pending' && (
                          <>
                            <Button
                              size="sm"
                              onClick={() => void reviewPayment(pay.id, true)}
                              disabled={reviewing === pay.id}
                            >
                              <Check className="h-4 w-4" />
                              <span>{isAr ? 'اعتماد وتفعيل' : 'Approve & Activate'}</span>
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setRejectPaymentId(pay.id);
                                setRejectModalOpen(true);
                              }}
                              disabled={reviewing === pay.id}
                              className="text-ui-danger hover:bg-ui-danger-soft"
                            >
                              <X className="h-4 w-4" />
                              <span>{isAr ? 'رفض' : 'Reject'}</span>
                            </Button>
                          </>
                        )}

                        {reviewing === pay.id && <Loader2 className="h-5 w-5 animate-spin text-ui-primary" />}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: InstaPay & Gateway Config */}
      {activeTab === 'gateway' && (
        <Card className="p-6">
          <div className="mb-5 flex items-center gap-3 border-b border-ui-border pb-4">
            <Settings className="h-6 w-6 text-ui-primary" />
            <div>
              <h3 className="text-lg font-bold text-ui-text">
                {isAr ? 'إعدادات استقبال المدفوعات وInstaPay' : 'InstaPay & Payment Gateway Configuration'}
              </h3>
              <p className="text-xs text-ui-subtle">
                {isAr
                  ? 'هذه الإعدادات عامة وتظهر لمديري الفروع في شاشة الاشتراك والسداد.'
                  : 'Global payment instructions shown to branch managers during checkout and upgrades.'}
              </p>
            </div>
          </div>

          {!settings ? (
            <div className="py-12 text-center text-ui-subtle">
              <Loader2 className="w-8 h-8 animate-spin mx-auto text-ui-primary" />
              <p className="text-xs mt-2">{isAr ? 'جارٍ تحميل الإعدادات...' : 'Loading gateway settings...'}</p>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-3">
                <Input
                  label={isAr ? 'معرّف حساب InstaPay (Username/IPA)' : 'InstaPay ID / Handle'}
                  value={settings.instapay_id ?? ''}
                  onChange={(e) => setSettings({ ...settings, instapay_id: e.target.value })}
                  placeholder="e.g. company@instapay"
                />
                <Input
                  label={isAr ? 'اسم المستفيد المعتمد' : 'Beneficiary Full Name'}
                  value={settings.beneficiary_name ?? ''}
                  onChange={(e) => setSettings({ ...settings, beneficiary_name: e.target.value })}
                  placeholder="e.g. Premier POS Enterprise Ltd."
                />
                <Input
                  label={isAr ? 'رابط صورة رمز الاستجابة QR Code' : 'QR Code Image URL'}
                  value={settings.qr_code_url ?? ''}
                  onChange={(e) => setSettings({ ...settings, qr_code_url: e.target.value })}
                  placeholder="https://.../qr.png"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Textarea
                  label={isAr ? 'تعليمات التحويل بالعربية' : 'Transfer Instructions (Arabic)'}
                  value={settings.instructions_ar ?? ''}
                  onChange={(e) => setSettings({ ...settings, instructions_ar: e.target.value })}
                  rows={3}
                  placeholder="يرجى كتابة اسم الفرع في خانة الملاحظات وإرفاق الإيصال..."
                />
                <Textarea
                  label={isAr ? 'تعليمات التحويل بالإنجليزية' : 'Transfer Instructions (English)'}
                  value={settings.instructions_en ?? ''}
                  onChange={(e) => setSettings({ ...settings, instructions_en: e.target.value })}
                  rows={3}
                  placeholder="Please include branch name in notes and upload receipt..."
                />
              </div>

              <div className="grid gap-4 md:grid-cols-3 pt-2">
                <Input
                  label={isAr ? 'فترة التجربة الافتراضية (أيام)' : 'Default Trial Days'}
                  type="number"
                  value={settings.trial_days}
                  onChange={(e) => setSettings({ ...settings, trial_days: Number(e.target.value) || 0 })}
                />
                <Input
                  label={isAr ? 'أيام التنبيه قبل الانتهاء' : 'Warning Alert Days Before Expiry'}
                  type="number"
                  value={settings.warning_days}
                  onChange={(e) => setSettings({ ...settings, warning_days: Number(e.target.value) || 0 })}
                />
                <Input
                  label={isAr ? 'فترة السماح بعد الانتهاء (أيام)' : 'Grace Period (Days)'}
                  type="number"
                  value={settings.grace_days}
                  onChange={(e) => setSettings({ ...settings, grace_days: Number(e.target.value) || 0 })}
                />
              </div>

              <div className="flex flex-wrap gap-6 pt-2 border-t border-ui-border text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.require_receipt}
                    onChange={(e) => setSettings({ ...settings, require_receipt: e.target.checked })}
                    className="w-4 h-4 rounded text-ui-primary focus:ring-ui-primary"
                  />
                  <span className="font-semibold">{isAr ? 'إلزام إرفاق صورة الإيصال' : 'Require receipt upload'}</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.allow_monthly}
                    onChange={(e) => setSettings({ ...settings, allow_monthly: e.target.checked })}
                    className="w-4 h-4 rounded text-ui-primary focus:ring-ui-primary"
                  />
                  <span className="font-semibold">{isAr ? 'إتاحة السداد الشهري' : 'Allow monthly billing'}</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.allow_yearly}
                    onChange={(e) => setSettings({ ...settings, allow_yearly: e.target.checked })}
                    className="w-4 h-4 rounded text-ui-primary focus:ring-ui-primary"
                  />
                  <span className="font-semibold">{isAr ? 'إتاحة السداد السنوي' : 'Allow yearly billing'}</span>
                </label>
              </div>

              <div className="flex justify-end pt-4">
                <Button onClick={() => void saveSettings()} disabled={savingSettings}>
                  {savingSettings && <Loader2 className="h-4 w-4 animate-spin" />}
                  <span>{isAr ? 'حفظ إعدادات البوابة والاشتراكات' : 'Save Gateway Settings'}</span>
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* TAB 4: Branch Subscriptions & Overrides */}
      {activeTab === 'branches' && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-lg font-bold text-ui-text">
                {isAr ? 'إدارة اشتراكات وتراخيص الفروع' : 'Branch Subscriptions & Licenses'}
              </h3>
              <p className="text-xs text-ui-subtle mt-0.5">
                {isAr
                  ? 'عرض حالة اشتراك كل فرع، وتعديل الخطة أو تمديد فترة الصلاحية يدويًا.'
                  : 'View individual branch subscription status, override tiers or manually extend validity.'}
              </p>
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ui-subtle" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={isAr ? 'بحث عن فرع...' : 'Search branch...'}
                className="w-full rounded-xl border border-ui-border bg-ui-surface ps-9 pe-3 py-2 text-xs outline-none focus:border-ui-primary"
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {filteredBranches.map((branch) => {
              const st = statuses[branch.id];
              const plan = plans.find((p) => p.id === st?.plan_id);
              const isExpired = st?.expired;
              const isTrial = st?.status === 'trial';

              return (
                <Card key={branch.id} className="p-5 flex flex-col justify-between">
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h4 className="font-bold text-base text-ui-text">
                          {isAr ? branch.name : branch.name_en || branch.name}
                        </h4>
                        <p className="text-xs text-ui-subtle mt-0.5">
                          {plan ? (isAr ? plan.name_ar : plan.name_en) : isAr ? 'بدون خطة محددة' : 'No plan'}
                        </p>
                      </div>

                      <span
                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
                          isExpired
                            ? 'bg-ui-danger-soft text-ui-danger'
                            : isTrial
                            ? 'bg-ui-warning-soft text-ui-warning'
                            : 'bg-ui-success-soft text-ui-success'
                        }`}
                      >
                        {isExpired ? (
                          <>
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>{isAr ? 'منتهي' : 'Expired'}</span>
                          </>
                        ) : isTrial ? (
                          <>
                            <Sparkles className="w-3.5 h-3.5" />
                            <span>{isAr ? 'تجريبي' : 'Trial'}</span>
                          </>
                        ) : (
                          <>
                            <BadgeCheck className="w-3.5 h-3.5" />
                            <span>{isAr ? 'نشط' : 'Active'}</span>
                          </>
                        )}
                      </span>
                    </div>

                    <div className="p-3 rounded-xl bg-ui-page-alt border border-ui-border text-xs flex items-center justify-between">
                      <span className="text-ui-subtle">{isAr ? 'تاريخ انتهاء الصلاحية:' : 'Expiration Date:'}</span>
                      <span className="font-bold font-mono text-ui-text">
                        {st?.current_period_ends_at
                          ? formatDate(st.current_period_ends_at, lang)
                          : isAr ? 'غير محدد' : 'Not set'}
                      </span>
                    </div>
                  </div>

                  <div className="pt-4 mt-4 border-t border-ui-border flex justify-end">
                    <Button size="sm" variant="outline" onClick={() => handleOpenBranchOverride(branch)}>
                      <Calendar className="w-3.5 h-3.5" />
                      <span>{isAr ? 'تعديل الخطة / تمديد الصلاحية' : 'Edit Plan / Extend Days'}</span>
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Plan Add/Edit Modal */}
      {planModalOpen && editingPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-3xl bg-ui-surface border border-ui-border p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-xl font-bold text-ui-text">
                  {editingPlan.id
                    ? isAr ? 'تعديل بيانات الخطة والأسعار' : 'Edit Plan & Pricing'
                    : isAr ? 'إضافة باقة اشتراك جديدة' : 'Create Subscription Plan'}
                </h3>
                <p className="text-xs text-ui-subtle mt-0.5">
                  {isAr ? 'حدد الاسم والأسعار والمميزات المشمولة' : 'Configure name, prices, and enabled capabilities'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPlanModalOpen(false)}
                className="w-8 h-8 rounded-full bg-ui-page-alt hover:bg-ui-border text-ui-text flex items-center justify-center font-bold"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={isAr ? 'اسم الباقة (بالعربية)' : 'Plan Name (Arabic)'}
                  value={editingPlan.name_ar ?? ''}
                  onChange={(e) => setEditingPlan({ ...editingPlan, name_ar: e.target.value })}
                  placeholder="مثال: الباقة الاحترافية"
                />
                <Input
                  label={isAr ? 'اسم الباقة (بالإنجليزية)' : 'Plan Name (English)'}
                  value={editingPlan.name_en ?? ''}
                  onChange={(e) => setEditingPlan({ ...editingPlan, name_en: e.target.value })}
                  placeholder="e.g. Professional Plan"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={isAr ? 'السعر الشهري (EGP)' : 'Monthly Price (EGP)'}
                  type="number"
                  value={editingPlan.monthly_price_egp ?? ''}
                  onChange={(e) =>
                    setEditingPlan({ ...editingPlan, monthly_price_egp: parseFloat(e.target.value) || 0 })
                  }
                />
                <Input
                  label={isAr ? 'السعر السنوي (EGP)' : 'Yearly Price (EGP)'}
                  type="number"
                  value={editingPlan.yearly_price_egp ?? ''}
                  onChange={(e) =>
                    setEditingPlan({ ...editingPlan, yearly_price_egp: parseFloat(e.target.value) || 0 })
                  }
                />
              </div>

              <div className="pt-2">
                <label className="flex items-center gap-2 cursor-pointer mb-3">
                  <input
                    type="checkbox"
                    checked={editingPlan.is_active ?? true}
                    onChange={(e) => setEditingPlan({ ...editingPlan, is_active: e.target.checked })}
                    className="w-4 h-4 rounded text-ui-primary focus:ring-ui-primary"
                  />
                  <span className="text-sm font-bold text-ui-text">
                    {isAr ? 'الخطة مفعلة ومتاحة للاشتراك' : 'Plan is active and available for subscription'}
                  </span>
                </label>
              </div>

              <div className="space-y-2 pt-2 border-t border-ui-border">
                <label className="text-xs font-bold text-ui-text block">
                  {isAr ? 'المميزات والصلاحيات المشمولة بالباقة:' : 'Included Features & Entitlements:'}
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {AVAILABLE_FEATURES.map((feat) => {
                    const normFeats = normalizeFeatures(editingPlan.features);
                    const isChecked = normFeats.includes(feat.id);
                    return (
                      <label
                        key={feat.id}
                        className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-xs cursor-pointer transition ${
                          isChecked
                            ? 'border-ui-primary bg-ui-primary-soft text-ui-primary font-bold'
                            : 'border-ui-border bg-ui-page-alt text-ui-subtle'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            const current = normalizeFeatures(editingPlan.features);
                            const next = e.target.checked
                              ? [...current, feat.id]
                              : current.filter((x) => x !== feat.id);
                            setEditingPlan({ ...editingPlan, features: next });
                          }}
                          className="w-4 h-4 rounded text-ui-primary"
                        />
                        <span>{isAr ? feat.ar : feat.en}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-4 border-t border-ui-border">
              <Button variant="outline" onClick={() => setPlanModalOpen(false)} className="flex-1">
                {isAr ? 'إلغاء' : 'Cancel'}
              </Button>
              <Button onClick={() => void handleSavePlan()} disabled={savingPlan} className="flex-1">
                {savingPlan && <Loader2 className="h-4 w-4 animate-spin" />}
                <span>{isAr ? 'حفظ الخطة' : 'Save Plan'}</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Branch Subscription Override Modal */}
      {branchOverrideModalOpen && selectedBranchForOverride && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl bg-ui-surface border border-ui-border p-6 shadow-2xl space-y-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-xl font-bold text-ui-text">
                  {isAr ? 'تعديل اشتراك الفرع' : 'Branch Subscription Override'}
                </h3>
                <p className="text-xs text-ui-subtle mt-0.5">
                  {isAr ? selectedBranchForOverride.name : selectedBranchForOverride.name_en || selectedBranchForOverride.name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setBranchOverrideModalOpen(false)}
                className="w-8 h-8 rounded-full bg-ui-page-alt hover:bg-ui-border text-ui-text flex items-center justify-center font-bold"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-ui-text mb-1 block">
                  {isAr ? 'باقة الاشتراك المخصصة' : 'Assigned Subscription Plan'}
                </label>
                <select
                  value={overridePlanId}
                  onChange={(e) => setOverridePlanId(e.target.value)}
                  className="w-full rounded-xl border border-ui-border bg-ui-page-alt p-2.5 text-sm text-ui-text outline-none focus:border-ui-primary"
                >
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {isAr ? p.name_ar : p.name_en} ({formatCurrency(p.monthly_price_egp)}/mo)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-ui-text mb-1 block">
                  {isAr ? 'حالة الاشتراك' : 'Subscription Status'}
                </label>
                <select
                  value={overrideStatus}
                  onChange={(e) => setOverrideStatus(e.target.value)}
                  className="w-full rounded-xl border border-ui-border bg-ui-page-alt p-2.5 text-sm text-ui-text outline-none focus:border-ui-primary"
                >
                  <option value="active">{isAr ? 'نشط (Active)' : 'Active'}</option>
                  <option value="trial">{isAr ? 'فترة تجريبية (Trial)' : 'Trial'}</option>
                  <option value="past_due">{isAr ? 'متأخر السداد (Past Due)' : 'Past Due'}</option>
                  <option value="suspended">{isAr ? 'معلق (Suspended)' : 'Suspended'}</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-ui-text mb-1 block">
                  {isAr ? 'تمديد الصلاحية بمقدار (أيام)' : 'Extend Validity by (Days)'}
                </label>
                <div className="flex gap-2 mb-2">
                  {[30, 90, 180, 365].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setOverrideDaysToAdd(d)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition ${
                        overrideDaysToAdd === d
                          ? 'bg-ui-primary text-ui-primary-fg'
                          : 'bg-ui-page-alt text-ui-subtle hover:bg-ui-border'
                      }`}
                    >
                      +{d} {isAr ? 'يوم' : 'd'}
                    </button>
                  ))}
                </div>
                <Input
                  type="number"
                  value={overrideDaysToAdd}
                  onChange={(e) => setOverrideDaysToAdd(parseInt(e.target.value) || 0)}
                  placeholder="30"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-4 border-t border-ui-border">
              <Button variant="outline" onClick={() => setBranchOverrideModalOpen(false)} className="flex-1">
                {isAr ? 'إلغاء' : 'Cancel'}
              </Button>
              <Button
                onClick={() => void handleSaveBranchOverride()}
                disabled={savingBranchOverride}
                className="flex-1"
              >
                {savingBranchOverride && <Loader2 className="h-4 w-4 animate-spin" />}
                <span>{isAr ? 'تأكيد التحديث والتمديد' : 'Confirm Override'}</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Payment Reason Dialog */}
      {rejectModalOpen && rejectPaymentId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl bg-ui-surface border border-ui-border p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-ui-text">
              {isAr ? 'رفض طلب التحويل' : 'Reject Payment Request'}
            </h3>
            <p className="text-xs text-ui-subtle">
              {isAr ? 'يرجى توضيح سبب الرفض ليظهر لمدير الفرع' : 'Please provide a rejection reason for the branch manager'}
            </p>
            <Textarea
              label={isAr ? 'سبب الرفض' : 'Rejection Reason'}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              placeholder={isAr ? 'مثال: رقم المرجع غير مطابق أو صورة الإيصال غير واضحة' : 'e.g. Invalid reference code or unreadable receipt'}
            />
            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={() => setRejectModalOpen(false)} className="flex-1">
                {isAr ? 'إلغاء' : 'Cancel'}
              </Button>
              <Button
                variant="danger"
                onClick={() => void reviewPayment(rejectPaymentId, false, rejectReason)}
                className="flex-1"
              >
                {isAr ? 'تأكيد الرفض' : 'Confirm Rejection'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Plan Confirm */}
      <ConfirmDialog
        open={deletePlanConfirmOpen}
        onClose={() => setDeletePlanConfirmOpen(false)}
        onConfirm={handleDeletePlan}
        title={isAr ? 'حذف باقة الاشتراك' : 'Delete Subscription Plan'}
        message={
          isAr
            ? 'هل أنت متأكد من حذف هذه الباقة؟ لن يؤثر ذلك على الفروع المشتركة حالياً.'
            : 'Are you sure you want to delete this plan? Active branch subscriptions will remain intact.'
        }
        confirmLabel={isAr ? 'حذف' : 'Delete'}
        cancelLabel={isAr ? 'إلغاء' : 'Cancel'}
      />
    </div>
  );
}
