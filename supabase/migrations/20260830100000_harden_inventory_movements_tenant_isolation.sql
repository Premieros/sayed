-- Harden inventory movement history after the timestamped multi-tenant
-- foundation exists. Migration 095 intentionally stays schema-independent.

ALTER TABLE public.inventory_movements
  ADD COLUMN IF NOT EXISTS organization_id uuid;

ALTER TABLE public.raw_material_movements
  ADD COLUMN IF NOT EXISTS organization_id uuid;

UPDATE public.inventory_movements im
SET organization_id = b.organization_id
FROM public.branches b
WHERE im.branch_id = b.id
  AND im.organization_id IS NULL;

UPDATE public.raw_material_movements rmm
SET organization_id = b.organization_id
FROM public.branches b
WHERE rmm.branch_id = b.id
  AND rmm.organization_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.inventory_movements'::regclass
      AND conname = 'inventory_movements_organization_id_fkey'
  ) THEN
    ALTER TABLE public.inventory_movements
      ADD CONSTRAINT inventory_movements_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES public.organizations(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.raw_material_movements'::regclass
      AND conname = 'raw_material_movements_organization_id_fkey'
  ) THEN
    ALTER TABLE public.raw_material_movements
      ADD CONSTRAINT raw_material_movements_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES public.organizations(id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inv_movements_organization
  ON public.inventory_movements(organization_id);
CREATE INDEX IF NOT EXISTS idx_rm_movements_organization
  ON public.raw_material_movements(organization_id);

CREATE OR REPLACE FUNCTION public.sync_inventory_movement_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
BEGIN
  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_org_id
    FROM public.branches b
    WHERE b.id = NEW.branch_id;

    IF v_org_id IS NULL THEN
      RAISE EXCEPTION 'Branch % has no organization', NEW.branch_id;
    END IF;

    IF NEW.organization_id IS NULL THEN
      NEW.organization_id := v_org_id;
    ELSIF NEW.organization_id <> v_org_id THEN
      RAISE EXCEPTION 'Movement organization does not match branch organization';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_inventory_movement_organization
  ON public.inventory_movements;
CREATE TRIGGER trg_sync_inventory_movement_organization
BEFORE INSERT OR UPDATE OF branch_id, organization_id
ON public.inventory_movements
FOR EACH ROW
EXECUTE FUNCTION public.sync_inventory_movement_organization();

DROP TRIGGER IF EXISTS trg_sync_raw_material_movement_organization
  ON public.raw_material_movements;
CREATE TRIGGER trg_sync_raw_material_movement_organization
BEFORE INSERT OR UPDATE OF branch_id, organization_id
ON public.raw_material_movements
FOR EACH ROW
EXECUTE FUNCTION public.sync_inventory_movement_organization();

DROP POLICY IF EXISTS "auth_all_inventory_movements" ON public.inventory_movements;
CREATE POLICY "auth_all_inventory_movements" ON public.inventory_movements
  FOR ALL TO authenticated
  USING (public.user_may_access_branch(branch_id))
  WITH CHECK (public.user_may_access_branch(branch_id));

DROP POLICY IF EXISTS "auth_all_raw_material_movements" ON public.raw_material_movements;
CREATE POLICY "auth_all_raw_material_movements" ON public.raw_material_movements
  FOR ALL TO authenticated
  USING (public.user_may_access_branch(branch_id))
  WITH CHECK (public.user_may_access_branch(branch_id));

COMMENT ON COLUMN public.inventory_movements.organization_id IS
  'Tenant derived from branch; must match branch.organization_id.';
COMMENT ON COLUMN public.raw_material_movements.organization_id IS
  'Tenant derived from branch; must match branch.organization_id.';
