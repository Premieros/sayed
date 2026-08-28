import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  BadgeCheck,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  CreditCard,
  Edit2,
  ExternalLink,
  FileSpreadsheet,
  Layers,
  Loader2,
  Plus,
  QrCode,
  Receipt,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Store,
  Trash2,
  Users,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { supabase, admin, subscriptions as subApi } from '@/api';
import type { SubscriptionPlan, SubscriptionStatus, BranchSettings } from '@/lib/types';
import { useLanguage } from '@/context/LanguageContext';
import { useToast } from '@/components/Toast';
import { useSettings } from '@/context/SettingsContext';
import { useBranches } from '@/hooks/useBranches';
import { DesignSurface } from '@/components/design/DesignSurface';
import { DesignSearch } from '@/components/design/DesignSearch';
import { Button } from '@/components/Button';
import { Card } from '@/components/PageHeader';
import { Input, Textarea, Select } from '@/components/Input';
import { Modal } from '@/components/Modal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { RolesTab } from './RolesTab';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { logAudit } from '@/lib/audit';

interface TenantStats {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  is_active: boolean;
  created_at: string;
  branch_count: number;
  user_count: number;
  total_branches: number;
  active_branches: number;
  has_active_subscription: boolean;
}

interface TenantUser {
  user_id: string;
  email: string;
  username: string;
  full_name: string;
  role: string;
  is_active: boolean;
  branch_id: string | null;
  branch_name: string | null;
  org_id: string | null;
  org_name: string | null;
  created_at: string;
}

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

interface AuditLogRow {
  id: string;
  action: string;
  entity: string;
  user_email: string | null;
  created_at: string;
  details: unknown;
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

type SuperTab =
  | 'tenants'
  | 'subscriptions'
  | 'general'
  | 'branches_override'
  | 'roles'
  | 'users_audit'
  | 'health';

type SubscriptionsSubTab = 'plans' | 'gateway' | 'payments' | 'branch_subs';

export function SuperAdminConsolePage() {
  const { lang } = useLanguage();
  const { show } = useToast();
  const ar = lang === 'ar';
  const { settings, branchSettingsMap, save, saveBranchSettings } = useSettings();
  const { branches } = useBranches();

  const [activeTab, setActiveTab] = useState<SuperTab>('tenants');

  // Tenants state
  const [tenants, setTenants] = useState<TenantStats[]>([]);
  const [expandedOrg, setExpandedOrg] = useState<string | null>(null);
  const [loadingTenants, setLoadingTenants] = useState(false);

  // Subscriptions & Plans state
  const [subTab, setSubTab] = useState<SubscriptionsSubTab>('plans');
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [gatewaySettings, setGatewaySettings] = useState<SubscriptionSettings | null>(null);
  const [branchStatuses, setBranchStatuses] = useState<Record<string, SubscriptionStatus>>({});
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [savingGateway, setSavingGateway] = useState(false);

  // Plan editing modal
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<Partial<SubscriptionPlan> | null>(null);
  const [savingPlan, setSavingPlan] = useState(false);
  const [deletePlanConfirmOpen, setDeletePlanConfirmOpen] = useState(false);
  const [deletingPlanId, setDeletingPlanId] = useState<string | null>(null);

  // Payment review modal
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectPaymentId, setRejectPaymentId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [viewReceiptModal, setViewReceiptModal] = useState<string | null>(null);

  // Manual Branch override modal
  const [branchOverrideModalOpen, setBranchOverrideModalOpen] = useState(false);
  const [selectedBranchForOverride, setSelectedBranchForOverride] = useState<BranchRow | null>(null);
  const [overridePlanId, setOverridePlanId] = useState<string>('');
  const [overrideStatus, setOverrideStatus] = useState<string>('active');
  const [overrideDaysToAdd, setOverrideDaysToAdd] = useState<number>(30);
  const [savingBranchOverride, setSavingBranchOverride] = useState(false);

  // Enterprise Store Settings state
  const [generalForm, setGeneralForm] = useState<Record<string, string | number | null | undefined>>({});
  const [savingGeneral, setSavingGeneral] = useState(false);

  // Branch Specific Customizations state
  const [targetBranchId, setTargetBranchId] = useState<string>(branches[0]?.id || '');
  const [branchForm, setBranchForm] = useState<Record<string, string | number | null | undefined>>({});
  const [savingBranchCustom, setSavingBranchCustom] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoConfirmOpen, setDemoConfirmOpen] = useState(false);

