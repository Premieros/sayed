-- ============================================================================
-- 20260831: Remove the Subscription / Billing system entirely.
-- ----------------------------------------------------------------------------
-- The app no longer has Subscriptions, Plans, Billing, InstaPay payments, trial
-- windows, or feature/plan gating (frontend already removed). This migration
-- removes the database surface so no dead code / dead tables / RLS remain:
--
--   1. Drop the order-insert subscription guard (trigger + function) so order
--      creation is never blocked by a subscription.
--   2. Neutralize subscription_status()/subscription_expired() so any leftover
--      call site (e.g. the historical process_sale gate) can NEVER block a
--      sale. They are re-created as safe no-ops that no longer read the dropped
--      tables. This satisfies "no usage restrictions due to subscription".
--   3. Drop every subscription/billing/plan/feature table and RPC + RLS.
--   4. Re-create register_tenant WITHOUT inserting a trial subscription row.
--   5. Re-create get_super_admin_tenant_stats WITHOUT the branch_subscriptions
--      join (multi-tenant stats remain; the subscription flag becomes false).
--
-- Multi-tenant isolation (organizations, branches, RLS, user ownership) is
-- intentionally preserved.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Remove the order subscription guard (blocks order creates when expired)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_guard_order_subscription ON public.orders;
DROP FUNCTION IF EXISTS public.guard_order_subscription();

