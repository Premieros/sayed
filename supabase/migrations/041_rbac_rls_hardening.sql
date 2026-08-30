-- ============================================================================
-- 041. RBAC + RLS hardening
-- ----------------------------------------------------------------------------
-- Fixes permission leaks caused by permissive/legacy policies and makes the
-- role matrix branch-aware. This migration is additive and safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_permission(p_permission text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.is_pos_admin()
      OR EXISTS (
        SELECT 1
        FROM public.users u
        JOIN public.roles r ON r.role = u.role
        WHERE u.id = auth.uid()
          AND u.is_active
          AND r.is_active
          AND r.permissions ? p_permission
          AND (
            r.scope = 'global'
            OR (r.scope = 'branch' AND r.branch_id = u.branch_id)
          )
      );
$$;

CREATE OR REPLACE FUNCTION public.can_permission_for_branch(
  p_permission text,
  p_branch_id uuid
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.is_platform_admin()
      OR EXISTS (
        SELECT 1
        FROM public.users u
        JOIN public.roles r ON r.role = u.role
        WHERE u.id = auth.uid()
          AND u.is_active
          AND r.is_active
          AND r.permissions ? p_permission
          AND (
            r.scope = 'global'
            OR (r.scope = 'branch' AND r.branch_id = p_branch_id)
          )
          AND public.user_may_access_branch(p_branch_id)
      );
$$;

CREATE OR REPLACE FUNCTION public.guard_role_permissions()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_caller_branch uuid;
  v_perm text;
BEGIN
  SELECT role, branch_id INTO v_caller_role, v_caller_branch
  FROM public.users WHERE id = auth.uid();

  IF v_caller_role = 'branch_manager' THEN
    IF NEW.scope <> 'branch' OR NEW.branch_id IS DISTINCT FROM v_caller_branch THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: branch managers may only manage roles for their own branch';
    END IF;

    FOR v_perm IN SELECT jsonb_array_elements_text(COALESCE(NEW.permissions, '[]'::jsonb)) LOOP
      IF v_perm IN ('settings.manage', 'branches.manage', 'audit.view') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: branch managers cannot grant %', v_perm;
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_user_role_changes()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_caller_branch uuid;
  v_bypass boolean;
  v_register boolean;
  v_role_scope text;
  v_role_branch uuid;
BEGIN
  SELECT role, branch_id INTO v_caller_role, v_caller_branch
  FROM public.users WHERE id = auth.uid();

  v_bypass := COALESCE(current_setting('app.login_guard_bypass', true), '') = 'on';
  v_register := COALESCE(current_setting('app.register_branch', true), '') = 'on';
  IF v_register THEN RETURN NEW; END IF;

  SELECT scope, branch_id INTO v_role_scope, v_role_branch
  FROM public.roles WHERE role = NEW.role AND is_active;
  IF v_role_scope IS NULL THEN RAISE EXCEPTION 'UNKNOWN_ROLE'; END IF;

  IF v_caller_role IS NULL THEN
    IF TG_OP = 'INSERT' AND NEW.id = auth.uid() AND NEW.role = 'cashier' AND NEW.branch_id IS NULL THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.id = OLD.id
       AND NEW.role IS NOT DISTINCT FROM OLD.role
       AND NEW.branch_id IS NOT DISTINCT FROM OLD.branch_id
       AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active
       AND NEW.email IS NOT DISTINCT FROM OLD.email
       AND NEW.username IS NOT DISTINCT FROM OLD.username
       AND NEW.full_name IS NOT DISTINCT FROM OLD.full_name
       AND NEW.phone IS NOT DISTINCT FROM OLD.phone THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  IF NEW.role IN ('super_admin', 'owner')
     AND v_caller_role NOT IN ('super_admin', 'owner') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: only an admin can assign admin roles';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.role IN ('super_admin', 'owner')
       AND v_caller_role NOT IN ('super_admin', 'owner') THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: only an admin can modify admin accounts';
    END IF;

    IF NEW.id = auth.uid() AND v_caller_role NOT IN ('super_admin', 'owner') THEN
      IF NEW.role IS DISTINCT FROM OLD.role
         OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
         OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: users cannot change their own role/branch/status';
      END IF;

      IF NOT v_bypass THEN
        IF NEW.is_locked IS DISTINCT FROM OLD.is_locked
           OR NEW.failed_attempts IS DISTINCT FROM OLD.failed_attempts
           OR NEW.lock_until IS DISTINCT FROM OLD.lock_until THEN
          RAISE EXCEPTION 'PERMISSION_DENIED: users cannot modify their own lock state';
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_caller_role <> 'super_admin'
     AND v_role_scope = 'branch'
     AND v_role_branch IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: role belongs to another branch';
  END IF;

  IF v_caller_role = 'branch_manager'
     AND NEW.branch_id IS DISTINCT FROM v_caller_branch THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: branch managers can only manage their own branch';
  END IF;

  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS auth_all_inventory_movements ON public.inventory_movements;
DROP POLICY IF EXISTS inventory_movements_select_branch_isolated ON public.inventory_movements;
DROP POLICY IF EXISTS inventory_movements_insert_branch_isolated ON public.inventory_movements;
DROP POLICY IF EXISTS inventory_movements_update_branch_isolated ON public.inventory_movements;
DROP POLICY IF EXISTS inventory_movements_delete_branch_isolated ON public.inventory_movements;
CREATE POLICY inventory_movements_select_branch_isolated ON public.inventory_movements FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR public.user_may_access_branch(branch_id));
CREATE POLICY inventory_movements_insert_branch_isolated ON public.inventory_movements FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin() OR (public.can_permission_for_branch('inventory.manage', branch_id) AND public.user_may_access_branch(branch_id)));
CREATE POLICY inventory_movements_update_branch_isolated ON public.inventory_movements FOR UPDATE TO authenticated
  USING (public.is_platform_admin() OR (public.can_permission_for_branch('inventory.manage', branch_id) AND public.user_may_access_branch(branch_id)))
  WITH CHECK (public.is_platform_admin() OR (public.can_permission_for_branch('inventory.manage', branch_id) AND public.user_may_access_branch(branch_id)));