  // Users & Audit Log state
  const [userAuditSubTab, setUserAuditSubTab] = useState<'users' | 'audit'>('users');
  const [allUsers, setAllUsers] = useState<TenantUser[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [auditSearch, setAuditSearch] = useState('');
  const [loadingUsersAudit, setLoadingUsersAudit] = useState(false);

  // Health checks state
  const [healthRunning, setHealthRunning] = useState(false);
  const [healthResults, setHealthResults] = useState<{ key: string; label: string; status: 'ok' | 'error' | 'checking'; detail: string }[]>([]);

  // ─────────────────────────────────────────────────────────────
  // 1. Load Tenants
  // ─────────────────────────────────────────────────────────────
  const loadTenants = useCallback(async () => {
    setLoadingTenants(true);
    try {
      const { data, error } = await supabase.rpc('get_super_admin_tenant_stats');
      if (!error && Array.isArray(data)) {
        setTenants(data as TenantStats[]);
        setLoadingTenants(false);
        return;
      }

      // Fallback
      const { data: orgs } = await supabase
        .from('organizations')
        .select('id, name, slug, is_active, created_at')
        .order('created_at', { ascending: false });

      const { data: branchData } = await supabase.from('branches').select('id, organization_id, is_active');
      const { data: memberData } = await supabase.from('organization_members').select('organization_id, user_id, is_active');
      const { data: subsData } = await supabase.from('branch_subscriptions').select('branch_id, status, current_period_ends_at');

      const now = new Date().toISOString();
      const activeBranchIds = new Set(
        (subsData || [])
          .filter((s) => s.status === 'active' && s.current_period_ends_at && s.current_period_ends_at > now)
          .map((s) => s.branch_id)
      );

      const computed: TenantStats[] = (orgs || []).map((org) => {
        const orgBranches = (branchData || []).filter((b) => b.organization_id === org.id);
        const orgMembers = (memberData || []).filter((m) => m.organization_id === org.id && m.is_active);
        const hasSub = orgBranches.some((b) => activeBranchIds.has(b.id));

        return {
          organization_id: org.id,
          organization_name: org.name || 'Unnamed Organization',
          organization_slug: org.slug || 'org',
          is_active: org.is_active ?? true,
          created_at: org.created_at || new Date().toISOString(),
          branch_count: orgBranches.length,
          user_count: orgMembers.length,
          total_branches: orgBranches.length,
          active_branches: orgBranches.filter((b) => b.is_active ?? true).length,
          has_active_subscription: hasSub,
        };
      });

      setTenants(computed);
    } catch {
      setTenants([]);
    } finally {
      setLoadingTenants(false);
    }
  }, []);

  // ─────────────────────────────────────────────────────────────
  // 2. Load Subscriptions & Plans
  // ─────────────────────────────────────────────────────────────
  const loadSubscriptions = useCallback(async () => {
    setLoadingSubs(true);
    try {
      const [pRes, payRes, sRes] = await Promise.all([
        subApi.listPlans(),
        supabase
          .from('subscription_payments')
          .select('id,branch_id,plan_id,amount,billing_period,reference,receipt_url,status,submitted_at,rejection_reason')
          .order('submitted_at', { ascending: false }),
        supabase.rpc('subscription_settings_get'),
      ]);

      if (pRes.data) setPlans(pRes.data);
      if (payRes.data) setPayments(payRes.data as PaymentRow[]);
      if (sRes.data) setGatewaySettings(sRes.data as SubscriptionSettings);

      const statusMap: Record<string, SubscriptionStatus> = {};
      await Promise.all(
        branches.map(async (b) => {
          const res = await subApi.status({ p_branch_id: b.id });
          if (res.data) statusMap[b.id] = res.data;
        })
      );
      setBranchStatuses(statusMap);
    } catch {
      // Ignored
    } finally {
      setLoadingSubs(false);
    }
  }, [branches]);

  // ─────────────────────────────────────────────────────────────
  // 3. Load Users & Audit Logs
  // ─────────────────────────────────────────────────────────────
  const loadUsersAndAudit = useCallback(async () => {
    setLoadingUsersAudit(true);
    try {
      const [uRes, aRes, bRes, oRes, mRes] = await Promise.all([
        supabase.from('users').select('id, email, username, full_name, role, is_active, branch_id, created_at').order('created_at', { ascending: false }),
        supabase.from('audit_log').select('id, action, entity, user_email, created_at, details').order('created_at', { ascending: false }).limit(100),
        supabase.from('branches').select('id, name, organization_id'),
        supabase.from('organizations').select('id, name'),
        supabase.from('organization_members').select('user_id, organization_id').eq('is_active', true),
      ]);

      const branchMap = new Map((bRes.data || []).map((b) => [b.id, b]));
      const orgMap = new Map((oRes.data || []).map((o) => [o.id, o]));
      const memberMap = new Map((mRes.data || []).map((m) => [m.user_id, m.organization_id]));

      const computedUsers: TenantUser[] = (uRes.data || []).map((u) => {
        const branch = u.branch_id ? branchMap.get(u.branch_id) : undefined;
        const orgId = memberMap.get(u.id) || branch?.organization_id || null;
        const org = orgId ? orgMap.get(orgId) : undefined;
        return {
          user_id: u.id,
          email: u.email || '',
          username: u.username || '',
          full_name: u.full_name || '',
          role: u.role || 'cashier',
          is_active: u.is_active ?? true,
          branch_id: u.branch_id || null,
          branch_name: branch?.name || null,
          org_id: orgId,
          org_name: org?.name || null,
          created_at: u.created_at || new Date().toISOString(),
        };
      });

      setAllUsers(computedUsers);
      setAuditLogs((aRes.data || []) as AuditLogRow[]);
    } catch {
      // Ignored
    } finally {
      setLoadingUsersAudit(false);
    }
  }, []);

  // ─────────────────────────────────────────────────────────────
  // 4. Initial Settings Hydration
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (settings) {
      setGeneralForm({
        store_name: settings.store_name || '',
        store_address: settings.store_address || '',
        store_phone: settings.store_phone || '',
        logo_url: settings.logo_url || '',
        currency: settings.currency || 'EGP',
        tax_rate: settings.tax_rate ?? 14,
        tax_enabled: settings.tax_enabled ? '1' : '0',
        receipt_width_mm: settings.receipt_width_mm || 80,
        receipt_copies: settings.receipt_copies || 1,
        receipt_show_tax: settings.receipt_show_tax ? 1 : 0,
        receipt_show_qr: settings.receipt_show_qr ? 1 : 0,
        receipt_auto_print: settings.receipt_auto_print ? 1 : 0,
        receipt_header: settings.receipt_header || '',
        receipt_footer: settings.receipt_footer || '',
        pos_default_payment_method: settings.pos_default_payment_method || 'cash',
        pos_barcode_autofocus: settings.pos_barcode_autofocus ? 1 : 0,
        low_stock_threshold: settings.low_stock_threshold ?? 5,
      });
    }
  }, [settings]);

  useEffect(() => {
    if (targetBranchId) {
      const row = branchSettingsMap[targetBranchId] || null;
      setBranchForm({
        receipt_header: row?.receipt_header ?? '',
        receipt_footer: row?.receipt_footer ?? '',
        logo_url: row?.logo_url ?? '',
        tax_rate: row?.tax_rate ?? null,
        tax_enabled: row?.tax_enabled != null ? (row.tax_enabled ? '1' : '0') : null,
        currency: row?.currency ?? '',
        low_stock_threshold: row?.low_stock_threshold ?? null,
      });
    }
  }, [targetBranchId, branchSettingsMap]);

  // Tab change trigger
  useEffect(() => {
    if (activeTab === 'tenants') void loadTenants();
    if (activeTab === 'subscriptions') void loadSubscriptions();
    if (activeTab === 'users_audit') void loadUsersAndAudit();
  }, [activeTab, loadTenants, loadSubscriptions, loadUsersAndAudit]);

  // ─────────────────────────────────────────────────────────────
  // 5. Actions Handlers
  // ─────────────────────────────────────────────────────────────
  const toggleOrgStatus = async (orgId: string, currentActive: boolean) => {
    try {
      const { data, error } = await supabase.rpc('toggle_organization_status', {
        p_org_id: orgId,
        p_is_active: !currentActive,
      });
      if (error || !(data as { success?: boolean })?.success) {
        await supabase.from('organizations').update({ is_active: !currentActive }).eq('id', orgId);
      }
      show(ar ? 'تم تحديث حالة المنظمة بنجاح' : 'Organization status updated', 'success');
      void loadTenants();
    } catch {
      show(ar ? 'حدث خطأ أثناء التحديث' : 'Update failed', 'error');
    }
  };

  const handleSaveGeneral = async () => {
    setSavingGeneral(true);
    const patch = {
      ...generalForm,
      tax_rate: Number(generalForm.tax_rate) || 0,
      tax_enabled: String(generalForm.tax_enabled) === '1' || String(generalForm.tax_enabled) === 'true',
      low_stock_threshold: Number(generalForm.low_stock_threshold) || 0,
      receipt_copies: Math.min(5, Math.max(1, Number(generalForm.receipt_copies) || 1)),
      receipt_width_mm: Number(generalForm.receipt_width_mm) || 80,
    };
    const ok = await save(patch);
    setSavingGeneral(false);
    if (ok) {
      if (settings?.id) await logAudit('update', 'settings', settings.id);
      show(ar ? 'تم حفظ إعدادات المنشأة المركزية بنجاح' : 'Master enterprise settings saved', 'success');
    } else {
      show(ar ? 'فشل حفظ الإعدادات' : 'Failed to save settings', 'error');
    }
  };

  const handleSaveBranchCustom = async () => {
    if (!targetBranchId) return;
    setSavingBranchCustom(true);
    const patch: Partial<BranchSettings> = {
      receipt_header: typeof branchForm.receipt_header === 'string' ? branchForm.receipt_header : null,
      receipt_footer: typeof branchForm.receipt_footer === 'string' ? branchForm.receipt_footer : null,
      logo_url: typeof branchForm.logo_url === 'string' ? branchForm.logo_url : null,
      tax_rate: branchForm.tax_rate != null && !Number.isNaN(Number(branchForm.tax_rate)) ? Number(branchForm.tax_rate) : null,
      tax_enabled: branchForm.tax_enabled != null ? String(branchForm.tax_enabled) === '1' || String(branchForm.tax_enabled) === 'true' : null,
      currency: typeof branchForm.currency === 'string' ? branchForm.currency : null,
      low_stock_threshold: branchForm.low_stock_threshold != null && !Number.isNaN(Number(branchForm.low_stock_threshold)) ? Number(branchForm.low_stock_threshold) : null,
    };
    const ok = await saveBranchSettings(targetBranchId, patch);
    setSavingBranchCustom(false);
    if (ok) {
      await logAudit('update', 'branch_settings', targetBranchId);
      show(ar ? 'تم حفظ تخصيصات الفرع بنجاح' : 'Branch customizations saved', 'success');
    } else {
      show(ar ? 'فشل حفظ تخصيصات الفرع' : 'Failed to save branch customizations', 'error');
    }
  };

  const handleResetBranchCustom = async () => {
    if (!targetBranchId) return;
    setSavingBranchCustom(true);
    const { error } = await supabase.from('branch_settings').delete().eq('branch_id', targetBranchId);
    setSavingBranchCustom(false);
    if (!error) {
      show(ar ? 'تمت استعادة الإعدادات الافتراضية للفرع' : 'Branch reset to global defaults', 'success');
    } else {
      show(error.message, 'error');
    }
  };

  const handleSeedDemo = async () => {
    if (!targetBranchId) return;
    setDemoBusy(true);
    const { data, error } = await admin.seedDemoData({ p_branch_id: targetBranchId });
    setDemoBusy(false);
    if (error) {
      show(error.message, 'error');
      return;
    }
    const res = data as { success?: boolean; seeded?: number; existing?: boolean } | null;
    if (!res?.success) {
      show(ar ? 'تعذر إنشاء البيانات التجريبية' : 'Failed to generate demo data', 'error');
      return;
    }
    if (res.existing) {
      show(ar ? 'البيانات التجريبية موجودة بالفعل' : 'Demo data already exists', 'info');
      return;
    }
    await logAudit('create', 'demo_data', targetBranchId, { action: 'seed' });
    show(ar ? 'تم توليد البيانات التجريبية بنجاح' : 'Demo data generated successfully', 'success');
  };

  const handleDeleteDemo = async () => {
    if (!targetBranchId) return;
    setDemoBusy(true);
    const { data, error } = await admin.deleteDemoData({ p_branch_id: targetBranchId });
    setDemoBusy(false);
    if (error) {
      show(error.message, 'error');
      return;
    }
    const res = data as { success?: boolean } | null;
    if (!res?.success) {
      show(ar ? 'تعذر حذف البيانات التجريبية' : 'Failed to wipe demo data', 'error');
      return;
    }
    await logAudit('delete', 'demo_data', targetBranchId, { action: 'delete' });
    show(ar ? 'تم حذف البيانات التجريبية بنجاح' : 'Demo data wiped successfully', 'success');
  };

  const handleSaveGateway = async () => {
    if (!gatewaySettings) return;
    setSavingGateway(true);
    const { data, error } = await supabase.rpc('subscription_settings_update', {
      p_instapay_id: gatewaySettings.instapay_id,
      p_beneficiary_name: gatewaySettings.beneficiary_name,
      p_qr_code_url: gatewaySettings.qr_code_url,
      p_instructions_ar: gatewaySettings.instructions_ar,
      p_instructions_en: gatewaySettings.instructions_en,
      p_trial_days: gatewaySettings.trial_days,
      p_warning_days: gatewaySettings.warning_days,
      p_grace_days: gatewaySettings.grace_days,
      p_require_receipt: gatewaySettings.require_receipt,
      p_allow_monthly: gatewaySettings.allow_monthly,
      p_allow_yearly: gatewaySettings.allow_yearly,
    });
    setSavingGateway(false);
    if (error || !(data as { success?: boolean })?.success) {
      show((data as { error?: string })?.error || error?.message || (ar ? 'فشل حفظ إعدادات الدفع' : 'Failed to save settings'), 'error');
      return;
    }
    show(ar ? 'تم حفظ إعدادات بوابة InstaPay بنجاح' : 'Gateway settings saved', 'success');
  };

  const reviewPayment = async (id: string, approve: boolean, reason?: string) => {
    setReviewingId(id);
    const { data, error } = await supabase.rpc('review_instapay_payment', {
      p_payment_id: id,
      p_approve: approve,
      p_rejection_reason: approve ? null : reason || (ar ? 'لم يتم اعتماد التحويل' : 'Payment rejected'),
    });
    setReviewingId(null);
    setRejectModalOpen(false);
    setRejectPaymentId(null);
    setRejectReason('');

    if (error || !(data as { success?: boolean })?.success) {
      show((data as { error?: string })?.error || error?.message || 'Review failed', 'error');
      return;
    }
    show(approve ? (ar ? 'تم اعتماد الاشتراك وتفعيل الفرع بنجاح' : 'Payment approved and branch activated') : (ar ? 'تم رفض التحويل' : 'Payment rejected'), 'success');
    void loadSubscriptions();
  };

  const handleSavePlan = async () => {
    if (!editingPlan || !editingPlan.name_ar) {
      show(ar ? 'يرجى إدخال اسم الباقة بالعربية' : 'Plan name in Arabic is required', 'error');
      return;
    }
    setSavingPlan(true);
    const res = await subApi.savePlan(editingPlan as Partial<SubscriptionPlan> & { name_ar: string });
    setSavingPlan(false);
    if (res.error) {
      show(res.error.message || 'Failed to save plan', 'error');
      return;
    }
    show(ar ? 'تم حفظ الباقة بنجاح' : 'Plan saved successfully', 'success');
    setPlanModalOpen(false);
    setEditingPlan(null);
    void loadSubscriptions();
  };

  const handleDeletePlan = async () => {
    if (!deletingPlanId) return;
    const res = await subApi.deletePlan(deletingPlanId);
    setDeletePlanConfirmOpen(false);
    setDeletingPlanId(null);
    if (res.error) {
      show(res.error.message || 'Failed to delete plan', 'error');
      return;
    }
    show(ar ? 'تم حذف الباقة بنجاح' : 'Plan deleted', 'success');
    void loadSubscriptions();
  };

  const handleSaveBranchOverride = async () => {
    if (!selectedBranchForOverride) return;
    setSavingBranchOverride(true);
    const { data, error } = await supabase.rpc('override_branch_subscription', {
      p_branch_id: selectedBranchForOverride.id,
      p_plan_id: overridePlanId || null,
      p_status: overrideStatus,
      p_days_to_add: overrideDaysToAdd,
    });
    setSavingBranchOverride(false);
    if (error || !(data as { success?: boolean })?.success) {
      show((data as { error?: string })?.error || error?.message || 'Override failed', 'error');
      return;
    }
    show(ar ? 'تم تحديث اشتراك الفرع بنجاح' : 'Branch subscription updated', 'success');
    setBranchOverrideModalOpen(false);
    setSelectedBranchForOverride(null);
    void loadSubscriptions();
  };

  const runHealthChecks = useCallback(async () => {
    setHealthRunning(true);
    const targets: { key: string; label: string; table?: string }[] = [
      { key: 'auth', label: ar ? 'التحقق من الهوية (Auth Service)' : 'Auth Service' },
      { key: 'orgs', label: ar ? 'جدول المنظمات (Organizations)' : 'Organizations', table: 'organizations' },
      { key: 'branches', label: ar ? 'جدول الفروع (Branches)' : 'Branches', table: 'branches' },
      { key: 'users_tbl', label: ar ? 'جدول المستخدمين (Users)' : 'Users', table: 'users' },
      { key: 'orders_tbl', label: ar ? 'جدول الطلبات (Orders)' : 'Orders', table: 'orders' },
      { key: 'sales_tbl', label: ar ? 'جدول المبيعات (Sales)' : 'Sales', table: 'sales' },
      { key: 'subscriptions', label: ar ? 'جدول الاشتراكات (Subscriptions)' : 'Subscriptions', table: 'branch_subscriptions' },
      { key: 'plans_tbl', label: ar ? 'باقات الأسعار (Plans)' : 'Plans', table: 'subscription_plans' },
      { key: 'payments_tbl', label: ar ? 'مدفوعات التحويل (Payments)' : 'Payments', table: 'subscription_payments' },
    ];
    setHealthResults(targets.map((t) => ({ key: t.key, label: t.label, status: 'checking', detail: '...' })));

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      try {
        if (t.key === 'auth') {
          const r = await supabase.auth.getSession();
          setHealthResults((p) => p.map((c, idx) => (idx === i ? { ...c, status: r.error ? 'error' : 'ok', detail: r.error?.message || (ar ? 'متصل ونشط' : 'Connected') } : c)));
        } else if (t.table) {
          const r = await supabase.from(t.table).select('id', { count: 'exact', head: true });
          setHealthResults((p) => p.map((c, idx) => (idx === i ? { ...c, status: r.error ? 'error' : 'ok', detail: r.error?.message || `${r.count ?? 0} ${ar ? 'سجل' : 'records'}` } : c)));
        }
      } catch {
        setHealthResults((p) => p.map((c, idx) => (idx === i ? { ...c, status: 'error', detail: 'Exception' } : c)));
      }
    }
    setHealthRunning(false);
  }, [ar]);

  // Tab definitions
  const TABS: { key: SuperTab; label: string; icon: React.ReactNode }[] = [
    { key: 'tenants', label: ar ? 'المستأجرون والمنظمات' : 'Tenants & Organizations', icon: <Building2 className="w-4 h-4" /> },
    { key: 'subscriptions', label: ar ? 'الاشتراكات والأسعار والمدفوعات' : 'Subscriptions & Pricing', icon: <CreditCard className="w-4 h-4" /> },
    { key: 'general', label: ar ? 'إعدادات المنشأة والمتجر المركزية' : 'Enterprise Settings', icon: <Store className="w-4 h-4" /> },
    { key: 'branches_override', label: ar ? 'تخصيصات الفروع والبيانات التجريبية' : 'Branch Overrides & Demo', icon: <SlidersHorizontal className="w-4 h-4" /> },
    { key: 'roles', label: ar ? 'مصفوفة الأدوار والصلاحيات' : 'RBAC Roles & Matrix', icon: <ShieldCheck className="w-4 h-4" /> },
    { key: 'users_audit', label: ar ? 'المستخدمون وسجل التدقيق' : 'Users & Audit Log', icon: <Users className="w-4 h-4" /> },
    { key: 'health', label: ar ? 'صحة وتشخيص النظام' : 'System Diagnostics', icon: <Activity className="w-4 h-4" /> },
  ];

  const tenantStats = {
    totalTenants: tenants.length,
    activeTenants: tenants.filter((t) => t.is_active).length,
    totalBranches: tenants.reduce((sum, t) => sum + (t.total_branches ?? 0), 0),
    totalUsers: tenants.reduce((sum, t) => sum + (t.user_count ?? 0), 0),
    withSub: tenants.filter((t) => t.has_active_subscription).length,
  };

  return (
    <DesignSurface testId="super-admin-master-hub">
      {/* ── Main Top Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-ui-border pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-600 to-indigo-700 text-white shadow-md shadow-brand-500/20">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-black tracking-tight text-ui-text sm:text-2xl">
                {ar ? 'لوحة تحكم المدير العام (Super Admin)' : 'Super Admin Command Center'}
              </h1>
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-500/10 px-2.5 py-0.5 text-xs font-bold text-brand-600 dark:text-brand-400">
                <Sparkles className="h-3 w-3" />
                {ar ? 'مدير النظام الكامل' : 'Full Control'}
              </span>
            </div>
            <p className="text-xs text-ui-subtle">
              {ar
                ? 'مركز إدارة جميع المنظمات، باقات الاشتراكات وبوابة الدفع، الإعدادات المركزية، الصلاحيات، وسجل التدقيق'
                : 'Centralized master hub for tenants, subscriptions, enterprise settings, permissions, and audit logs'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (activeTab === 'tenants') void loadTenants();
              if (activeTab === 'subscriptions') void loadSubscriptions();
              if (activeTab === 'users_audit') void loadUsersAndAudit();
              if (activeTab === 'health') void runHealthChecks();
            }}
          >
            <RefreshCw className={`w-4 h-4 ${loadingTenants || loadingSubs || loadingUsersAudit || healthRunning ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{ar ? 'تحديث البيانات' : 'Refresh'}</span>
          </Button>
        </div>
      </div>

      {/* ── Master Tabs Bar ── */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 border-b border-ui-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap ${
              activeTab === t.key
                ? 'bg-brand-600 text-white shadow-sm shadow-brand-500/25'
                : 'bg-ui-page-alt text-ui-muted hover:bg-ui-border/50 hover:text-ui-text'
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* ───────────────────────────────────────────────────────────── */}
      {/* TAB 1: المستأجرون والمنظمات (Tenants)                          */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeTab === 'tenants' && (
        <div className="space-y-5 animate-fade-in">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { label: ar ? 'إجمالي المنظمات' : 'Total Tenants', value: tenantStats.totalTenants, icon: <Building2 className="w-5 h-5 text-brand-500" /> },
              { label: ar ? 'المنظمات النشطة' : 'Active Tenants', value: tenantStats.activeTenants, icon: <CheckCircle2 className="w-5 h-5 text-ui-success" /> },
              { label: ar ? 'إجمالي الفروع' : 'Total Branches', value: tenantStats.totalBranches, icon: <Store className="w-5 h-5 text-blue-500" /> },
              { label: ar ? 'إجمالي المستخدمين' : 'Total Users', value: tenantStats.totalUsers, icon: <Users className="w-5 h-5 text-purple-500" /> },
              { label: ar ? 'المشتركون الفعليون' : 'With Active Sub', value: tenantStats.withSub, icon: <BadgeCheck className="w-5 h-5 text-amber-500" /> },
            ].map((s) => (
              <Card key={s.label} className="p-3.5 flex items-center justify-between">
                <div>
                  <p className="text-2xl font-black text-ui-text">{s.value}</p>
                  <p className="text-xs text-ui-subtle font-medium">{s.label}</p>
                </div>
                <div className="p-2.5 bg-ui-page rounded-xl border border-ui-border">{s.icon}</div>
              </Card>
            ))}
          </div>

          {loadingTenants ? (
            <div className="flex justify-center p-12">
              <Loader2 className="animate-spin w-8 h-8 text-brand-500" />
            </div>
          ) : tenants.length === 0 ? (
            <Card className="p-12 text-center text-ui-subtle">
              <Building2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-semibold">{ar ? 'لا توجد منظمات مسجلة بعد' : 'No tenants found'}</p>
            </Card>
          ) : (
            <div className="space-y-3">
              {tenants.map((t) => (
                <Card key={t.organization_id} className="overflow-hidden transition-all duration-150 hover:border-brand-500/30">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedOrg(expandedOrg === t.organization_id ? null : t.organization_id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpandedOrg(expandedOrg === t.organization_id ? null : t.organization_id);
                      }
                    }}
                    className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-3 text-start hover:bg-ui-page-alt/50 transition cursor-pointer"
                  >
                    <div className="flex items-center gap-3">
                      <div className="text-ui-subtle">
                        {expandedOrg === t.organization_id ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                      </div>
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600 font-bold">
                        {t.organization_name.slice(0, 1).toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-bold text-ui-text text-base">{t.organization_name}</p>
                          <span className="text-xs text-ui-subtle">(@{t.organization_slug})</span>
                        </div>
                        <p className="text-xs text-ui-subtle mt-0.5">
                          {ar ? 'تاريخ التسجيل:' : 'Registered:'} {formatDate(t.created_at, lang)}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                      <span className="text-xs text-ui-subtle font-medium">
                        {t.branch_count} {ar ? 'فروع' : 'branches'} &middot; {t.user_count} {ar ? 'مستخدم' : 'users'}
                      </span>
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          t.is_active ? 'bg-ui-success-soft text-ui-success' : 'bg-ui-danger-soft text-ui-danger'
                        }`}
                      >
                        {t.is_active ? (ar ? 'نشط' : 'Active') : (ar ? 'معطل' : 'Disabled')}
                      </span>
                      {t.has_active_subscription ? (
                        <span className="inline-flex items-center gap-1 text-xs text-ui-success font-medium bg-ui-success-soft px-2 py-0.5 rounded-md">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {ar ? 'اشتراك سارٍ' : 'Subscribed'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-ui-warning font-medium bg-ui-warning-soft px-2 py-0.5 rounded-md">
                          <Clock className="w-3.5 h-3.5" />
                          {ar ? 'بدون اشتراك' : 'No Sub'}
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleOrgStatus(t.organization_id, t.is_active);
                        }}
                      >
                        {t.is_active ? (ar ? 'تعطيل' : 'Disable') : (ar ? 'تفعيل' : 'Enable')}
                      </Button>
                    </div>
                  </div>

                  {expandedOrg === t.organization_id && (
                    <div className="border-t border-ui-border p-4 bg-ui-page/60 animate-fade-in space-y-3">
                      <p className="text-xs font-bold uppercase tracking-wider text-ui-subtle">
                        {ar ? 'الفريق وأعضاء المنظمة' : 'Organization Members & Branches'}
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {allUsers
                          .filter((u) => u.org_id === t.organization_id)
                          .map((u) => (
                            <div key={u.user_id} className="flex items-center gap-2.5 p-2.5 rounded-xl border border-ui-border bg-ui-surface text-sm">
                              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-ui-page text-xs font-bold text-ui-muted">
                                {(u.full_name || u.email).slice(0, 1).toUpperCase()}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="font-semibold text-ui-text truncate text-xs">{u.full_name || u.email}</p>
                                <p className="text-[11px] text-ui-subtle truncate">
                                  {u.role} {u.branch_name ? `(@${u.branch_name})` : ''}
                                </p>
                              </div>
                            </div>
                          ))}
                        {allUsers.filter((u) => u.org_id === t.organization_id).length === 0 && (
                          <p className="text-xs text-ui-subtle italic">{ar ? 'لا يوجد مستخدمون مرتبطون بشكل مباشر' : 'No direct users'}</p>
                        )}
                      </div>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* TAB 2: الاشتراكات والأسعار وبوابة InstaPay                      */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeTab === 'subscriptions' && (
        <div className="space-y-5 animate-fade-in">
          {/* Subtabs for Subscriptions */}
          <div className="flex flex-wrap gap-2 border-b border-ui-border pb-3">
            {([
              { key: 'plans' as const, label: ar ? 'باقات الأسعار والمميزات' : 'Subscription Plans', icon: <Layers className="w-4 h-4" /> },
              { key: 'gateway' as const, label: ar ? 'إعدادات بوابة InstaPay والتحويل' : 'InstaPay Gateway Settings', icon: <QrCode className="w-4 h-4" /> },
              { key: 'payments' as const, label: ar ? `مراجعة المدفوعات (${payments.filter((p) => p.status === 'pending').length})` : 'Payment Reviews', icon: <Receipt className="w-4 h-4" /> },
              { key: 'branch_subs' as const, label: ar ? 'اشتراكات الفروع والتجديد اليدوي' : 'Branch Subscriptions', icon: <Store className="w-4 h-4" /> },
            ] as const).map((st) => (
              <button
                key={st.key}
                onClick={() => setSubTab(st.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  subTab === st.key ? 'bg-ui-text text-ui-page' : 'bg-ui-page-alt text-ui-subtle hover:text-ui-text'
                }`}
              >
                {st.icon}
                <span>{st.label}</span>
              </button>
            ))}
          </div>

          {/* Subtab 1: Plans */}
          {subTab === 'plans' && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="text-base font-bold text-ui-text">{ar ? 'باقات الاشتراك المتاحة' : 'Active Subscription Plans'}</h3>
                  <p className="text-xs text-ui-subtle">{ar ? 'يمكنك تحديد الأسعار والمميزات المشمولة لكل باقة' : 'Set prices and features included in each tier'}</p>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditingPlan({
                      name_ar: '',
                      name_en: '',
                      code: 'plan_' + Date.now().toString().slice(-4),
                      monthly_price_egp: 299,
                      yearly_price_egp: 2990,
                      max_branches: 1,
                      max_users_per_branch: 3,
                      features: ['pos', 'inventory', 'reports'],
                      is_active: true,
                    });
                    setPlanModalOpen(true);
                  }}
                >
                  <Plus className="w-4 h-4" />
                  <span>{ar ? 'إضافة باقة جديدة' : 'Add New Plan'}</span>
                </Button>
              </div>

              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {plans.map((p) => (
                  <Card key={p.id} className="p-5 flex flex-col justify-between border-2 hover:border-brand-500/40 transition">
                    <div>
                      <div className="flex items-start justify-between">
                        <div>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-brand-600 bg-brand-500/10 px-2 py-0.5 rounded-md">
                            {p.code}
                          </span>
                          <h4 className="text-lg font-black text-ui-text mt-1">{ar ? p.name_ar : p.name_en || p.name_ar}</h4>
                        </div>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${p.is_active ? 'bg-ui-success-soft text-ui-success' : 'bg-ui-page-alt text-ui-subtle'}`}>
                          {p.is_active ? (ar ? 'نشط' : 'Active') : (ar ? 'غير متاح' : 'Inactive')}
                        </span>
                      </div>

                      <div className="my-4 p-3 bg-ui-page rounded-xl border border-ui-border">
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl font-black text-ui-text">{formatCurrency(p.monthly_price_egp, 'EGP', lang)}</span>
                          <span className="text-xs text-ui-subtle">/ {ar ? 'شهرياً' : 'month'}</span>
                        </div>
                        <div className="text-xs text-ui-subtle mt-1 flex justify-between">
                          <span>{ar ? 'الاشتراك السنوي:' : 'Yearly:'}</span>
                          <span className="font-semibold text-ui-text">{formatCurrency(p.yearly_price_egp, 'EGP', lang)}</span>
                        </div>
                      </div>

                      <div className="space-y-1.5 text-xs text-ui-subtle mb-4">
                        <div className="flex justify-between">
                          <span>{ar ? 'الحد الأقصى للفروع:' : 'Max Branches:'}</span>
                          <span className="font-bold text-ui-text">{p.max_branches}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{ar ? 'المستخدمين لكل فرع:' : 'Users per branch:'}</span>
                          <span className="font-bold text-ui-text">{p.max_users_per_branch}</span>
                        </div>
                      </div>

                      <div className="space-y-1 pt-3 border-t border-ui-border">
                        <p className="text-[11px] font-bold text-ui-muted mb-1.5">{ar ? 'المميزات المشمولة:' : 'Included Features:'}</p>
                        <div className="flex flex-wrap gap-1">
                          {normalizeFeatures(p.features).map((fKey) => {
                            const feat = AVAILABLE_FEATURES.find((af) => af.id === fKey);
                            return (
                              <span key={fKey} className="px-2 py-0.5 rounded-md bg-ui-page text-[10px] font-medium border border-ui-border text-ui-text">
                                {feat ? (ar ? feat.ar : feat.en) : fKey}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-4 mt-4 border-t border-ui-border">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingPlan({ ...p });
                          setPlanModalOpen(true);
                        }}
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                        <span>{ar ? 'تعديل' : 'Edit'}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-ui-danger hover:bg-ui-danger-soft"
                        onClick={() => {
                          setDeletingPlanId(p.id);
                          setDeletePlanConfirmOpen(true);
                        }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Subtab 2: Gateway Settings */}
          {subTab === 'gateway' && gatewaySettings && (
            <Card className="p-5 max-w-3xl space-y-4">
              <div>
                <h3 className="text-base font-bold text-ui-text">{ar ? 'إعدادات بوابة InstaPay ومعلومات التحويل' : 'InstaPay Gateway Settings'}</h3>
                <p className="text-xs text-ui-subtle">{ar ? 'هذه البيانات تظهر للفروع عند طلب الترقية أو تجديد الاشتراك' : 'These payment details will be shown to branches on renewal'}</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={ar ? 'معرّف أو رقم InstaPay (Username / Mobile)' : 'InstaPay ID / Mobile'}
                  value={gatewaySettings.instapay_id || ''}
                  onChange={(e) => setGatewaySettings({ ...gatewaySettings, instapay_id: e.target.value })}
                />
                <Input
                  label={ar ? 'اسم المستفيد / الحساب' : 'Beneficiary Name'}
                  value={gatewaySettings.beneficiary_name || ''}
                  onChange={(e) => setGatewaySettings({ ...gatewaySettings, beneficiary_name: e.target.value })}
                />
                <div className="sm:col-span-2">
                  <Input
                    label={ar ? 'رابط صورة رمز الاستجابة السريع (InstaPay QR Code URL)' : 'QR Code Image URL'}
                    value={gatewaySettings.qr_code_url || ''}
                    onChange={(e) => setGatewaySettings({ ...gatewaySettings, qr_code_url: e.target.value })}
                    placeholder="https://..."
                  />
                </div>
                <div className="sm:col-span-2">
                  <Textarea
                    label={ar ? 'تعليمات التحويل (بالعربية)' : 'Payment Instructions (AR)'}
                    value={gatewaySettings.instructions_ar || ''}
                    onChange={(e) => setGatewaySettings({ ...gatewaySettings, instructions_ar: e.target.value })}
                    rows={3}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Textarea
                    label={ar ? 'تعليمات التحويل (بالإنجليزية)' : 'Payment Instructions (EN)'}
                    value={gatewaySettings.instructions_en || ''}
                    onChange={(e) => setGatewaySettings({ ...gatewaySettings, instructions_en: e.target.value })}
                    rows={2}
                  />
                </div>
                <Input
                  label={ar ? 'فترة التجربة الافتراضية (أيام)' : 'Trial Period (Days)'}
                  type="number"
                  value={gatewaySettings.trial_days}
                  onChange={(e) => setGatewaySettings({ ...gatewaySettings, trial_days: Number(e.target.value) })}
                />
                <Input
                  label={ar ? 'فترة السماح بعد الانتهاء (أيام)' : 'Grace Period (Days)'}
                  type="number"
                  value={gatewaySettings.grace_days}
                  onChange={(e) => setGatewaySettings({ ...gatewaySettings, grace_days: Number(e.target.value) })}
                />
              </div>

              <div className="pt-3 border-t border-ui-border flex justify-end">
                <Button onClick={handleSaveGateway} disabled={savingGateway}>
                  {savingGateway && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>{ar ? 'حفظ إعدادات البوابة' : 'Save Gateway Settings'}</span>
                </Button>
              </div>
            </Card>
          )}

          {/* Subtab 3: Payment Reviews */}
          {subTab === 'payments' && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-base font-bold text-ui-text">{ar ? 'سجل طلبات الدفع وإيصالات InstaPay' : 'Payment Requests & Receipts'}</h3>
              </div>

              {payments.length === 0 ? (
                <Card className="p-12 text-center text-ui-subtle">
                  <Receipt className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p className="font-semibold">{ar ? 'لا توجد طلبات دفع مسجلة' : 'No payment requests found'}</p>
                </Card>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-ui-border text-start">
                        <th className="p-3 font-semibold text-ui-subtle">{ar ? 'الفرع' : 'Branch'}</th>
                        <th className="p-3 font-semibold text-ui-subtle">{ar ? 'المبلغ والمدة' : 'Amount / Period'}</th>
                        <th className="p-3 font-semibold text-ui-subtle">{ar ? 'الرقم المرجعي' : 'Reference'}</th>
                        <th className="p-3 font-semibold text-ui-subtle">{ar ? 'التاريخ' : 'Date'}</th>
                        <th className="p-3 font-semibold text-ui-subtle">{ar ? 'الحالة' : 'Status'}</th>
                        <th className="p-3 font-semibold text-ui-subtle">{ar ? 'الإجراء' : 'Actions'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((p) => {
                        const br = branches.find((b) => b.id === p.branch_id);
                        return (
                          <tr key={p.id} className="border-b border-ui-border/50 hover:bg-ui-page-alt/50">
                            <td className="p-3 font-bold text-ui-text">{br ? (ar ? br.name : br.name_en || br.name) : p.branch_id}</td>
                            <td className="p-3">
                              <span className="font-semibold text-ui-text">{formatCurrency(p.amount, 'EGP', lang)}</span>{' '}
                              <span className="text-xs text-ui-subtle">({p.billing_period === 'yearly' ? (ar ? 'سنوي' : 'Yearly') : (ar ? 'شهري' : 'Monthly')})</span>
                            </td>
                            <td className="p-3 font-mono text-xs text-ui-subtle">{p.reference || '-'}</td>
                            <td className="p-3 text-xs text-ui-subtle">{formatDate(p.submitted_at, lang)}</td>
                            <td className="p-3">
                              <span
                                className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                                  p.status === 'approved'
                                    ? 'bg-ui-success-soft text-ui-success'
                                    : p.status === 'rejected'
                                    ? 'bg-ui-danger-soft text-ui-danger'
                                    : 'bg-ui-warning-soft text-ui-warning'
                                }`}
                              >
                                {p.status === 'approved' ? (ar ? 'معتمد' : 'Approved') : p.status === 'rejected' ? (ar ? 'مرفوض' : 'Rejected') : (ar ? 'قيد المراجعة' : 'Pending')}
                              </span>
                            </td>
                            <td className="p-3 flex items-center gap-2">
                              {p.receipt_url && (
                                <Button size="sm" variant="outline" onClick={() => setViewReceiptModal(p.receipt_url)}>
                                  <ExternalLink className="w-3.5 h-3.5" />
                                  <span>{ar ? 'الإيصال' : 'Receipt'}</span>
                                </Button>
                              )}
                              {p.status === 'pending' && (
                                <>
                                  <Button
                                    size="sm"
                                    onClick={() => void reviewPayment(p.id, true)}
                                    disabled={reviewingId === p.id}
                                    className="bg-ui-success text-white hover:bg-ui-success/90"
                                  >
                                    {reviewingId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                                    <span>{ar ? 'اعتماد' : 'Approve'}</span>
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      setRejectPaymentId(p.id);
                                      setRejectModalOpen(true);
                                    }}
                                    className="text-ui-danger hover:bg-ui-danger-soft"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                    <span>{ar ? 'رفض' : 'Reject'}</span>
                                  </Button>
                                </>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Subtab 4: Branch Subscriptions Override */}
          {subTab === 'branch_subs' && (
            <div className="space-y-4">
              <h3 className="text-base font-bold text-ui-text">{ar ? 'حالة اشتراك الفروع والتعديل اليدوي' : 'Branch Subscriptions & Manual Overrides'}</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {branches.map((b) => {
                  const st = branchStatuses[b.id];
                  return (
                    <Card key={b.id} className="p-4 flex flex-col justify-between space-y-3">
                      <div>
                        <div className="flex justify-between items-start">
                          <h4 className="font-bold text-ui-text">{ar ? b.name : b.name_en || b.name}</h4>
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                              st?.status === 'active'
                                ? 'bg-ui-success-soft text-ui-success'
                                : st?.status === 'trialing' || st?.status === 'trial'
                                ? 'bg-ui-info-soft text-ui-info'
                                : 'bg-ui-danger-soft text-ui-danger'
                            }`}
                          >
                            {st?.status === 'active' ? (ar ? 'نشط' : 'Active') : (st?.status === 'trialing' || st?.status === 'trial') ? (ar ? 'تجريبي' : 'Trial') : (ar ? 'منتهي' : 'Expired')}
                          </span>
                        </div>
                        <p className="text-xs text-ui-subtle mt-1">
                          {ar ? 'الباقة:' : 'Plan:'} <span className="font-semibold text-ui-text">{st?.plan_name_ar || st?.plan_code || (ar ? 'غير محدد' : 'None')}</span>
                        </p>
                        <p className="text-xs text-ui-subtle">
                          {ar ? 'ينتهي في:' : 'Expires:'}{' '}
                          <span className="font-medium text-ui-text">{st?.current_period_ends_at ? formatDate(st.current_period_ends_at, lang) : '-'}</span>
                        </p>
                      </div>

                      <div className="pt-2 border-t border-ui-border">
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={() => {
                            setSelectedBranchForOverride(b);
                            setOverridePlanId(st?.plan_id || plans[0]?.id || '');
                            setOverrideStatus(st?.status || 'active');
                            setBranchOverrideModalOpen(true);
                          }}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                          <span>{ar ? 'تعديل أو تجديد الاشتراك' : 'Edit / Renew Subscription'}</span>
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* TAB 3: إعدادات المنشأة والمتجر المركزية (Global Settings)     */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeTab === 'general' && (
        <div className="space-y-5 max-w-4xl animate-fade-in">
          <Card className="p-6 space-y-6">
            <div>
              <h3 className="text-lg font-black text-ui-text">{ar ? 'بيانات المنشأة والمقر الرئيسي' : 'Master Enterprise Information'}</h3>
              <p className="text-xs text-ui-subtle">{ar ? 'الإعدادات العامة الافتراضية المطبقة على النظام بالكامل' : 'Global defaults applied across all modules and branches'}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={ar ? 'اسم المتجر / المنشأة' : 'Store / Company Name'}
                value={generalForm.store_name || ''}
                onChange={(e) => setGeneralForm({ ...generalForm, store_name: e.target.value })}
              />
              <Input
                label={ar ? 'رقم الهاتف الرئيسي' : 'Main Contact Phone'}
                value={generalForm.store_phone || ''}
                onChange={(e) => setGeneralForm({ ...generalForm, store_phone: e.target.value })}
              />
              <div className="sm:col-span-2">
                <Input
                  label={ar ? 'عنوان المقر الرئيسي' : 'Headquarters Address'}
                  value={generalForm.store_address || ''}
                  onChange={(e) => setGeneralForm({ ...generalForm, store_address: e.target.value })}
                />
              </div>
              <Input
                label={ar ? 'رابط شعار المنشأة (Image URL)' : 'Logo Image URL'}
                value={generalForm.logo_url || ''}
                onChange={(e) => setGeneralForm({ ...generalForm, logo_url: e.target.value })}
                placeholder="https://..."
              />
              <Input
                label={ar ? 'العملة الافتراضية' : 'Default Currency'}
                value={generalForm.currency || ''}
                onChange={(e) => setGeneralForm({ ...generalForm, currency: e.target.value })}
              />
            </div>

            <div className="pt-4 border-t border-ui-border">
              <h4 className="font-bold text-ui-text mb-3">{ar ? 'إعدادات نقطة البيع والضريبة' : 'POS & Tax Configuration'}</h4>
              <div className="grid gap-4 sm:grid-cols-3">
                <Select
                  label={ar ? 'طريقة الدفع الافتراضية' : 'Default Payment Method'}
                  value={generalForm.pos_default_payment_method || 'cash'}
                  onChange={(e) => setGeneralForm({ ...generalForm, pos_default_payment_method: e.target.value })}
                  options={[
                    { value: 'cash', label: ar ? 'نقدي (Cash)' : 'Cash' },
                    { value: 'card', label: ar ? 'بطاقة (Card)' : 'Card' },
                    { value: 'transfer', label: ar ? 'تحويل بنكي / InstaPay' : 'Transfer' },
                    { value: 'credit', label: ar ? 'آجل (Credit)' : 'Credit' },
                  ]}
                />
                <Input
                  label={ar ? 'نسبة الضريبة (%)' : 'Tax Rate (%)'}
                  type="number"
                  step="0.1"
                  value={generalForm.tax_rate ?? 14}
                  onChange={(e) => setGeneralForm({ ...generalForm, tax_rate: e.target.value })}
                />
                <Select
                  label={ar ? 'تفعيل الضريبة' : 'Enable Tax'}
                  value={generalForm.tax_enabled ? '1' : '0'}
                  onChange={(e) => setGeneralForm({ ...generalForm, tax_enabled: e.target.value })}
                  options={[
                    { value: '1', label: ar ? 'نعم (مفعلة)' : 'Enabled' },
                    { value: '0', label: ar ? 'لا (غير مفعلة)' : 'Disabled' },
                  ]}
                />
              </div>
            </div>

            <div className="pt-4 border-t border-ui-border">
              <h4 className="font-bold text-ui-text mb-3">{ar ? 'إعدادات الإيصال والطباعة الحرارية' : 'Thermal Receipt Defaults'}</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <Select
                  label={ar ? 'عرض الورق الحراري' : 'Paper Width'}
                  value={String(generalForm.receipt_width_mm || '80')}
                  onChange={(e) => setGeneralForm({ ...generalForm, receipt_width_mm: Number(e.target.value) })}
                  options={[
                    { value: '80', label: '80 مم (Standard Thermal)' },
                    { value: '58', label: '58 مم (Small Thermal)' },
                  ]}
                />
                <Input
                  label={ar ? 'عدد النسخ المطبوعة' : 'Copies'}
                  type="number"
                  min={1}
                  max={5}
                  value={generalForm.receipt_copies || 1}
                  onChange={(e) => setGeneralForm({ ...generalForm, receipt_copies: Number(e.target.value) })}
                />
                <div className="sm:col-span-2">
                  <Textarea
                    label={ar ? 'ترويسة الإيصال (Header Text)' : 'Receipt Header'}
                    value={generalForm.receipt_header || ''}
                    onChange={(e) => setGeneralForm({ ...generalForm, receipt_header: e.target.value })}
                    rows={2}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Textarea
                    label={ar ? 'تذييل الإيصال (Footer Text)' : 'Receipt Footer'}
                    value={generalForm.receipt_footer || ''}
                    onChange={(e) => setGeneralForm({ ...generalForm, receipt_footer: e.target.value })}
                    rows={2}
                  />
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-ui-border flex justify-end">
              <Button onClick={handleSaveGeneral} disabled={savingGeneral} size="lg">
                {savingGeneral ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                <span>{ar ? 'حفظ إعدادات المنشأة' : 'Save Master Settings'}</span>
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* TAB 4: تخصيصات الفروع والبيانات التجريبية                       */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeTab === 'branches_override' && (
        <div className="space-y-6 max-w-4xl animate-fade-in">
          <Card className="p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-ui-border pb-3">
              <div>
                <h3 className="text-base font-bold text-ui-text">{ar ? 'تخصيص إعدادات فرع محدد' : 'Branch Specific Customizations'}</h3>
                <p className="text-xs text-ui-subtle">{ar ? 'تجاوز الإعدادات العامة لفرع معين (الترويسة، الضريبة، العملة، التنبيهات)' : 'Override global store settings for a specific branch'}</p>
              </div>
              <div className="w-64">
                <Select
                  value={targetBranchId}
                  onChange={(e) => setTargetBranchId(e.target.value)}
                  options={branches.map((b) => ({ value: b.id, label: ar ? b.name : b.name_en || b.name }))}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={ar ? 'نسبة الضريبة الخاصة بالفرع (%)' : 'Branch Specific Tax (%)'}
                type="number"
                step="0.1"
                placeholder={ar ? 'افتراضي من الإعدادات العامة' : 'Inherited from global'}
                value={branchForm.tax_rate ?? ''}
                onChange={(e) => setBranchForm({ ...branchForm, tax_rate: e.target.value })}
              />
              <Input
                label={ar ? 'العملة الخاصة بالفرع' : 'Branch Currency'}
                placeholder={ar ? 'افتراضي من الإعدادات العامة' : 'Inherited from global'}
                value={branchForm.currency || ''}
                onChange={(e) => setBranchForm({ ...branchForm, currency: e.target.value })}
              />
              <div className="sm:col-span-2">
                <Input
                  label={ar ? 'شعار خاص بهذا الفرع' : 'Branch Logo URL'}
                  placeholder="https://..."
                  value={branchForm.logo_url || ''}
                  onChange={(e) => setBranchForm({ ...branchForm, logo_url: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <Textarea
                  label={ar ? 'ترويسة إيصال هذا الفرع' : 'Branch Receipt Header'}
                  rows={2}
                  value={branchForm.receipt_header || ''}
                  onChange={(e) => setBranchForm({ ...branchForm, receipt_header: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <Textarea
                  label={ar ? 'تذييل إيصال هذا الفرع' : 'Branch Receipt Footer'}
                  rows={2}
                  value={branchForm.receipt_footer || ''}
                  onChange={(e) => setBranchForm({ ...branchForm, receipt_footer: e.target.value })}
                />
              </div>
            </div>

            <div className="pt-4 border-t border-ui-border flex items-center justify-between">
              <Button variant="outline" onClick={handleResetBranchCustom} disabled={savingBranchCustom}>
                <span>{ar ? 'استعادة الافتراضي' : 'Reset to Global'}</span>
              </Button>
              <Button onClick={handleSaveBranchCustom} disabled={savingBranchCustom}>
                {savingBranchCustom && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{ar ? 'حفظ تخصيصات الفرع' : 'Save Branch Customization'}</span>
              </Button>
            </div>
          </Card>

          {/* Demo Data Section */}
          <Card className="p-5 border-dashed border-2 border-brand-500/30 space-y-3">
            <div className="flex items-center gap-2 text-brand-600 dark:text-brand-400">
              <Zap className="w-5 h-5" />
              <h4 className="font-bold">{ar ? 'إدارة البيانات التجريبية (Demo Data)' : 'Demo Data Generator'}</h4>
            </div>
            <p className="text-xs text-ui-subtle">
              {ar
                ? 'يمكنك توليد بيانات تجريبية متكاملة (أقسام، منتجات، فواتير، موردين) للاختبار والعرض التوضيحي، أو مسحها في أي وقت بنقرة واحدة.'
                : 'Seed or wipe comprehensive demo fixtures for testing and showroom purposes.'}
            </p>

            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="outline" onClick={handleSeedDemo} disabled={demoBusy}>
                {demoBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                <span>{ar ? 'توليد بيانات تجريبية للفرع الحالي' : 'Seed Demo Data'}</span>
              </Button>
              <Button
                variant="outline"
                className="text-ui-danger hover:bg-ui-danger-soft"
                onClick={() => setDemoConfirmOpen(true)}
                disabled={demoBusy}
              >
                <Trash2 className="w-4 h-4" />
                <span>{ar ? 'حذف كافة البيانات التجريبية' : 'Wipe Demo Data'}</span>
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* TAB 5: مصفوفة الأدوار والصلاحيات (RBAC Matrix)                  */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeTab === 'roles' && (
        <div className="space-y-4 animate-fade-in">
          <RolesTab />
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* TAB 6: المستخدمون وسجل التدقيق (Users & Audit)                 */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeTab === 'users_audit' && (
        <div className="space-y-5 animate-fade-in">
          <div className="flex gap-2 border-b border-ui-border pb-3">
            <button
              onClick={() => setUserAuditSubTab('users')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                userAuditSubTab === 'users' ? 'bg-ui-text text-ui-page' : 'bg-ui-page-alt text-ui-subtle'
              }`}
            >
              <Users className="w-4 h-4" />
              <span>{ar ? `المستخدمون (${allUsers.length})` : 'All Users'}</span>
            </button>
            <button
              onClick={() => setUserAuditSubTab('audit')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                userAuditSubTab === 'audit' ? 'bg-ui-text text-ui-page' : 'bg-ui-page-alt text-ui-subtle'
              }`}
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>{ar ? 'سجل العمليات والتدقيق (Audit Log)' : 'Audit Trail'}</span>
            </button>
          </div>

          {userAuditSubTab === 'users' && (
            <div className="space-y-4">
              <DesignSearch
                value={userSearch}
                onChange={setUserSearch}
                placeholder={ar ? 'بحث بالاسم، البريد أو الفرع...' : 'Search users...'}
                label={ar ? 'بحث' : 'Search'}
                testId="user-sa-search"
              />
              <div className="overflow-x-auto rounded-xl border border-ui-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ui-border bg-ui-page-alt text-start">
                      <th className="p-3 font-semibold text-ui-subtle">{ar ? 'الاسم' : 'Name'}</th>
                      <th className="p-3 font-semibold text-ui-subtle">{ar ? 'البريد الإلكتروني' : 'Email'}</th>
                      <th className="p-3 font-semibold text-ui-subtle">{ar ? 'الدور' : 'Role'}</th>
                      <th className="p-3 font-semibold text-ui-subtle">{ar ? 'المنظمة' : 'Tenant'}</th>
                      <th className="p-3 font-semibold text-ui-subtle">{ar ? 'الفرع' : 'Branch'}</th>
                      <th className="p-3 font-semibold text-ui-subtle">{ar ? 'الحالة' : 'Status'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allUsers
                      .filter(
                        (u) =>
                          !userSearch ||
                          u.email.toLowerCase().includes(userSearch.toLowerCase()) ||
                          u.full_name.toLowerCase().includes(userSearch.toLowerCase()) ||
                          (u.branch_name && u.branch_name.toLowerCase().includes(userSearch.toLowerCase()))
                      )
                      .map((u) => (
                        <tr key={u.user_id} className="border-b border-ui-border/50 hover:bg-ui-page-alt/50">
                          <td className="p-3 font-bold text-ui-text">{u.full_name || '-'}</td>
                          <td className="p-3 text-ui-subtle font-mono text-xs">{u.email}</td>
                          <td className="p-3">
                            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-brand-500/10 text-brand-600">
                              {u.role}
                            </span>
                          </td>
                          <td className="p-3 text-ui-subtle text-xs">{u.org_name || '-'}</td>
                          <td className="p-3 text-ui-subtle text-xs">{u.branch_name || '-'}</td>
                          <td className="p-3">
                            <span
                              className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                                u.is_active ? 'bg-ui-success-soft text-ui-success' : 'bg-ui-danger-soft text-ui-danger'
                              }`}
                            >
                              {u.is_active ? (ar ? 'نشط' : 'Active') : (ar ? 'معطل' : 'Disabled')}
                            </span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {userAuditSubTab === 'audit' && (
            <div className="space-y-4">
              <DesignSearch
                value={auditSearch}
                onChange={setAuditSearch}
                placeholder={ar ? 'بحث بالإجراء أو الكيان أو البريد...' : 'Search audit log...'}
                label={ar ? 'بحث' : 'Search'}
                testId="audit-sa-search"
              />
              <div className="overflow-x-auto rounded-xl border border-ui-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ui-border bg-ui-page-alt text-start">
                      <th className="p-3 font-semibold text-ui-subtle">{ar ? 'التاريخ والوقت' : 'Timestamp'}</th>
                      <th className="p-3 font-semibold text-ui-subtle">{ar ? 'المستخدم' : 'User'}</th>
                      <th className="p-3 font-semibold text-ui-subtle">{ar ? 'الإجراء' : 'Action'}</th>
                      <th className="p-3 font-semibold text-ui-subtle">{ar ? 'الكيان' : 'Entity'}</th>
                      <th className="p-3 font-semibold text-ui-subtle">{ar ? 'التفاصيل' : 'Details'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs
                      .filter(
                        (a) =>
                          !auditSearch ||
                          a.action.toLowerCase().includes(auditSearch.toLowerCase()) ||
                          a.entity.toLowerCase().includes(auditSearch.toLowerCase()) ||
                          (a.user_email && a.user_email.toLowerCase().includes(auditSearch.toLowerCase()))
                      )
                      .map((a) => (
                        <tr key={a.id} className="border-b border-ui-border/50 hover:bg-ui-page-alt/50">
                          <td className="p-3 text-xs text-ui-subtle">{formatDateTime(a.created_at, lang)}</td>
                          <td className="p-3 text-xs font-semibold text-ui-text">{a.user_email || '-'}</td>
                          <td className="p-3">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[11px] font-bold uppercase ${
                                a.action === 'create'
                                  ? 'bg-ui-success-soft text-ui-success'
                                  : a.action === 'update'
                                  ? 'bg-ui-info-soft text-ui-info'
                                  : a.action === 'delete'
                                  ? 'bg-ui-danger-soft text-ui-danger'
                                  : 'bg-ui-page-alt text-ui-muted'
                              }`}
                            >
                              {a.action}
                            </span>
                          </td>
                          <td className="p-3 text-xs font-mono">{a.entity}</td>
                          <td className="p-3 text-xs text-ui-subtle max-w-xs truncate">{JSON.stringify(a.details || {})}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* TAB 7: صحة وتشخيص النظام (Diagnostics & Health)                 */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeTab === 'health' && (
        <div className="space-y-4 max-w-3xl animate-fade-in">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-ui-text">{ar ? 'فحص جاهزية النظام والاتصال بقاعدة البيانات' : 'System Connectivity Diagnostics'}</h3>
              <p className="text-xs text-ui-subtle">{ar ? 'تحقق حي من جداول وقنوات النظام' : 'Real-time sanity checks on Supabase tables and auth'}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void runHealthChecks()} disabled={healthRunning}>
              <RefreshCw className={`w-4 h-4 ${healthRunning ? 'animate-spin' : ''}`} />
              <span>{ar ? 'بدء الفحص الآن' : 'Run Diagnostics'}</span>
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {healthResults.map((h) => (
              <Card key={h.key} className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-bold text-sm text-ui-text">{h.label}</p>
                  <p className="text-xs text-ui-subtle mt-0.5">{h.detail}</p>
                </div>
                <div>
                  {h.status === 'ok' ? (
                    <CheckCircle2 className="w-6 h-6 text-ui-success" />
                  ) : h.status === 'error' ? (
                    <XCircle className="w-6 h-6 text-ui-danger" />
                  ) : (
                    <Loader2 className="w-6 h-6 text-brand-500 animate-spin" />
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* Modals & Dialogs                                              */}
      {/* ───────────────────────────────────────────────────────────── */}

      {/* 1. Plan Editor Modal */}
      {planModalOpen && editingPlan && (
        <Modal
          isOpen={planModalOpen}
          onClose={() => setPlanModalOpen(false)}
          title={editingPlan.id ? (ar ? 'تعديل باقة الاشتراك' : 'Edit Plan') : (ar ? 'إضافة باقة جديدة' : 'New Plan')}
        >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label={ar ? 'اسم الباقة (عربي)' : 'Name (Arabic)'}
                value={editingPlan.name_ar || ''}
                onChange={(e) => setEditingPlan({ ...editingPlan, name_ar: e.target.value })}
              />
              <Input
                label={ar ? 'اسم الباقة (إنجليزي)' : 'Name (English)'}
                value={editingPlan.name_en || ''}
                onChange={(e) => setEditingPlan({ ...editingPlan, name_en: e.target.value })}
              />
              <Input
                label={ar ? 'السعر الشهري (ج.م)' : 'Monthly Price (EGP)'}
                type="number"
                value={editingPlan.monthly_price_egp ?? 0}
                onChange={(e) => setEditingPlan({ ...editingPlan, monthly_price_egp: Number(e.target.value) })}
              />
              <Input
                label={ar ? 'السعر السنوي (ج.م)' : 'Yearly Price (EGP)'}
                type="number"
                value={editingPlan.yearly_price_egp ?? 0}
                onChange={(e) => setEditingPlan({ ...editingPlan, yearly_price_egp: Number(e.target.value) })}
              />
              <Input
                label={ar ? 'الحد الأقصى للفروع' : 'Max Branches'}
                type="number"
                value={editingPlan.max_branches ?? 1}
                onChange={(e) => setEditingPlan({ ...editingPlan, max_branches: Number(e.target.value) })}
              />
              <Input
                label={ar ? 'المستخدمين لكل فرع' : 'Users per Branch'}
                type="number"
                value={editingPlan.max_users_per_branch ?? 3}
                onChange={(e) => setEditingPlan({ ...editingPlan, max_users_per_branch: Number(e.target.value) })}
              />
            </div>

            <div>
              <p className="text-xs font-bold text-ui-text mb-2">{ar ? 'المميزات المشمولة في هذه الباقة:' : 'Included Features:'}</p>
              <div className="grid gap-2 sm:grid-cols-2 max-h-48 overflow-y-auto p-2 border border-ui-border rounded-xl">
                {AVAILABLE_FEATURES.map((feat) => {
                  const norm = normalizeFeatures(editingPlan.features);
                  const isChecked = norm.includes(feat.id);
                  return (
                    <label key={feat.id} className="flex items-center gap-2 p-1.5 hover:bg-ui-page rounded-lg cursor-pointer text-xs">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          const next = e.target.checked ? [...norm, feat.id] : norm.filter((x) => x !== feat.id);
                          setEditingPlan({ ...editingPlan, features: next });
                        }}
                        className="rounded text-brand-600 focus:ring-brand-500"
                      />
                      <span>{ar ? feat.ar : feat.en}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-ui-border">
              <Button variant="outline" onClick={() => setPlanModalOpen(false)}>
                {ar ? 'إلغاء' : 'Cancel'}
              </Button>
              <Button onClick={handleSavePlan} disabled={savingPlan}>
                {savingPlan && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{ar ? 'حفظ الباقة' : 'Save Plan'}</span>
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* 2. Delete Plan Dialog */}
      <ConfirmDialog
        isOpen={deletePlanConfirmOpen}
        onClose={() => setDeletePlanConfirmOpen(false)}
        onConfirm={handleDeletePlan}
        title={ar ? 'تأكيد حذف الباقة' : 'Delete Plan'}
        message={ar ? 'هل أنت متأكد من رغبتك في حذف هذه الباقة نهائياً؟' : 'Are you sure you want to delete this subscription plan?'}
      />

      {/* 3. Delete Demo Data Dialog */}
      <ConfirmDialog
        isOpen={demoConfirmOpen}
        onClose={() => setDemoConfirmOpen(false)}
        onConfirm={handleDeleteDemo}
        title={ar ? 'تأكيد مسح البيانات التجريبية' : 'Wipe Demo Data'}
        message={ar ? 'سيتم حذف جميع المنتجات والمبيعات التجريبية المرتبطة بهذا الفرع. هل تريد الاستمرار؟' : 'All test demo fixtures will be erased for this branch. Continue?'}
      />

      {/* 4. Reject Payment Modal */}
      {rejectModalOpen && (
        <Modal isOpen={rejectModalOpen} onClose={() => setRejectModalOpen(false)} title={ar ? 'سبب رفض التحويل' : 'Reject Payment'}>
          <div className="space-y-4">
            <Input
              label={ar ? 'سبب الرفض' : 'Rejection Reason'}
              placeholder={ar ? 'مثال: رقم الإشعار غير صحيح أو المبلغ غير مكتمل' : 'e.g. Invalid reference'}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRejectModalOpen(false)}>
                {ar ? 'إلغاء' : 'Cancel'}
              </Button>
              <Button
                className="bg-ui-danger text-white hover:bg-ui-danger/90"
                onClick={() => rejectPaymentId && reviewPayment(rejectPaymentId, false, rejectReason)}
              >
                {ar ? 'تأكيد الرفض' : 'Confirm Reject'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* 5. View Receipt Modal */}
      {viewReceiptModal && (
        <Modal isOpen={!!viewReceiptModal} onClose={() => setViewReceiptModal(null)} title={ar ? 'إيصال التحويل' : 'Payment Receipt'}>
          <div className="p-2 flex justify-center">
            <img src={viewReceiptModal} alt="Receipt" className="max-h-[70vh] rounded-xl object-contain shadow-lg" />
          </div>
        </Modal>
      )}

      {/* 6. Manual Branch Override Modal */}
      {branchOverrideModalOpen && selectedBranchForOverride && (
        <Modal
          isOpen={branchOverrideModalOpen}
          onClose={() => setBranchOverrideModalOpen(false)}
          title={ar ? `تعديل اشتراك: ${selectedBranchForOverride.name}` : `Override Subscription: ${selectedBranchForOverride.name}`}
        >
          <div className="space-y-4">
            <Select
              label={ar ? 'الباقة المخصصة' : 'Select Plan'}
              value={overridePlanId}
              onChange={(e) => setOverridePlanId(e.target.value)}
              options={plans.map((p) => ({ value: p.id, label: `${ar ? p.name_ar : p.name_en || p.name_ar} (${p.monthly_price_egp} EGP)` }))}
            />
            <Select
              label={ar ? 'حالة الاشتراك' : 'Status'}
              value={overrideStatus}
              onChange={(e) => setOverrideStatus(e.target.value)}
              options={[
                { value: 'active', label: ar ? 'نشط (Active)' : 'Active' },
                { value: 'trialing', label: ar ? 'فترة تجريبية (Trialing)' : 'Trialing' },
                { value: 'past_due', label: ar ? 'مستحق الدفع (Past Due)' : 'Past Due' },
                { value: 'canceled', label: ar ? 'ملغى (Canceled)' : 'Canceled' },
              ]}
            />
            <Input
              label={ar ? 'تمديد الأيام الإضافية من الآن' : 'Days to extend'}
              type="number"
              value={overrideDaysToAdd}
              onChange={(e) => setOverrideDaysToAdd(Number(e.target.value))}
            />
            <div className="flex justify-end gap-2 pt-3 border-t border-ui-border">
              <Button variant="outline" onClick={() => setBranchOverrideModalOpen(false)}>
                {ar ? 'إلغاء' : 'Cancel'}
              </Button>
              <Button onClick={handleSaveBranchOverride} disabled={savingBranchOverride}>
                {savingBranchOverride && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{ar ? 'حفظ وتفعيل' : 'Apply & Activate'}</span>
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </DesignSurface>
  );
}
