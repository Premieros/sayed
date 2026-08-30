-- 20260830000000 System Controls: Allow New User Creation (Super Admin)
--
-- Replaces the removed subscription-based usage limits with a single global,
-- database-enforced switch controlled ONLY by Super Admin:
--   system_settings.config->'user_registration'->'allow_new_user_creation' (boolean, default true)
--
-- Server-side enforcement (never frontend-only):
--   * set_system_setting / set_system_setting_value  -> super_admin only
--   * can_create_new_user() -> authoritative gate for new-user creation
--   * register_tenant       -> blocks public self-registration when OFF
--   * create_user           -> blocks non-super-admin user creation when OFF
-- Every change is recorded in audit_log.

-- ---------------------------------------------------------------------------
-- Helper: reject unless the current caller is a real super_admin
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_super_admin_db()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE users.id = auth.uid()
      AND users.is_active
      AND users.role = 'super_admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- Read a dotted-path value from system_settings.config (single-row, id=1)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_system_setting(p_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (config #> string_to_array(p_key, '.'))::jsonb,
    'null'::jsonb
  )
  FROM public.system_settings
  WHERE id = 1;
$$;

-- ---------------------------------------------------------------------------
-- Read facade used by the app: returns {key, value} (whole config when NULL)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_system_settings(p_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_cfg jsonb;
  v_val jsonb;
BEGIN
  SELECT config INTO v_cfg FROM public.system_settings WHERE id = 1;
  IF v_cfg IS NULL THEN
    v_cfg := '{}'::jsonb;
  END IF;
  IF p_key IS NULL OR btrim(p_key) = '' THEN
    RETURN jsonb_build_object('key', 'system_settings', 'value', v_cfg);
  END IF;
  v_val := (v_cfg #> string_to_array(p_key, '.'))::jsonb;
  RETURN jsonb_build_object('key', p_key, 'value', v_val);
END;
$$;

-- ---------------------------------------------------------------------------
-- Write a dotted-path value (Super Admin only) with audit trail.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_system_setting_value(p_key text, p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg jsonb;
  v_old jsonb;
  v_new jsonb;
  v_user_id uuid;
  v_user_email text;
BEGIN
  IF NOT public.is_super_admin_db() THEN
    RETURN jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED',
      'detail', 'Only Super Admin can change system controls');
  END IF;

  SELECT config INTO v_cfg FROM public.system_settings WHERE id = 1 FOR UPDATE;
  IF v_cfg IS NULL THEN
    v_cfg := '{}'::jsonb;
  END IF;

  SELECT id, email INTO v_user_id, v_user_email FROM public.users WHERE id = auth.uid();

  v_old := (v_cfg #> string_to_array(p_key, '.'))::jsonb;
  v_new := jsonb_set(v_cfg, string_to_array(p_key, '.'), p_value, true);

  INSERT INTO public.system_settings (id, config, updated_by, updated_at)
  VALUES (1, v_new, v_user_id, now())
  ON CONFLICT (id) DO UPDATE
    SET config = excluded.config,
        updated_by = excluded.updated_by,
        updated_at = now();

  INSERT INTO public.audit_log (
    user_id, user_email, action, entity, entity_id, details, created_at
  ) VALUES (
    v_user_id,
    v_user_email,
    'update',
    'system_settings',
    NULL,
    jsonb_build_object('key', p_key, 'old_value', v_old, 'new_value', p_value),
    now()
  );

  RETURN jsonb_build_object('success', true, 'key', p_key, 'value', p_value);
END;
$$;

-- Friendly text wrapper
CREATE OR REPLACE FUNCTION public.set_system_setting(p_key text, p_value text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_json jsonb;
BEGIN
  IF p_value IS NULL OR lower(btrim(p_value)) IN ('null', '') THEN
    v_json := 'null'::jsonb;
  ELSIF lower(btrim(p_value)) IN ('true', 'false') THEN
    v_json := (lower(btrim(p_value)) = 'true')::text::jsonb;
  ELSIF p_value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
    v_json := to_jsonb(p_value::numeric);
  ELSE
    v_json := to_jsonb(p_value);
  END IF;
  RETURN public.set_system_setting_value(p_key, v_json);
END;
$$;

-- Boolean convenience
CREATE OR REPLACE FUNCTION public.set_system_setting_bool(p_key text, p_value boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.set_system_setting_value(p_key, to_jsonb(p_value));
END;
$$;

-- ---------------------------------------------------------------------------
-- Authoritative gate: can the current caller create a NEW user?
-- Super Admin is always allowed. Everyone else depends on the global toggle.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_create_new_user()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_allowed boolean;
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id = auth.uid();

  IF v_role = 'super_admin' THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'SUPER_ADMIN', 'message', '');
  END IF;

  SELECT COALESCE((config #> '{user_registration,allow_new_user_creation}')::boolean, true)
    INTO v_allowed
  FROM public.system_settings WHERE id = 1;

  IF COALESCE(v_allowed, true) THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'ENABLED', 'message', 'New user creation is allowed.');
  END IF;

  RETURN jsonb_build_object(
    'allowed', false,
    'reason', 'REGISTRATION_DISABLED',
    'message', 'New user creation has been disabled by Super Admin.'
  );
END;
$$;

-- Oracle signature accepting a tenant/branch id (ignored; global control)
CREATE OR REPLACE FUNCTION public.can_create_new_user(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  RETURN public.can_create_new_user();
END;
$$;

-- ---------------------------------------------------------------------------
-- Gate public TENANT self-registration (new organization sign-up)
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

  INSERT INTO public.branch_subscriptions (branch_id, status, trial_starts_at, trial_ends_at)
  VALUES (v_branch_id, 'trial', now(), now() + interval '14 days');

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
    'membership_role', 'owner',
    'trial_days', 14
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', 'TENANT_REGISTRATION_FAILED', 'detail', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_tenant(text, text, text, text, text, text, text, text)
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Gate user creation: non-super-admin blocked when the toggle is OFF.
-- Body preserved 1:1 from the previous definition (055) except the added gate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_user(
  p_email text,
  p_password text,
  p_full_name text DEFAULT NULL,
  p_role text DEFAULT 'cashier',
  p_branch_id uuid DEFAULT NULL,
  p_is_active boolean DEFAULT true,
  p_username text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_role text;
  v_hash text;
  v_email text;
  v_username text;
  v_pgc_schema text;
  v_caller_role text;
  v_caller_branch uuid;
  v_u_cols text;
  v_u_vals text;
  v_i_cols text;
  v_i_vals text;
  v_reg_allowed boolean;
BEGIN
  SELECT role, branch_id INTO v_caller_role, v_caller_branch FROM public.users WHERE id = auth.uid();

  -- Global gate: Allow New User Creation.
  -- The trusted tenant-registration path (app.register_branch = 'on') is gated
  -- inside register_tenant; here we block ordinary user creation when OFF
  -- unless the caller is a Super Admin.
  IF current_setting('app.register_branch', true) <> 'on' AND COALESCE(v_caller_role, '') <> 'super_admin' THEN
    SELECT COALESCE((config #> '{user_registration,allow_new_user_creation}')::boolean, true)
      INTO v_reg_allowed
    FROM public.system_settings WHERE id = 1;
    IF NOT COALESCE(v_reg_allowed, true) THEN
      RETURN jsonb_build_object('success', false, 'error', 'REGISTRATION_DISABLED',
        'detail', 'New user creation has been disabled by Super Admin.');
    END IF;
  END IF;

  IF current_setting('app.register_branch', true) = 'on' THEN
    NULL; -- trusted caller: register_branch (SECURITY DEFINER) pre-validates
  ELSIF is_pos_admin() THEN
    NULL;
  ELSIF v_caller_role = 'branch_manager' AND v_caller_branch IS NOT NULL THEN
    -- branch manager: force their own branch and forbid admin roles
    IF p_branch_id IS NOT NULL AND p_branch_id <> v_caller_branch THEN
      RETURN jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED',
        'detail', 'Branch managers can only create users in their own branch');
    END IF;
    IF p_role IN ('super_admin', 'owner') THEN
      RETURN jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED',
        'detail', 'Only a super admin can create super_admin/owner accounts');
    END IF;
    p_branch_id := v_caller_branch;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED');
  END IF;

  v_email := lower(btrim(p_email));

  -- Email uniqueness (both auth accounts and app profiles)
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = v_email) THEN
    RETURN jsonb_build_object('success', false, 'error', 'EMAIL_TAKEN');
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE email = v_email) THEN
    RETURN jsonb_build_object('success', false, 'error', 'EMAIL_TAKEN');
  END IF;

  -- Username: default to email prefix, sanitized, must be unique
  v_username := regexp_replace(
    regexp_replace(lower(btrim(coalesce(NULLIF(p_username, ''), split_part(v_email, '@', 1)))), '[^a-z0-9._-]', '_', 'g'),
    '^[._-]+', '', 'g'
  );
  IF v_username = '' THEN
    v_username := 'user' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE username = v_username) THEN
    RETURN jsonb_build_object('success', false, 'error', 'USERNAME_TAKEN');
  END IF;

  SELECT extnamespace::regnamespace::text INTO v_pgc_schema
  FROM pg_extension WHERE extname = 'pgcrypto';

  IF v_pgc_schema IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNKNOWN_ERROR', 'detail', 'pgcrypto extension is not enabled');
  END IF;

  EXECUTE format('SELECT %I.crypt($1, %I.gen_salt($2, $3))', v_pgc_schema, v_pgc_schema)
    INTO v_hash USING p_password, 'bf', 10;

  -- Custom-role aware: the assigned role must exist in the matrix and be
  -- assignable by the caller (BM: global or own-branch roles only).
  IF NOT EXISTS (SELECT 1 FROM public.roles WHERE role = p_role) THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNKNOWN_ROLE');
  END IF;
  IF v_caller_role = 'branch_manager' AND NOT EXISTS (
    SELECT 1 FROM public.roles
    WHERE role = p_role AND (scope = 'global' OR branch_id = v_caller_branch)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED',
      'detail', 'Role not assignable in this branch');
  END IF;
  v_role := p_role;

  v_user_id := gen_random_uuid();

  SELECT string_agg(c.col, ', ' ORDER BY c.ord), string_agg(c.val, ', ' ORDER BY c.ord)
  INTO v_u_cols, v_u_vals
  FROM (
    SELECT cols.ordinal_position AS ord, quote_ident(cols.column_name) AS col,
      CASE cols.column_name
        WHEN 'instance_id' THEN '''00000000-0000-0000-0000-000000000000'''
        WHEN 'id' THEN quote_literal(v_user_id)
        WHEN 'aud' THEN '''authenticated'''
        WHEN 'role' THEN '''authenticated'''
        WHEN 'email' THEN quote_literal(v_email)
        WHEN 'encrypted_password' THEN quote_literal(v_hash)
        WHEN 'email_confirmed_at' THEN 'now()'
        WHEN 'confirmation_token' THEN ''''''
        WHEN 'recovery_token' THEN ''''''
        WHEN 'email_change' THEN ''''''
        WHEN 'email_change_token_new' THEN ''''''
        WHEN 'email_change_token_current' THEN ''''''
        WHEN 'raw_app_meta_data' THEN format('jsonb_build_object(''provider'',''email'',''providers'',array[''email'']::text[],''email'',%L)', v_email)
        WHEN 'raw_user_meta_data' THEN format('jsonb_build_object(''full_name'',%L,''email'',%L,''email_verified'',true)', p_full_name, v_email)
        WHEN 'created_at' THEN 'now()'
        WHEN 'updated_at' THEN 'now()'
        WHEN 'is_anonymous' THEN 'false'
        WHEN 'is_sso_user' THEN 'false'
      END AS val
    FROM information_schema.columns cols
    WHERE cols.table_schema = 'auth' AND cols.table_name = 'users'
      AND cols.is_generated = 'NEVER'
      AND cols.column_name IN ('instance_id','id','aud','role','email','encrypted_password','email_confirmed_at','confirmation_token','recovery_token','email_change','email_change_token_new','email_change_token_current','raw_app_meta_data','raw_user_meta_data','created_at','updated_at','is_anonymous','is_sso_user')
  ) c;

  IF v_u_cols IS NULL OR v_u_vals IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNKNOWN_ERROR', 'detail', 'no insertable columns found for auth.users');
  END IF;

  EXECUTE 'INSERT INTO auth.users (' || v_u_cols || ') VALUES (' || v_u_vals || ')';

  -- Identity row for the new auth account
  SELECT string_agg(c.col, ', ' ORDER BY c.ord), string_agg(c.val, ', ' ORDER BY c.ord)
  INTO v_i_cols, v_i_vals
  FROM (
    SELECT cols.ordinal_position AS ord, quote_ident(cols.column_name) AS col,
      CASE cols.column_name
        WHEN 'id' THEN 'gen_random_uuid()'
        WHEN 'provider_id' THEN quote_literal(v_user_id::text)
        WHEN 'user_id' THEN quote_literal(v_user_id)
        WHEN 'identity_data' THEN format('jsonb_build_object(''sub'',%L,''email'',%L)', v_user_id::text, v_email)
        WHEN 'provider' THEN '''email'''
        WHEN 'last_sign_in_at' THEN 'now()'
        WHEN 'created_at' THEN 'now()'
        WHEN 'updated_at' THEN 'now()'
        WHEN 'email' THEN quote_literal(v_email)
      END AS val
    FROM information_schema.columns cols
    WHERE cols.table_schema = 'auth' AND cols.table_name = 'identities'
      AND cols.is_generated = 'NEVER'
      AND cols.column_name IN ('id','provider_id','user_id','identity_data','provider','last_sign_in_at','created_at','updated_at','email')
  ) c;

  IF v_i_cols IS NULL OR v_i_vals IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNKNOWN_ERROR', 'detail', 'no insertable columns found for auth.identities');
  END IF;

  EXECUTE 'INSERT INTO auth.identities (' || v_i_cols || ') VALUES (' || v_i_vals || ')';

  INSERT INTO public.users (id, email, username, full_name, role, branch_id, is_active)
  VALUES (v_user_id, v_email, v_username, p_full_name, v_role, p_branch_id, p_is_active);

  RETURN jsonb_build_object('success', true, 'user_id', v_user_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', 'UNKNOWN_ERROR', 'detail', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_user(text, text, text, text, uuid, boolean, text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.set_system_setting_value(text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_system_setting(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_system_setting_bool(text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_system_settings(text) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_system_setting(text) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.can_create_new_user() TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.can_create_new_user(uuid) TO authenticated, anon, service_role;