CREATE POLICY inventory_movements_delete_branch_isolated ON public.inventory_movements FOR DELETE TO authenticated
  USING (public.is_platform_admin() OR (public.can_permission_for_branch('inventory.manage', branch_id) AND public.user_may_access_branch(branch_id)));

DROP POLICY IF EXISTS auth_all_raw_material_movements ON public.raw_material_movements;
DROP POLICY IF EXISTS raw_material_movements_select_branch_isolated ON public.raw_material_movements;
DROP POLICY IF EXISTS raw_material_movements_insert_branch_isolated ON public.raw_material_movements;
DROP POLICY IF EXISTS raw_material_movements_update_branch_isolated ON public.raw_material_movements;
DROP POLICY IF EXISTS raw_material_movements_delete_branch_isolated ON public.raw_material_movements;
CREATE POLICY raw_material_movements_select_branch_isolated ON public.raw_material_movements FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR public.user_may_access_branch(branch_id));
CREATE POLICY raw_material_movements_insert_branch_isolated ON public.raw_material_movements FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin() OR (public.can_permission_for_branch('raw_materials.manage', branch_id) AND public.user_may_access_branch(branch_id)));
CREATE POLICY raw_material_movements_update_branch_isolated ON public.raw_material_movements FOR UPDATE TO authenticated
  USING (public.is_platform_admin() OR (public.can_permission_for_branch('raw_materials.manage', branch_id) AND public.user_may_access_branch(branch_id)))
  WITH CHECK (public.is_platform_admin() OR (public.can_permission_for_branch('raw_materials.manage', branch_id) AND public.user_may_access_branch(branch_id)));
