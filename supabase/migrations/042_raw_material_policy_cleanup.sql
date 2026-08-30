-- ============================================================================
-- 042. Raw-material policy cleanup
-- ----------------------------------------------------------------------------
-- Remove legacy branch-only policies that bypassed the role permission matrix
-- because PostgreSQL combines permissive RLS policies with OR.
-- ============================================================================
DROP POLICY IF EXISTS raw_materials_delete_branch_isolated ON public.raw_materials;
DROP POLICY IF EXISTS raw_materials_insert_branch_isolated ON public.raw_materials;
DROP POLICY IF EXISTS raw_materials_update_branch_isolated ON public.raw_materials;

NOTIFY pgrst, 'reload schema';