-- ---------------------------------------------------------------------------
-- 2. Neutralize subscription status helpers (never block sales/orders)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.subscription_status(p_branch_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'branch_id', p_branch_id,
    'status', 'unlimited',
    'plan_id', NULL,
    'expired', false,
    'trial_ends_at', NULL,
    'current_period_ends_at', NULL,
    'cancelled_at', NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.subscription_expired(p_branch_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT false;
$$;

GRANT EXECUTE ON FUNCTION public.subscription_status(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.subscription_expired(uuid) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Drop subscription / billing / plan / feature-gating tables + RLS
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.subscription_events;
DROP TABLE IF EXISTS public.branch_feature_overrides;
DROP TABLE IF EXISTS public.subscriptions;
DROP TABLE IF EXISTS public.plan_features;
DROP TABLE IF EXISTS public.features;
DROP TABLE IF EXISTS public.plan_prices;
DROP TABLE IF EXISTS public.plans;

DROP TABLE IF EXISTS public.subscription_settings;
DROP TABLE IF EXISTS public.subscription_payments;
DROP TABLE IF EXISTS public.branch_subscriptions;
DROP TABLE IF EXISTS public.subscription_plans;

-- ---------------------------------------------------------------------------
-- 4. Drop subscription / billing / feature-gating RPCs
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.activate_subscription(uuid, text, text, boolean);
DROP FUNCTION IF EXISTS public.submit_instapay_payment(uuid, text, numeric, text, text, text);
DROP FUNCTION IF EXISTS public.review_instapay_payment(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.subscription_settings_get();
DROP FUNCTION IF EXISTS public.subscription_settings_update(text, text, text, text, text, integer, integer, integer, boolean, boolean, boolean);

DROP FUNCTION IF EXISTS public.subscription_is_active(uuid);
DROP FUNCTION IF EXISTS public.resolve_feature_access(uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS public.get_feature_access(text, uuid);
DROP FUNCTION IF EXISTS public.can_access_feature(text, uuid);
DROP FUNCTION IF EXISTS public.can_create_branch(uuid);
DROP FUNCTION IF EXISTS public.can_create_user(uuid);
DROP FUNCTION IF EXISTS public.get_tenant_subscription_details(uuid);
DROP FUNCTION IF EXISTS public.super_admin_change_subscription(uuid, uuid, text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.super_admin_set_branch_override(uuid, uuid, text, boolean, integer, text);
DROP FUNCTION IF EXISTS public.super_admin_remove_branch_override(uuid, text);

-- ---------------------------------------------------------------------------
-- 5. register_tenant WITHOUT the trial-subscription row (keeps multi-tenant)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_tenant(
  p_store_name text,
  p_owner_name text,
  p_email text,
  p_password text,
  p_store_name_en text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_currency text DEFAULT 'EGP'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_branch_id uuid;
  v_warehouse_id uuid;
  v_user_id uuid;
  v_email text;
  v_global_tax numeric(5,2);
  v_global_tax_enabled boolean;
  v_global_currency text;
  v_res jsonb;
  v_slug text;
  v_allowed boolean;
BEGIN
  -- Global gate: Allow New User Creation (must be ON for public registration)
  SELECT COALESCE((config #> '{user_registration,allow_new_user_creation}')::boolean, true)
    INTO v_allowed
  FROM public.system_settings WHERE id = 1;

  IF NOT COALESCE(v_allowed, true) THEN
    IF NOT public.is_super_admin_db() THEN
      RETURN jsonb_build_object('success', false, 'error', 'REGISTRATION_DISABLED',
        'detail', 'New user creation has been disabled by Super Admin.');
    END IF;
  END IF;

  v_email := lower(btrim(p_email));

  IF v_email = '' OR v_email !~ '@' OR v_email !~ '\.' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_EMAIL');
  END IF;
  IF p_password IS NULL OR length(p_password) < 6 THEN
    RETURN jsonb_build_object('success', false, 'error', 'WEAK_PASSWORD');
  END IF;
  IF btrim(coalesce(p_store_name, '')) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'MISSING_STORE_NAME');
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE email = v_email)
     OR EXISTS (SELECT 1 FROM public.users WHERE email = v_email) THEN
    RETURN jsonb_build_object('success', false, 'error', 'EMAIL_TAKEN');
  END IF;

  v_org_id := gen_random_uuid();
  v_slug := 'org-' || replace(v_org_id::text, '-', '');

  INSERT INTO public.organizations (id, name, slug, is_active)
  VALUES (v_org_id, p_store_name, v_slug, true);

  INSERT INTO public.branches (name, name_en, address, phone, is_active, organization_id)
  VALUES (p_store_name, p_store_name_en, p_address, p_phone, true, v_org_id)
  RETURNING id INTO v_branch_id;

  INSERT INTO public.warehouses (name, branch_id, is_active)
  VALUES (p_store_name || ' - Main', v_branch_id, true)
  RETURNING id INTO v_warehouse_id;

  SELECT COALESCE(tax_rate, 15), COALESCE(tax_enabled, true), COALESCE(currency, 'EGP')
  INTO v_global_tax, v_global_tax_enabled, v_global_currency
  FROM public.settings ORDER BY id LIMIT 1;

  INSERT INTO public.branch_settings (branch_id, tax_rate, tax_enabled, currency, low_stock_threshold)
  VALUES (
    v_branch_id,
    v_global_tax,
    v_global_tax_enabled,
    COALESCE(NULLIF(btrim(p_currency), ''), v_global_currency),
    10
  );

  PERFORM set_config('app.register_branch', 'on', true);
  v_res := public.create_user(
    v_email,
    p_password,
    p_owner_name,
    'owner',
    v_branch_id,
    true,
    NULL
  );
  PERFORM set_config('app.register_branch', 'off', true);

  IF NOT COALESCE((v_res->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'USER_CREATE_FAILED: %', COALESCE(v_res->>'error', 'UNKNOWN');
  END IF;

  v_user_id := (v_res->>'user_id')::uuid;

  INSERT INTO public.organization_members (
    organization_id, user_id, membership_role, is_active
  ) VALUES (
    v_org_id, v_user_id, 'owner', true
  );

  RETURN jsonb_build_object(
    'success', true,
    'organization_id', v_org_id,
    'branch_id', v_branch_id,
    'warehouse_id', v_warehouse_id,
    'user_id', v_user_id,
    'membership_role', 'owner'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', 'TENANT_REGISTRATION_FAILED', 'detail', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_tenant(text, text, text, text, text, text, text, text)
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. get_super_admin_tenant_stats WITHOUT the subscription join
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_super_admin_tenant_stats()
RETURNS TABLE (
  organization_id   uuid,
  organization_name text,
  organization_slug text,
  is_active         boolean,
  created_at        timestamptz,
  branch_count      bigint,
  user_count        bigint,
  total_branches    bigint,
  active_branches   bigint,
  has_active_subscription boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.id,
    o.name,
    o.slug,
    o.is_active,
    o.created_at,
    (SELECT count(*) FROM public.branches b WHERE b.organization_id = o.id),
    (SELECT count(*) FROM public.organization_members om WHERE om.organization_id = o.id AND om.is_active = true),
    (SELECT count(*) FROM public.branches b WHERE b.organization_id = o.id),
    (SELECT count(*) FROM public.branches b WHERE b.organization_id = o.id AND b.is_active = true),
    false
  FROM public.organizations o
  ORDER BY o.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_super_admin_tenant_stats() TO authenticated;

NOTIFY pgrst, 'reload schema';