CREATE POLICY raw_material_movements_delete_branch_isolated ON public.raw_material_movements FOR DELETE TO authenticated
  USING (public.is_platform_admin() OR (public.can_permission_for_branch('raw_materials.manage', branch_id) AND public.user_may_access_branch(branch_id)));

DROP POLICY IF EXISTS auth_select_raw_materials ON public.raw_materials;
DROP POLICY IF EXISTS raw_materials_select_branch_isolated ON public.raw_materials;
CREATE POLICY raw_materials_select_branch_isolated ON public.raw_materials FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR public.user_may_access_branch(branch_id));

DROP POLICY IF EXISTS product_cost_history_insert ON public.product_cost_history;
DROP POLICY IF EXISTS product_cost_history_select ON public.product_cost_history;
CREATE POLICY product_cost_history_select ON public.product_cost_history FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.id = product_cost_history.product_id AND public.user_may_access_branch(p.branch_id)
  ));
CREATE POLICY product_cost_history_insert ON public.product_cost_history FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.id = product_cost_history.product_id
      AND public.can_permission_for_branch('products.manage', p.branch_id)
      AND public.user_may_access_branch(p.branch_id)
  ));

DROP POLICY IF EXISTS auth_stock_counts_select ON public.stock_counts;
DROP POLICY IF EXISTS auth_stock_counts_insert ON public.stock_counts;
DROP POLICY IF EXISTS auth_stock_counts_update ON public.stock_counts;
DROP POLICY IF EXISTS auth_stock_count_items_select ON public.stock_count_items;
DROP POLICY IF EXISTS auth_stock_count_items_insert ON public.stock_count_items;
DROP POLICY IF EXISTS auth_stock_count_items_update ON public.stock_count_items;
CREATE POLICY auth_stock_counts_select ON public.stock_counts FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR public.user_may_access_branch(branch_id));
CREATE POLICY auth_stock_counts_insert ON public.stock_counts FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin() OR (public.can_permission_for_branch('inventory.manage', branch_id) AND public.user_may_access_branch(branch_id)));
CREATE POLICY auth_stock_counts_update ON public.stock_counts FOR UPDATE TO authenticated
  USING (public.is_platform_admin() OR (public.can_permission_for_branch('inventory.manage', branch_id) AND public.user_may_access_branch(branch_id)))
  WITH CHECK (public.is_platform_admin() OR (public.can_permission_for_branch('inventory.manage', branch_id) AND public.user_may_access_branch(branch_id)));
CREATE POLICY auth_stock_count_items_select ON public.stock_count_items FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.stock_counts sc
    WHERE sc.id = stock_count_items.stock_count_id AND public.user_may_access_branch(sc.branch_id)
  ));
CREATE POLICY auth_stock_count_items_insert ON public.stock_count_items FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.stock_counts sc
    WHERE sc.id = stock_count_items.stock_count_id
      AND public.can_permission_for_branch('inventory.manage', sc.branch_id)
      AND public.user_may_access_branch(sc.branch_id)
  ));
CREATE POLICY auth_stock_count_items_update ON public.stock_count_items FOR UPDATE TO authenticated
  USING (public.is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.stock_counts sc
    WHERE sc.id = stock_count_items.stock_count_id
      AND public.can_permission_for_branch('inventory.manage', sc.branch_id)
      AND public.user_may_access_branch(sc.branch_id)
  ))
  WITH CHECK (public.is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.stock_counts sc
    WHERE sc.id = stock_count_items.stock_count_id
      AND public.can_permission_for_branch('inventory.manage', sc.branch_id)
      AND public.user_may_access_branch(sc.branch_id)
  ));

REVOKE EXECUTE ON FUNCTION public.can_permission(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.can_permission_for_branch(text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_user_role() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_branch_id() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_pos_admin() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_platform_admin() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_branch_manager() FROM anon;
REVOKE EXECUTE ON FUNCTION public.user_may_access_branch(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_permission(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_permission_for_branch(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_branch_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_pos_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_branch_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_may_access_branch(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
