-- ============================================================================
-- Remove the Manufacturing / Raw Materials / Waste subsystem (refactor)
-- ----------------------------------------------------------------------------
-- Product scope decision: the POS is a finished-goods system. The
-- raw_materials / recipes / production_orders / production_waste / waste /
-- inventory_unit_recipes / inventory_unit_productions subsystem is removed
-- wholesale. What survives:
--
--   * product_components  - neutral take-out / BOM composition (used by the
--                           POS consumption path and costing).
--   * inventory_units     - unit-inventory system (units, product_unit_links,
--                           inventory_unit_batches, inventory_unit_entries).
--   * warehouse_transfers - neutral inventory feature (still used).
--
-- This migration:
--   1. Drops the now-unused manufacturing / waste RPCs.
--   2. Rewrites the neutral RPCs that referenced raw materials so they are
--      product-only (authoritative latest versions are re-created).
--   3. Removes the production_manager role from the app role matrix.
--   4. Drops the raw_material_id columns (+ FK/index/check baggage) from the
--      surviving tables.
--   5. Drops the subsystem tables (leaf-first, raw_materials last).
--
-- Structural sibling: the kitchen consumption (send_to_kitchen) uses
-- product_components + neutral inventory only; no raw tables are involved.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Drop the subsystem RPCs (all overloads, any signature).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        '_raw_add',
        '_raw_remove_fifo',
        '_raw_wavg_cost',
        '_product_recipe_cost',
        'create_production_order',
        'start_production_order',
        'complete_production_order',
        'cancel_production_order',
        'adjust_raw_stock',
        'produce_inventory_unit',
        'get_production_variance',
        'deduct_raw_material_inventory',
        'create_waste_entry',
        'approve_waste',
        'get_waste_report'
      )
  LOOP
    EXECUTE 'DROP FUNCTION ' || v.sig || ' CASCADE';
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Remove the production_manager role from the app matrix.
--    The users_role_check constraint was dropped in 043; role assignment is
--    enforced by the trg_users_role_guard trigger against the roles table,
--    so removing the row is sufficient to forbid new assignments. Existing
--    holders are migrated to warehouse_manager (still assignable). The role
--    guard is suspended for the data migration only (it would otherwise
--    reject the UPDATE from a non-authenticated migration context).
-- ---------------------------------------------------------------------------
ALTER TABLE public.users DISABLE TRIGGER trg_users_role_guard;

UPDATE public.users
SET role = 'warehouse_manager',
    updated_at = now()
WHERE role = 'production_manager';

ALTER TABLE public.users ENABLE TRIGGER trg_users_role_guard;

DELETE FROM public.roles WHERE role = 'production_manager';

-- ---------------------------------------------------------------------------
-- 3. Neutral RPC rewrites (product-only).
-- ---------------------------------------------------------------------------

-- 3a. seed_opening_balances: finished goods (inventory_fg) only.
CREATE OR REPLACE FUNCTION public.seed_opening_balances(p_branch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_finished numeric(14,2);
  v_lines jsonb := '[]'::jsonb;
  v_total numeric(14,2) := 0;
BEGIN
  BEGIN
    IF NOT is_pos_admin() THEN
      RETURN jsonb_build_object('success', false, 'error', 'NOT_ALLOWED');
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.journal_entries
      WHERE branch_id = p_branch_id AND reference_type = 'opening'
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'OPENING_ALREADY_EXISTS');
    END IF;

    SELECT COALESCE(SUM(b.quantity * b.unit_cost), 0) INTO v_finished
    FROM public.inventory_batches b WHERE b.branch_id = p_branch_id;

    v_total := round(v_finished, 2);
    IF v_total <= 0 THEN
      RETURN jsonb_build_object('success', true, 'skipped', true, 'total', 0);
    END IF;

    IF v_finished > 0 THEN
      v_lines := v_lines || jsonb_build_object('account_key', 'inventory_fg', 'debit', round(v_finished, 2), 'credit', 0, 'note', 'رصيد افتتاحي للمخزون');
    END IF;
    v_lines := v_lines || jsonb_build_object('account_key', 'capital', 'debit', 0, 'credit', v_total, 'note', 'رصيد افتتاحي');

    PERFORM public._post_journal_entry(p_branch_id, 'opening', NULL, 'OPENING',
      'رصيد افتتاحي للمخزون', v_lines);

    RETURN jsonb_build_object('success', true, 'total', v_total, 'finished', v_finished);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRANSACTION_FAILED', 'detail', SQLERRM);
  END;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.seed_opening_balances(uuid) TO authenticated;

-- 3b. process_purchase: finished-goods only.
CREATE OR REPLACE FUNCTION public.process_purchase(p_invoice_number text, p_supplier_id uuid, p_branch_id uuid, p_warehouse_id uuid, p_subtotal numeric, p_discount_amount numeric, p_tax_amount numeric, p_total numeric, p_paid_amount numeric, p_payment_method text, p_status text, p_notes text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_purchase_id uuid;
  v_user_branch uuid;
  v_item jsonb;
  v_product_id uuid;
  v_quantity numeric(14,4);
  v_unit_cost numeric(12,2);
  v_res jsonb;
  v_stock numeric(14,4);
  v_stock_val numeric(14,2);
  v_new_cost numeric(12,2);
  v_goods_fg numeric(14,2) := 0;
  v_paid numeric(14,2);
  v_ap numeric(14,2);
  v_lines jsonb := '[]'::jsonb;
  v_dr numeric(14,2) := 0;
  v_cr numeric(14,2) := 0;
  v_diff numeric(14,2);
BEGIN
  BEGIN
    IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'EMPTY_CART');
    END IF;

    IF NOT is_pos_admin() AND get_user_role() NOT IN ('warehouse_manager','branch_manager') THEN
      RETURN jsonb_build_object('success', false, 'error', 'NOT_ALLOWED',
        'detail', 'Creating purchases requires the purchases.manage permission.');
    END IF;

    IF NOT is_pos_admin() THEN
      SELECT branch_id INTO v_user_branch FROM users WHERE id = auth.uid();
      IF v_user_branch IS NOT NULL AND p_branch_id IS NOT NULL AND v_user_branch <> p_branch_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'BRANCH_MISMATCH');
      END IF;
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_product_id := (v_item->>'product_id')::uuid;
      v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
      IF v_product_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'ITEM_MISSING_TYPE');
      END IF;
      IF v_quantity <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_QUANTITY');
      END IF;
      IF p_warehouse_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'WAREHOUSE_REQUIRED',
          'detail', 'Select a warehouse to receive product items.');
      END IF;
    END LOOP;

    INSERT INTO purchases (invoice_number, supplier_id, branch_id, warehouse_id, buyer_id,
      subtotal, discount_amount, tax_amount, total, paid_amount, payment_method, status, notes)
    VALUES (p_invoice_number, p_supplier_id, p_branch_id, p_warehouse_id, auth.uid(),
      p_subtotal, p_discount_amount, p_tax_amount, p_total, p_paid_amount, p_payment_method, p_status, p_notes)
    RETURNING id INTO v_purchase_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_product_id := (v_item->>'product_id')::uuid;
      v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
      v_unit_cost := COALESCE((v_item->>'unit_cost')::numeric, 0);

      INSERT INTO purchase_items (purchase_id, product_id, unit_name, quantity, unit_cost, total)
      VALUES (v_purchase_id, v_product_id, COALESCE(v_item->>'unit_name', 'piece'),
        v_quantity, v_unit_cost, v_quantity * v_unit_cost);

      v_res := public._product_inv_add(v_product_id, p_warehouse_id, p_branch_id, v_quantity,
        v_unit_cost, v_item->>'batch_number',
        (v_item->>'production_date')::date, (v_item->>'expiry_date')::date,
        'purchase', 'purchase', v_purchase_id, p_invoice_number, auth.uid());
      IF NOT (v_res->>'success')::boolean THEN
        RETURN v_res;
      END IF;

      SELECT COALESCE(SUM(b.quantity), 0), COALESCE(SUM(b.quantity * b.unit_cost), 0)
      INTO v_stock, v_stock_val
      FROM public.inventory_batches b WHERE b.product_id = v_product_id;
      v_new_cost := CASE WHEN v_stock > 0 THEN round(v_stock_val / v_stock, 2) ELSE v_unit_cost END;
      UPDATE public.products SET cost_price = v_new_cost, updated_at = now() WHERE id = v_product_id;

      v_goods_fg := round(v_goods_fg + v_quantity * v_unit_cost, 2);
    END LOOP;

    IF COALESCE(p_status, 'completed') = 'completed' THEN
      v_paid := round(COALESCE(p_paid_amount, 0), 2);
      v_ap := round(COALESCE(p_total, 0) - v_paid, 2);

      IF v_goods_fg > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_key', 'inventory_fg', 'debit', v_goods_fg, 'credit', 0, 'note', p_invoice_number);
        v_dr := v_dr + v_goods_fg;
      END IF;
      IF COALESCE(p_tax_amount, 0) > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_key', 'vat_receivable', 'debit', p_tax_amount, 'credit', 0);
        v_dr := v_dr + p_tax_amount;
      END IF;
      IF COALESCE(p_discount_amount, 0) > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_key', 'discount_received', 'debit', 0, 'credit', p_discount_amount);
        v_cr := v_cr + p_discount_amount;
      END IF;
      IF v_paid > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_key', CASE WHEN COALESCE(p_payment_method, 'cash') = 'cash' THEN 'cash' ELSE 'bank' END,
          'debit', 0, 'credit', v_paid, 'note', p_invoice_number);
        v_cr := v_cr + v_paid;
      END IF;
      IF v_ap > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_key', 'ap', 'debit', 0, 'credit', v_ap,
          'supplier_id', p_supplier_id, 'note', p_invoice_number);
        v_cr := v_cr + v_ap;
      END IF;

      v_diff := round(v_dr - v_cr, 2);
      IF v_diff <> 0 THEN
        IF v_diff > 0 THEN
          v_lines := v_lines || jsonb_build_object('account_key', 'discount_received', 'debit', 0, 'credit', v_diff);
        ELSE
          v_lines := v_lines || jsonb_build_object('account_key', 'discount_received', 'debit', -v_diff, 'credit', 0);
        END IF;
      END IF;

      PERFORM public._post_journal_entry(p_branch_id, 'purchase', v_purchase_id, p_invoice_number,
        'فاتورة شراء ' || p_invoice_number, v_lines);
    END IF;

    RETURN jsonb_build_object('success', true, 'purchase_id', v_purchase_id, 'invoice_number', p_invoice_number);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRANSACTION_FAILED', 'detail', SQLERRM);
  END;
END;
$function$;

-- 3c. process_purchase_return: finished-goods only (NO raw restock / NO rm leg).
CREATE OR REPLACE FUNCTION public.process_purchase_return(
  p_purchase_id uuid,
  p_items jsonb DEFAULT NULL::jsonb,
  p_reason text DEFAULT NULL::text
) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_purchase record;
  v_user_branch uuid;
  v_return_total numeric(14,2) := 0;
  v_item record;
  v_req jsonb;
  v_item_id uuid;
  v_req_qty numeric(14,4);
  v_already numeric(14,4);
  v_ret_qty numeric(14,4);
  v_item_line_total numeric(14,2);
  v_item_ret_amt numeric(14,2);
  v_all_returned boolean := true;
  v_remaining numeric(14,4);
  v_res jsonb;
  v_purchase_entry uuid;
  v_fg numeric(14,2);
  v_vat numeric(14,2);
  v_discount numeric(14,2);
  v_paid_cash numeric(14,2);
  v_paid_bank numeric(14,2);
  v_ap numeric(14,2);
  v_ratio numeric(14,6);
  v_fg_r numeric(14,2);
  v_vat_r numeric(14,2);
  v_discount_r numeric(14,2);
  v_paid_r numeric(14,2);
  v_ap_r numeric(14,2);
  v_dr numeric(14,2) := 0;
  v_cr numeric(14,2) := 0;
  v_diff numeric(14,2);
  v_credit_key text;
  v_lines jsonb := '[]'::jsonb;
BEGIN
  BEGIN
    IF p_purchase_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'INVALID_PURCHASE');
    END IF;

    SELECT id, branch_id, warehouse_id, status, total, paid_amount, supplier_id, invoice_number
      INTO v_purchase FROM public.purchases WHERE id = p_purchase_id;
    IF v_purchase.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'PURCHASE_NOT_FOUND');
    END IF;

    IF v_purchase.status = 'returned' THEN
      RETURN jsonb_build_object('success', false, 'error', 'ALREADY_RETURNED');
    END IF;
    IF v_purchase.status <> 'completed' THEN
      RETURN jsonb_build_object('success', false, 'error', 'INVALID_STATUS',
        'status', v_purchase.status, 'detail', 'Only completed purchases can be returned.');
    END IF;

    IF NOT is_pos_admin() AND get_user_role() NOT IN ('warehouse_manager','branch_manager') THEN
      RETURN jsonb_build_object('success', false, 'error', 'NOT_ALLOWED',
        'detail', 'Purchase returns require the purchases.manage permission.');
    END IF;

    SELECT branch_id INTO v_user_branch FROM users WHERE id = auth.uid();
    IF NOT is_pos_admin() AND v_user_branch IS NOT NULL
       AND v_purchase.branch_id IS NOT NULL AND v_user_branch <> v_purchase.branch_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'BRANCH_MISMATCH');
    END IF;

    -- ===== VALIDATION PHASE =====
    IF p_items IS NOT NULL AND jsonb_array_length(p_items) > 0 THEN
      FOR v_req IN SELECT * FROM jsonb_array_elements(p_items)
      LOOP
        v_item_id := (v_req->>'purchase_item_id')::uuid;
        v_req_qty := COALESCE((v_req->>'quantity')::numeric, 0);
        IF v_req_qty <= 0 THEN
          RETURN jsonb_build_object('success', false, 'error', 'INVALID_QUANTITY', 'purchase_item_id', v_item_id);
        END IF;
        SELECT id, quantity, returned_quantity INTO v_item
          FROM purchase_items WHERE id = v_item_id AND purchase_id = p_purchase_id;
        IF v_item.id IS NULL THEN
          RETURN jsonb_build_object('success', false, 'error', 'ITEM_NOT_FOUND', 'purchase_item_id', v_item_id);
        END IF;
        v_already := COALESCE(v_item.returned_quantity, 0);
        IF v_req_qty > v_item.quantity - v_already THEN
          RETURN jsonb_build_object('success', false, 'error', 'RETURN_EXCEEDS_QUANTITY',
            'purchase_item_id', v_item_id, 'max', v_item.quantity - v_already);
        END IF;
      END LOOP;
    END IF;

    -- ===== RETURN + RESTOCK-OUT PHASE =====
    FOR v_item IN SELECT id, product_id, quantity, unit_cost, returned_quantity
                  FROM purchase_items WHERE purchase_id = p_purchase_id
    LOOP
      IF p_items IS NOT NULL AND jsonb_array_length(p_items) > 0 THEN
        v_req_qty := 0;
        SELECT (req->>'quantity')::numeric INTO v_req_qty
        FROM jsonb_array_elements(p_items) req
        WHERE (req->>'purchase_item_id')::uuid = v_item.id;
        v_req_qty := COALESCE(v_req_qty, 0);
      ELSE
        v_req_qty := v_item.quantity - COALESCE(v_item.returned_quantity, 0);
      END IF;
      IF v_req_qty <= 0 THEN CONTINUE; END IF;

      v_item_line_total := v_item.quantity * v_item.unit_cost;
      IF v_item.quantity > 0 THEN
        v_item_ret_amt := ROUND(v_item_line_total * v_req_qty / v_item.quantity, 2);
      ELSE
        v_item_ret_amt := 0;
      END IF;
      v_return_total := v_return_total + v_item_ret_amt;

      UPDATE purchase_items
        SET returned_quantity = COALESCE(returned_quantity, 0) + v_req_qty,
            returned_amount = COALESCE(returned_amount, 0) + v_item_ret_amt
        WHERE id = v_item.id;

      -- Return the goods to the supplier (remove from the receiving warehouse)
      v_remaining := v_req_qty;
      IF v_item.product_id IS NOT NULL THEN
        v_res := public._product_inv_remove_fifo(v_item.product_id, v_purchase.warehouse_id,
          v_purchase.branch_id, v_remaining, 'purchase_return', 'purchase_return',
          p_purchase_id, v_purchase.invoice_number, auth.uid());
        IF NOT (v_res->>'success')::boolean THEN
          RETURN v_res;
        END IF;
      END IF;
    END LOOP;

    -- Update header: full return flips the status, otherwise accumulate returned_amount
    SELECT bool_and(quantity = returned_quantity) INTO v_all_returned
      FROM purchase_items WHERE purchase_id = p_purchase_id;
    UPDATE purchases SET
      returned_amount = COALESCE(returned_amount, 0) + v_return_total,
      status = CASE WHEN v_all_returned THEN 'returned' ELSE status END,
      notes = CASE WHEN p_reason IS NOT NULL THEN COALESCE(notes, '') || E'\n' || p_reason ELSE notes END
      WHERE id = p_purchase_id;

    -- ===== LEDGER POSTING: prorated reversal of the purchase entry =====
    IF v_return_total > 0 THEN
      SELECT id INTO v_purchase_entry
      FROM public.journal_entries
      WHERE branch_id = v_purchase.branch_id AND reference_type = 'purchase' AND reference_id = p_purchase_id;

      IF v_purchase_entry IS NOT NULL THEN
        SELECT
          round(COALESCE(SUM(CASE WHEN a.id = m.fg_id THEN l.debit - l.credit ELSE 0 END), 0), 2),
          round(COALESCE(SUM(CASE WHEN a.id = m.vat_id THEN l.debit - l.credit ELSE 0 END), 0), 2),
          round(COALESCE(SUM(CASE WHEN a.id = m.disc_id THEN l.credit - l.debit ELSE 0 END), 0), 2),
          round(COALESCE(SUM(CASE WHEN a.id = m.cash_id THEN l.credit - l.debit ELSE 0 END), 0), 2),
          round(COALESCE(SUM(CASE WHEN a.id = m.bank_id THEN l.credit - l.debit ELSE 0 END), 0), 2),
          round(COALESCE(SUM(CASE WHEN a.id = m.ap_id THEN l.credit - l.debit ELSE 0 END), 0), 2)
        INTO v_fg, v_vat, v_discount, v_paid_cash, v_paid_bank, v_ap
        FROM public.journal_entry_lines l
        JOIN public.chart_of_accounts a ON a.id = l.account_id
        CROSS JOIN (
          SELECT
            (SELECT public.resolve_account_key(v_purchase.branch_id, 'inventory_fg')) AS fg_id,
            (SELECT public.resolve_account_key(v_purchase.branch_id, 'vat_receivable')) AS vat_id,
            (SELECT public.resolve_account_key(v_purchase.branch_id, 'discount_received')) AS disc_id,
            (SELECT public.resolve_account_key(v_purchase.branch_id, 'cash')) AS cash_id,
            (SELECT public.resolve_account_key(v_purchase.branch_id, 'bank')) AS bank_id,
            (SELECT public.resolve_account_key(v_purchase.branch_id, 'ap')) AS ap_id
        ) m
        WHERE l.journal_entry_id = v_purchase_entry;

        v_ratio := round(v_return_total / GREATEST(COALESCE(v_purchase.total, 0), 1), 6);
        v_fg_r := round(COALESCE(v_fg, 0) * v_ratio, 2);
        v_vat_r := round(COALESCE(v_vat, 0) * v_ratio, 2);
        v_discount_r := round(COALESCE(v_discount, 0) * v_ratio, 2);
        v_paid_r := round((COALESCE(v_paid_cash, 0) + COALESCE(v_paid_bank, 0)) * v_ratio, 2);
        v_ap_r := round(COALESCE(v_ap, 0) * v_ratio, 2);

        v_credit_key := CASE WHEN COALESCE(v_paid_cash, 0) >= COALESCE(v_paid_bank, 0) THEN 'cash' ELSE 'bank' END;

        IF v_fg_r > 0 THEN
          v_lines := v_lines || jsonb_build_object('account_key', 'inventory_fg', 'debit', 0, 'credit', v_fg_r);
          v_cr := v_cr + v_fg_r;
        END IF;
        IF v_vat_r > 0 THEN
          v_lines := v_lines || jsonb_build_object('account_key', 'vat_receivable', 'debit', 0, 'credit', v_vat_r);
          v_cr := v_cr + v_vat_r;
        END IF;
        IF v_discount_r > 0 THEN
          v_lines := v_lines || jsonb_build_object('account_key', 'discount_received', 'debit', v_discount_r, 'credit', 0);
          v_dr := v_dr + v_discount_r;
        END IF;
        IF v_paid_r > 0 THEN
          v_lines := v_lines || jsonb_build_object('account_key', v_credit_key, 'debit', v_paid_r, 'credit', 0,
            'note', 'مرتجع ' || v_purchase.invoice_number);
          v_dr := v_dr + v_paid_r;
        END IF;
        IF v_ap_r > 0 THEN
          v_lines := v_lines || jsonb_build_object('account_key', 'ap', 'debit', v_ap_r, 'credit', 0,
            'supplier_id', v_purchase.supplier_id, 'note', 'مرتجع ' || v_purchase.invoice_number);
          v_dr := v_dr + v_ap_r;
        END IF;

        v_diff := round(v_dr - v_cr, 2);
        IF v_diff <> 0 THEN
          IF v_diff > 0 THEN
            v_lines := v_lines || jsonb_build_object('account_key', 'discount_received', 'debit', 0, 'credit', v_diff);
          ELSE
            v_lines := v_lines || jsonb_build_object('account_key', 'discount_received', 'debit', -v_diff, 'credit', 0);
          END IF;
        END IF;

        PERFORM public._post_journal_entry(v_purchase.branch_id, 'purchase_return', NULL, v_purchase.invoice_number,
          'مرتجع فاتورة شراء ' || v_purchase.invoice_number, v_lines);
      END IF;
    END IF;

    RETURN jsonb_build_object('success', true, 'purchase_id', p_purchase_id,
      'returned_amount', v_return_total, 'fully_returned', v_all_returned);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRANSACTION_FAILED', 'detail', SQLERRM);
  END;
END;
$function$;

-- 3d. create_purchase_order: finished-goods items only.
CREATE OR REPLACE FUNCTION public.create_purchase_order(
  p_branch_id uuid,
  p_supplier_id uuid,
  p_warehouse_id uuid DEFAULT NULL,
  p_payment_method text DEFAULT 'cash',
  p_notes text DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_quotation_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_purchase_id uuid;
  v_number text;
  v_user_branch uuid;
  v_quote record;
  v_qitem record;
  v_item jsonb;
  v_total numeric(14,2) := 0;
  v_rows integer := 0;
  v_request_id uuid;
BEGIN
  BEGIN
    IF NOT is_pos_admin() AND NOT can_permission('purchases.manage') THEN
      RETURN jsonb_build_object('success', false, 'error', 'NOT_ALLOWED',
        'detail', 'Creating purchase orders requires the purchases.manage permission.');
    END IF;
    IF p_branch_id IS NULL OR p_supplier_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'MISSING_SUPPLIER_BRANCH');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = p_supplier_id AND branch_id = p_branch_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'SUPPLIER_NOT_IN_BRANCH');
    END IF;
    IF NOT is_pos_admin() THEN
      SELECT branch_id INTO v_user_branch FROM public.users WHERE id = auth.uid();
      IF v_user_branch IS NOT NULL AND v_user_branch <> p_branch_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'BRANCH_MISMATCH');
      END IF;
    END IF;

    IF p_quotation_id IS NOT NULL THEN
      SELECT * INTO v_quote FROM public.supplier_quotations WHERE id = p_quotation_id;
      IF v_quote.id IS NULL OR v_quote.status <> 'selected' THEN
        RETURN jsonb_build_object('success', false, 'error', 'QUOTATION_NOT_SELECTED');
      END IF;
      IF v_quote.branch_id <> p_branch_id OR v_quote.supplier_id <> p_supplier_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'QUOTATION_MISMATCH');
      END IF;
      SELECT r.request_id INTO v_request_id FROM public.rfqs r WHERE r.id = v_quote.rfq_id;
    END IF;

    v_number := (public.next_document_number('purchase')->>'number')::text;

    INSERT INTO public.purchases
      (invoice_number, supplier_id, branch_id, warehouse_id, buyer_id,
       subtotal, discount_amount, tax_amount, total, paid_amount, payment_method, status, notes, request_id)
    VALUES (v_number, p_supplier_id, p_branch_id, p_warehouse_id, auth.uid(),
      0, 0, 0, 0, 0, COALESCE(p_payment_method, 'cash'), 'draft', p_notes, v_request_id)
    RETURNING id INTO v_purchase_id;

    IF p_quotation_id IS NOT NULL THEN
      FOR v_qitem IN
        SELECT product_id, quantity, unit_cost
        FROM public.supplier_quotation_items WHERE quotation_id = p_quotation_id
      LOOP
        INSERT INTO public.purchase_items (purchase_id, product_id, unit_name, quantity, unit_cost, total)
        VALUES (v_purchase_id, v_qitem.product_id,
                'piece', v_qitem.quantity, v_qitem.unit_cost,
                round(v_qitem.quantity * v_qitem.unit_cost, 2));
        v_total := v_total + v_qitem.quantity * v_qitem.unit_cost;
        v_rows := v_rows + 1;
      END LOOP;
    ELSIF p_items IS NOT NULL AND jsonb_array_length(p_items) > 0 THEN
      FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
      LOOP
        IF (v_item->>'product_id') IS NULL THEN
          RETURN jsonb_build_object('success', false, 'error', 'ITEM_MISSING_TYPE');
        END IF;
        INSERT INTO public.purchase_items
          (purchase_id, product_id, unit_name, quantity, unit_cost, total)
        VALUES (v_purchase_id,
          NULLIF(v_item->>'product_id', '')::uuid,
          COALESCE(NULLIF(v_item->>'unit_name', ''), 'piece'),
          COALESCE((v_item->>'quantity')::numeric, 0),
          COALESCE((v_item->>'unit_cost')::numeric, 0),
          round(COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'unit_cost')::numeric, 0), 2));
        v_rows := v_rows + 1;
      END LOOP;
    ELSE
      RETURN jsonb_build_object('success', false, 'error', 'EMPTY_ITEMS');
    END IF;

    UPDATE public.purchases SET total = round(v_total, 2), subtotal = round(v_total, 2)
    WHERE id = v_purchase_id;

    IF v_request_id IS NOT NULL THEN
      UPDATE public.purchase_requests SET status = 'ordered'
      WHERE id = v_request_id AND status = 'approved';
    END IF;

    RETURN jsonb_build_object('success', true, 'purchase_id', v_purchase_id,
      'invoice_number', v_number, 'items_added', v_rows);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRANSACTION_FAILED', 'detail', SQLERRM);
  END;
END;
$function$;

-- 3e. receive_purchase_order: finished-goods only (no raw add branch).
CREATE OR REPLACE FUNCTION public.receive_purchase_order(
  p_purchase_id uuid,
  p_receipt_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_purchase record;
  v_receipt_id uuid;
  v_number text;
  v_item jsonb;
  v_pitem record;
  v_qty numeric(14,4);
  v_res jsonb;
  v_stock numeric(14,4);
  v_stock_val numeric(14,2);
  v_new_cost numeric(12,2);
  v_rows integer := 0;
  v_fully_received boolean := false;
  v_goods_fg numeric(14,2) := 0;
  v_paid numeric(14,2);
  v_ap numeric(14,2);
  v_dr numeric(14,2) := 0;
  v_cr numeric(14,2) := 0;
  v_diff numeric(14,2);
  v_lines jsonb := '[]'::jsonb;
  v_user_branch uuid;
BEGIN
  BEGIN
    IF NOT is_pos_admin() AND NOT can_permission('purchases.manage') THEN
      RETURN jsonb_build_object('success', false, 'error', 'NOT_ALLOWED',
        'detail', 'Receiving purchase orders requires the purchases.manage permission.');
    END IF;

    SELECT * INTO v_purchase FROM public.purchases WHERE id = p_purchase_id FOR UPDATE;
    IF v_purchase.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'PURCHASE_NOT_FOUND');
    END IF;
    IF v_purchase.status NOT IN ('approved', 'submitted', 'partial') THEN
      RETURN jsonb_build_object('success', false, 'error', 'INVALID_STATUS',
        'status', v_purchase.status, 'detail', 'Only approved/submitted/partial purchase orders can be received.');
    END IF;

    IF NOT is_pos_admin() THEN
      SELECT branch_id INTO v_user_branch FROM public.users WHERE id = auth.uid();
      IF v_user_branch IS NOT NULL AND v_user_branch <> v_purchase.branch_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'BRANCH_MISMATCH');
      END IF;
    END IF;

    v_number := (public.next_document_number('purchase_receipt')->>'number')::text;

    INSERT INTO public.purchase_receipts
      (receipt_number, purchase_id, branch_id, warehouse_id, received_by, notes)
    VALUES (v_number, p_purchase_id, v_purchase.branch_id, v_purchase.warehouse_id, auth.uid(),
            NULL)
    RETURNING id INTO v_receipt_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_receipt_items)
    LOOP
      v_qty := COALESCE((v_item->>'quantity_received')::numeric, 0);

      SELECT * INTO v_pitem FROM public.purchase_items WHERE id = (v_item->>'purchase_item_id')::uuid;

      INSERT INTO public.purchase_receipt_items (receipt_id, purchase_item_id, quantity_received, unit_cost)
      VALUES (v_receipt_id, v_pitem.id, v_qty, v_pitem.unit_cost);

      IF v_pitem.product_id IS NOT NULL THEN
        IF v_purchase.warehouse_id IS NULL THEN
          RETURN jsonb_build_object('success', false, 'error', 'WAREHOUSE_REQUIRED',
            'detail', 'Select a warehouse to receive product items.');
        END IF;
        v_res := public._product_inv_add(v_pitem.product_id, v_purchase.warehouse_id, v_purchase.branch_id,
          v_qty, v_pitem.unit_cost, NULL, NULL, NULL,
          'purchase', 'purchase', p_purchase_id, v_purchase.invoice_number, auth.uid());
        IF NOT (v_res->>'success')::boolean THEN
          RETURN v_res;
        END IF;

        SELECT COALESCE(SUM(b.quantity), 0), COALESCE(SUM(b.quantity * b.unit_cost), 0)
        INTO v_stock, v_stock_val
        FROM public.inventory_batches b WHERE b.product_id = v_pitem.product_id;
        v_new_cost := CASE WHEN v_stock > 0 THEN round(v_stock_val / v_stock, 2) ELSE v_pitem.unit_cost END;
        UPDATE public.products SET cost_price = v_new_cost, updated_at = now() WHERE id = v_pitem.product_id;

        v_goods_fg := round(v_goods_fg + v_qty * v_pitem.unit_cost, 2);
      END IF;

      UPDATE public.purchase_items
      SET received_quantity = COALESCE(received_quantity, 0) + v_qty
      WHERE id = v_pitem.id;

      v_rows := v_rows + 1;
    END LOOP;

    -- Any remaining ordered quantity means the PO is still on backorder.
    SELECT EXISTS (
      SELECT 1 FROM public.purchase_items
      WHERE purchase_id = p_purchase_id
        AND quantity - COALESCE(received_quantity, 0) > 0
    ) INTO v_fully_received;
    v_fully_received := NOT v_fully_received;

    -- ===== LEDGER POSTING (only when the PO is fully received) =====
    IF v_fully_received THEN
      v_paid := round(COALESCE(v_purchase.paid_amount, 0), 2);
      v_ap := round(COALESCE(v_purchase.total, 0) - v_paid, 2);

      IF v_goods_fg > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_key', 'inventory_fg', 'debit', v_goods_fg, 'credit', 0, 'note', v_purchase.invoice_number);
        v_dr := v_dr + v_goods_fg;
      END IF;
      IF COALESCE(v_purchase.tax_amount, 0) > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_key', 'vat_receivable', 'debit', v_purchase.tax_amount, 'credit', 0);
        v_dr := v_dr + v_purchase.tax_amount;
      END IF;
      IF COALESCE(v_purchase.discount_amount, 0) > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_key', 'discount_received', 'debit', 0, 'credit', v_purchase.discount_amount);
        v_cr := v_cr + v_purchase.discount_amount;
      END IF;
      IF v_paid > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_key', CASE WHEN COALESCE(v_purchase.payment_method, 'cash') = 'cash' THEN 'cash' ELSE 'bank' END,
          'debit', 0, 'credit', v_paid, 'note', v_purchase.invoice_number);
        v_cr := v_cr + v_paid;
      END IF;
      IF v_ap > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_key', 'ap', 'debit', 0, 'credit', v_ap,
          'supplier_id', v_purchase.supplier_id, 'note', v_purchase.invoice_number);
        v_cr := v_cr + v_ap;
      END IF;

      v_diff := round(v_dr - v_cr, 2);
      IF v_diff <> 0 THEN
        IF v_diff > 0 THEN
          v_lines := v_lines || jsonb_build_object('account_key', 'discount_received', 'debit', 0, 'credit', v_diff);
        ELSE
          v_lines := v_lines || jsonb_build_object('account_key', 'discount_received', 'debit', -v_diff, 'credit', 0);
        END IF;
      END IF;

      PERFORM public._post_journal_entry(v_purchase.branch_id, 'purchase', p_purchase_id,
        v_purchase.invoice_number, 'فاتورة شراء ' || v_purchase.invoice_number, v_lines);
    END IF;

    UPDATE public.purchases SET status = CASE WHEN v_fully_received THEN 'completed' ELSE 'partial' END
    WHERE id = p_purchase_id;

    RETURN jsonb_build_object('success', true, 'receipt_id', v_receipt_id,
      'receipt_number', v_number, 'items_received', v_rows,
      'fully_received', v_fully_received, 'status', CASE WHEN v_fully_received THEN 'completed' ELSE 'partial' END);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRANSACTION_FAILED', 'detail', SQLERRM);
  END;
END;
$function$;

-- 3f. get_purchase_backorders: finished-goods only.
CREATE OR REPLACE FUNCTION public.get_purchase_backorders(p_branch_id uuid DEFAULT NULL)
RETURNS TABLE (
  purchase_id      uuid,
  invoice_number   text,
  supplier_id      uuid,
  supplier_name    text,
  purchase_item_id uuid,
  product_id       uuid,
  item_name        text,
  item_type        text,
  unit_name        text,
  ordered_quantity numeric,
  received_quantity numeric,
  remaining        numeric,
  unit_cost        numeric(12,2),
  status           text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $function$
BEGIN
  IF p_branch_id IS NOT NULL AND NOT is_pos_admin()
     AND get_branch_id() IS NOT NULL AND get_branch_id() <> p_branch_id THEN
    RAISE EXCEPTION 'BRANCH_MISMATCH';
  END IF;
  RETURN QUERY
    SELECT
      pc.id, pc.invoice_number, pc.supplier_id, s.name,
      pi.id, pi.product_id,
      COALESCE(NULLIF(btrim(p.name), ''), '?'),
      CASE WHEN pi.product_id IS NOT NULL THEN 'product' ELSE '?' END,
      pi.unit_name, pi.quantity, COALESCE(pi.received_quantity, 0),
      pi.quantity - COALESCE(pi.received_quantity, 0),
      pi.unit_cost, pc.status
    FROM public.purchase_items pi
    JOIN public.purchases pc ON pc.id = pi.purchase_id
    JOIN public.suppliers s ON s.id = pc.supplier_id
    LEFT JOIN public.products p ON p.id = pi.product_id
    WHERE pc.status IN ('approved', 'submitted', 'partial')
      AND pi.product_id IS NOT NULL
      AND pi.quantity - COALESCE(pi.received_quantity, 0) > 0
      AND (p_branch_id IS NULL OR pc.branch_id = p_branch_id)
      AND (is_pos_admin() OR pc.branch_id = get_branch_id())
    ORDER BY pc.created_at ASC;
END;
$function$;

-- 3g. get_rfq_comparison: finished-goods only.
CREATE OR REPLACE FUNCTION public.get_rfq_comparison(p_rfq_id uuid)
RETURNS TABLE (
  item_id            uuid,
  item_type          text,
  item_name          text,
  requested_quantity numeric,
  best_supplier_id   uuid,
  best_supplier_name text,
  best_unit_cost     numeric(12,2),
  avg_unit_cost      numeric(12,2),
  quotation_count    bigint,
  quotations         jsonb
) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $function$
DECLARE
  v_branch uuid;
BEGIN
  SELECT r.branch_id INTO v_branch FROM public.rfqs r WHERE r.id = p_rfq_id;
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'RFQ_NOT_FOUND';
  END IF;
  IF NOT is_pos_admin() AND get_branch_id() <> v_branch THEN
    RAISE EXCEPTION 'BRANCH_MISMATCH';
  END IF;

  RETURN QUERY
    SELECT
      ri.product_id AS item_id,
      'product' AS item_type,
      COALESCE(NULLIF(btrim(p.name), ''), '?') AS item_name,
      ri.quantity AS requested_quantity,
      (array_agg(q.supplier_id ORDER BY ql.unit_cost ASC))[1] AS best_supplier_id,
      (array_agg(s.name ORDER BY ql.unit_cost ASC))[1] AS best_supplier_name,
      (array_agg(ql.unit_cost ORDER BY ql.unit_cost ASC))[1] AS best_unit_cost,
      round(AVG(ql.unit_cost), 2) AS avg_unit_cost,
      COUNT(ql.id) AS quotation_count,
      COALESCE(jsonb_agg(jsonb_build_object(
        'quotation_id', q.id,
        'supplier_id', q.supplier_id,
        'supplier_name', s.name,
        'unit_cost', ql.unit_cost,
        'quotation_number', q.quotation_number,
        'status', q.status
      )), '[]'::jsonb) AS quotations
    FROM public.rfq_items ri
    LEFT JOIN public.products p ON p.id = ri.product_id
    LEFT JOIN public.supplier_quotation_items ql ON ql.product_id IS NOT DISTINCT FROM ri.product_id
    LEFT JOIN public.supplier_quotations q ON q.id = ql.quotation_id
    LEFT JOIN public.suppliers s ON s.id = q.supplier_id
    WHERE ri.rfq_id = p_rfq_id
      AND ri.product_id IS NOT NULL
      AND (q.id IS NULL OR q.status IN ('received', 'selected'))
    GROUP BY ri.id, ri.product_id, ri.quantity, p.name
    ORDER BY 3 ASC;
END;
$function$;

-- 3h. Costing: keep the frontend contract, kill the recipe cost legs.
--     theoretical_cost = component (BOM) cost; actual_cost mirrors it.
CREATE OR REPLACE FUNCTION public.get_costing_overview(
  p_branch_id uuid DEFAULT NULL
) RETURNS TABLE (
  product_id        uuid,
  product_name      text,
  barcode           text,
  sku               text,
  category_name     text,
  product_type      text,
  sale_price        numeric(12,2),
  unit_cost         numeric(12,2),
  theoretical_cost  numeric(12,2),
  actual_cost       numeric(12,2),
  component_count   bigint,
  recipe_item_count bigint
) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $function$
DECLARE
  v_user_branch uuid;
  v_scope uuid;
BEGIN
  IF NOT is_pos_admin() THEN
    SELECT branch_id INTO v_user_branch FROM public.users WHERE id = auth.uid();
    v_scope := v_user_branch;
  ELSE
    v_scope := p_branch_id;
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    COALESCE(NULLIF(btrim(p.name), ''), 'Product'),
    p.barcode,
    p.sku,
    c.name,
    COALESCE(p.product_type, 'ready'),
    COALESCE(p.sale_price, 0)::numeric(12,2),
    COALESCE(public._product_wavg_cost(p.id, v_scope), 0)::numeric(12,2),
    COALESCE(public._product_bom_cost(p.id, v_scope), 0)::numeric(12,2),
    COALESCE(public._product_bom_cost(p.id, v_scope), 0)::numeric(12,2),
    (SELECT COUNT(*) FROM public.product_components pc WHERE pc.product_id = p.id)::bigint,
    0::bigint
  FROM public.products p
  LEFT JOIN public.categories c ON c.id = p.category_id
  WHERE p.is_active = true
    AND (v_scope IS NULL OR p.branch_id = v_scope)
  ORDER BY p.name ASC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_costing_overview(uuid) TO authenticated;

-- 3i. get_product_costing_detail: component/history only, recipe_items = [].
CREATE OR REPLACE FUNCTION public.get_product_costing_detail(
  p_product_id uuid,
  p_branch_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $function$
DECLARE
  v_user_branch uuid;
  v_scope uuid;
  v_row record;
  v_components jsonb;
  v_history jsonb;
BEGIN
  IF NOT is_pos_admin() THEN
    SELECT branch_id INTO v_user_branch FROM public.users WHERE id = auth.uid();
    v_scope := v_user_branch;
  ELSE
    v_scope := p_branch_id;
  END IF;

  SELECT
    p.id, p.name, p.barcode, p.sku,
    COALESCE(p.sale_price, 0) AS sale_price,
    COALESCE(public._product_wavg_cost(p.id, v_scope), 0) AS unit_cost,
    COALESCE(public._product_bom_cost(p.id, v_scope), 0) AS theoretical_cost,
    COALESCE(public._product_bom_cost(p.id, v_scope), 0) AS actual_cost,
    (SELECT COUNT(*) FROM public.product_components pc WHERE pc.product_id = p.id) AS component_count,
    0 AS recipe_item_count
  INTO v_row
  FROM public.products p
  WHERE p.id = p_product_id;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'PRODUCT_NOT_FOUND');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'component_product_id', cp.id,
    'component_name', COALESCE(NULLIF(btrim(cp.name), ''), 'Component'),
    'quantity', pc.quantity,
    'unit_cost', COALESCE(public._product_wavg_cost(pc.component_product_id, v_scope), 0),
    'line_cost', round(pc.quantity * COALESCE(public._product_wavg_cost(pc.component_product_id, v_scope), 0), 2)
  ) ORDER BY cp.name), '[]'::jsonb)
  INTO v_components
  FROM public.product_components pc
  JOIN public.products cp ON cp.id = pc.component_product_id
  WHERE pc.product_id = p_product_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', ch.id,
    'old_cost', ch.old_cost,
    'new_cost', ch.new_cost,
    'changed_at', ch.changed_at,
    'changed_by', COALESCE(NULLIF(btrim(u.username), ''), u.full_name, u.email, ''),
    'source', ch.source
  ) ORDER BY ch.changed_at DESC), '[]'::jsonb)
  INTO v_history
  FROM public.product_cost_history ch
  LEFT JOIN public.users u ON u.id = ch.changed_by
  WHERE ch.product_id = p_product_id;

  RETURN jsonb_build_object(
    'success', true,
    'product_id', v_row.id,
    'product_name', v_row.name,
    'barcode', v_row.barcode,
    'sku', v_row.sku,
    'sale_price', v_row.sale_price,
    'unit_cost', v_row.unit_cost,
    'theoretical_cost', v_row.theoretical_cost,
    'actual_cost', v_row.actual_cost,
    'component_count', v_row.component_count,
    'recipe_item_count', v_row.recipe_item_count,
    'components', v_components,
    'recipe_items', '[]'::jsonb,
    'history', v_history
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_product_costing_detail(uuid, uuid) TO authenticated;

-- 3j. get_supplier_price_impact: finished-goods leg only.
CREATE OR REPLACE FUNCTION public.get_supplier_price_impact(
  p_supplier_id uuid
) RETURNS TABLE (
  item_id          uuid,
  item_type        text,
  item_name        text,
  first_cost       numeric(12,2),
  last_cost        numeric(12,2),
  avg_cost         numeric(12,2),
  change_pct       numeric(10,2),
  purchase_count   bigint,
  last_purchased_at timestamptz
) LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $function$
  SELECT
    p.id,
    'product'::text AS item_type,
    COALESCE(NULLIF(btrim(p.name), ''), 'Product'),
    (array_agg(pi.unit_cost ORDER BY pc.created_at ASC))[1]::numeric(12,2),
    (array_agg(pi.unit_cost ORDER BY pc.created_at DESC))[1]::numeric(12,2),
    round(AVG(pi.unit_cost), 2)::numeric(12,2),
    round(CASE
      WHEN (array_agg(pi.unit_cost ORDER BY pc.created_at ASC))[1] > 0
      THEN ((array_agg(pi.unit_cost ORDER BY pc.created_at DESC))[1] - (array_agg(pi.unit_cost ORDER BY pc.created_at ASC))[1]) * 100.0
        / (array_agg(pi.unit_cost ORDER BY pc.created_at ASC))[1]
      ELSE 0 END, 2)::numeric(10,2),
    COUNT(*)::bigint,
    MAX(pc.created_at)::timestamptz
  FROM public.purchase_items pi
  JOIN public.purchases pc ON pc.id = pi.purchase_id
  JOIN public.products p ON p.id = pi.product_id
  WHERE pc.supplier_id = p_supplier_id
    AND pc.status = 'completed'
    AND pi.product_id IS NOT NULL
  GROUP BY p.id
  ORDER BY 2 ASC, 3 ASC
$function$;

GRANT EXECUTE ON FUNCTION public.get_supplier_price_impact(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Demo-data functions: drop the manufacturing delete paths.
--    (seed_demo_data (050) needs no change - it never seeded raw materials.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_demo_data(p_branch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  n_tr_items    integer := 0;
  n_shift_ops   integer := 0;
  n_sales       integer := 0;
  n_orders      integer := 0;
  n_custs       integer := 0;
  n_prods       integer := 0;
  n_cats        integer := 0;
  n_tables      integer := 0;
  n_areas       integer := 0;
  n_inv         integer := 0;
  n_wh          integer := 0;
BEGIN
  IF NOT is_pos_admin() AND NOT (is_branch_manager() AND get_branch_id() = p_branch_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED');
  END IF;

  DELETE FROM public.warehouse_transfer_items
  WHERE product_id IN (SELECT id FROM public.products WHERE branch_id = p_branch_id AND is_demo);
  GET DIAGNOSTICS n_tr_items = ROW_COUNT;

  DELETE FROM public.shift_operations
  WHERE operation_type = 'sale'
    AND reference_id IN (
      SELECT s.id FROM public.sales s
      WHERE s.branch_id = p_branch_id
        AND (s.customer_id IN (SELECT id FROM public.customers WHERE branch_id = p_branch_id AND is_demo)
             OR s.table_id IN (SELECT id FROM public.dining_tables WHERE branch_id = p_branch_id AND is_demo)
             OR EXISTS (SELECT 1 FROM public.sale_items si
                        WHERE si.sale_id = s.id
                          AND si.product_id IN (SELECT id FROM public.products WHERE branch_id = p_branch_id AND is_demo)))
    );
  GET DIAGNOSTICS n_shift_ops = ROW_COUNT;

  DELETE FROM public.sales WHERE id IN (
    SELECT s.id FROM public.sales s
    WHERE s.branch_id = p_branch_id
      AND (s.customer_id IN (SELECT id FROM public.customers WHERE branch_id = p_branch_id AND is_demo)
           OR s.table_id IN (SELECT id FROM public.dining_tables WHERE branch_id = p_branch_id AND is_demo)
           OR EXISTS (SELECT 1 FROM public.sale_items si
                      WHERE si.sale_id = s.id
                        AND si.product_id IN (SELECT id FROM public.products WHERE branch_id = p_branch_id AND is_demo)))
  );
  GET DIAGNOSTICS n_sales = ROW_COUNT;

  DELETE FROM public.orders WHERE id IN (
    SELECT o.id FROM public.orders o
    WHERE o.branch_id = p_branch_id
      AND (o.table_id IN (SELECT id FROM public.dining_tables WHERE branch_id = p_branch_id AND is_demo)
           OR o.customer_id IN (SELECT id FROM public.customers WHERE branch_id = p_branch_id AND is_demo)
           OR EXISTS (SELECT 1 FROM public.order_items oi
                      WHERE oi.order_id = o.id
                        AND oi.product_id IN (SELECT id FROM public.products WHERE branch_id = p_branch_id AND is_demo)))
  );
  GET DIAGNOSTICS n_orders = ROW_COUNT;

  DELETE FROM public.customers     WHERE branch_id = p_branch_id AND is_demo;
  GET DIAGNOSTICS n_custs = ROW_COUNT;

  DELETE FROM public.products      WHERE branch_id = p_branch_id AND is_demo;
  GET DIAGNOSTICS n_prods = ROW_COUNT;

  DELETE FROM public.categories    WHERE branch_id = p_branch_id AND is_demo;
  GET DIAGNOSTICS n_cats = ROW_COUNT;

  DELETE FROM public.dining_tables WHERE branch_id = p_branch_id AND is_demo;
  GET DIAGNOSTICS n_tables = ROW_COUNT;

  DELETE FROM public.dining_areas  WHERE branch_id = p_branch_id AND is_demo;
  GET DIAGNOSTICS n_areas = ROW_COUNT;

  DELETE FROM public.inventory WHERE warehouse_id IN (
    SELECT id FROM public.warehouses WHERE branch_id = p_branch_id AND is_demo
  );
  GET DIAGNOSTICS n_inv = ROW_COUNT;

  DELETE FROM public.warehouses    WHERE branch_id = p_branch_id AND is_demo;
  GET DIAGNOSTICS n_wh = ROW_COUNT;

  RETURN jsonb_build_object('success', true,
    'transfer_items', n_tr_items, 'shift_operations', n_shift_ops,
    'sales', n_sales, 'orders', n_orders, 'customers', n_custs,
    'products', n_prods, 'categories', n_cats, 'tables', n_tables, 'areas', n_areas,
    'inventory', n_inv, 'warehouses', n_wh);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', 'DELETE_FAILED', 'detail', SQLERRM);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Admin data center: drop the manufacturing section + raw seeding.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_data_delete_section(p_branch_id uuid, p_section text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE v_count bigint := 0; v_total bigint := 0;
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('success', false, 'error', 'SUPER_ADMIN_ONLY'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch_id) THEN RETURN jsonb_build_object('success', false, 'error', 'BRANCH_NOT_FOUND'); END IF;
  CASE p_section
    WHEN 'catalog' THEN
      DELETE FROM public.order_kitchen_sends WHERE branch_id=p_branch_id;
      DELETE FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE branch_id=p_branch_id);
      DELETE FROM public.orders WHERE branch_id=p_branch_id;
      DELETE FROM public.customer_payments WHERE sale_id IN (SELECT id FROM public.sales WHERE branch_id=p_branch_id);
      DELETE FROM public.sale_items WHERE sale_id IN (SELECT id FROM public.sales WHERE branch_id=p_branch_id);
      DELETE FROM public.sales WHERE branch_id=p_branch_id;
      DELETE FROM public.product_cost_history WHERE product_id IN (SELECT id FROM public.products WHERE branch_id=p_branch_id);
      DELETE FROM public.product_components WHERE product_id IN (SELECT id FROM public.products WHERE branch_id=p_branch_id) OR component_product_id IN (SELECT id FROM public.products WHERE branch_id=p_branch_id);
      DELETE FROM public.inventory_batches WHERE branch_id=p_branch_id;
      DELETE FROM public.inventory_ledger WHERE branch_id=p_branch_id;
      DELETE FROM public.stock_transactions WHERE branch_id=p_branch_id;
      DELETE FROM public.inventory WHERE branch_id=p_branch_id;
      DELETE FROM public.product_units WHERE product_id IN (SELECT id FROM public.products WHERE branch_id=p_branch_id);
      DELETE FROM public.products WHERE branch_id=p_branch_id;
      DELETE FROM public.categories WHERE branch_id=p_branch_id;
    WHEN 'customers' THEN
      DELETE FROM public.customer_payments WHERE branch_id=p_branch_id;
      DELETE FROM public.journal_entry_lines WHERE customer_id IN (SELECT id FROM public.customers WHERE branch_id=p_branch_id);
      DELETE FROM public.customers WHERE branch_id=p_branch_id;
    WHEN 'suppliers' THEN
      DELETE FROM public.supplier_quotation_items WHERE quotation_id IN (SELECT id FROM public.supplier_quotations WHERE branch_id=p_branch_id);
      DELETE FROM public.supplier_quotations WHERE branch_id=p_branch_id;
      DELETE FROM public.supplier_payments WHERE branch_id=p_branch_id;
      DELETE FROM public.journal_entry_lines WHERE supplier_id IN (SELECT id FROM public.suppliers WHERE branch_id=p_branch_id);
      DELETE FROM public.suppliers WHERE branch_id=p_branch_id;
    WHEN 'sales' THEN
      DELETE FROM public.shift_operations WHERE operation_type='sale' AND reference_id IN (SELECT id FROM public.sales WHERE branch_id=p_branch_id);
      DELETE FROM public.customer_payments WHERE sale_id IN (SELECT id FROM public.sales WHERE branch_id=p_branch_id);
      DELETE FROM public.sale_items WHERE sale_id IN (SELECT id FROM public.sales WHERE branch_id=p_branch_id);
      DELETE FROM public.sales WHERE branch_id=p_branch_id;
    WHEN 'orders' THEN
      DELETE FROM public.order_kitchen_sends WHERE branch_id=p_branch_id;
      DELETE FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE branch_id=p_branch_id);
      DELETE FROM public.orders WHERE branch_id=p_branch_id;
    WHEN 'purchasing' THEN
      DELETE FROM public.purchase_receipt_items WHERE receipt_id IN (SELECT id FROM public.purchase_receipts WHERE branch_id=p_branch_id);
      DELETE FROM public.purchase_receipts WHERE branch_id=p_branch_id;
      DELETE FROM public.supplier_payments WHERE branch_id=p_branch_id;
      DELETE FROM public.purchase_items WHERE purchase_id IN (SELECT id FROM public.purchases WHERE branch_id=p_branch_id);
      DELETE FROM public.purchases WHERE branch_id=p_branch_id;
      DELETE FROM public.supplier_quotation_items WHERE quotation_id IN (SELECT id FROM public.supplier_quotations WHERE branch_id=p_branch_id);
      DELETE FROM public.supplier_quotations WHERE branch_id=p_branch_id;
      DELETE FROM public.rfq_items WHERE rfq_id IN (SELECT id FROM public.rfqs WHERE branch_id=p_branch_id);
      DELETE FROM public.rfqs WHERE branch_id=p_branch_id;
      DELETE FROM public.purchase_request_items WHERE request_id IN (SELECT id FROM public.purchase_requests WHERE branch_id=p_branch_id);
      DELETE FROM public.purchase_requests WHERE branch_id=p_branch_id;
    WHEN 'accounting' THEN
      DELETE FROM public.bank_statement_lines WHERE reconciliation_id IN (SELECT id FROM public.bank_reconciliations WHERE branch_id=p_branch_id);
      DELETE FROM public.bank_reconciliations WHERE branch_id=p_branch_id;
      DELETE FROM public.journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM public.journal_entries WHERE branch_id=p_branch_id);
      DELETE FROM public.journal_entries WHERE branch_id=p_branch_id;
      DELETE FROM public.treasury_transactions WHERE branch_id=p_branch_id;
      DELETE FROM public.treasury_accounts WHERE branch_id=p_branch_id;
      DELETE FROM public.account_mappings WHERE branch_id=p_branch_id;
      DELETE FROM public.chart_of_accounts WHERE branch_id=p_branch_id AND NOT is_system;
    WHEN 'shifts' THEN
      DELETE FROM public.shift_operations WHERE shift_id IN (SELECT id FROM public.shifts WHERE branch_id=p_branch_id);
      DELETE FROM public.shifts WHERE branch_id=p_branch_id;
    WHEN 'tables' THEN
      DELETE FROM public.dining_tables WHERE branch_id=p_branch_id;
      DELETE FROM public.dining_areas WHERE branch_id=p_branch_id;
    WHEN 'warehouses' THEN
      DELETE FROM public.warehouse_transfer_items WHERE transfer_id IN (SELECT id FROM public.warehouse_transfers WHERE branch_id=p_branch_id);
      DELETE FROM public.warehouse_transfers WHERE branch_id=p_branch_id;
      DELETE FROM public.inventory_batches WHERE branch_id=p_branch_id;
      DELETE FROM public.inventory_ledger WHERE branch_id=p_branch_id;
      DELETE FROM public.stock_transactions WHERE branch_id=p_branch_id;
      DELETE FROM public.inventory WHERE branch_id=p_branch_id;
      DELETE FROM public.warehouses WHERE branch_id=p_branch_id;
    WHEN 'expenses' THEN
      DELETE FROM public.expenses WHERE branch_id=p_branch_id;
    WHEN 'all' THEN
      PERFORM public.admin_data_delete_section(p_branch_id,'orders');
      PERFORM public.admin_data_delete_section(p_branch_id,'sales');
      PERFORM public.admin_data_delete_section(p_branch_id,'purchasing');
      PERFORM public.admin_data_delete_section(p_branch_id,'customers');
      PERFORM public.admin_data_delete_section(p_branch_id,'suppliers');
      PERFORM public.admin_data_delete_section(p_branch_id,'shifts');
      PERFORM public.admin_data_delete_section(p_branch_id,'tables');
      PERFORM public.admin_data_delete_section(p_branch_id,'catalog');
      PERFORM public.admin_data_delete_section(p_branch_id,'warehouses');
      PERFORM public.admin_data_delete_section(p_branch_id,'expenses');
      RETURN jsonb_build_object('success',true,'section','all');
    ELSE RETURN jsonb_build_object('success',false,'error','INVALID_SECTION');
  END CASE;
  RETURN jsonb_build_object('success',true,'section',p_section,'affected',v_total);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success',false,'error','DELETE_FAILED','detail',SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_data_seed_all(p_branch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE
  v_user uuid:=auth.uid(); v_wh uuid; v_product uuid; v_supplier uuid; v_unit uuid;
  v_purchase uuid; v_sale uuid; v_order uuid; v_customer uuid; v_shift uuid; v_cash_account uuid; v_treasury uuid; v_total numeric;
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('success',false,'error','SUPER_ADMIN_ONLY'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id=p_branch_id) THEN RETURN jsonb_build_object('success',false,'error','BRANCH_NOT_FOUND'); END IF;
  PERFORM public.seed_demo_data(p_branch_id);
  SELECT id INTO v_wh FROM public.warehouses WHERE branch_id=p_branch_id ORDER BY is_demo DESC,created_at LIMIT 1;
  SELECT id INTO v_product FROM public.products WHERE branch_id=p_branch_id AND is_demo ORDER BY created_at LIMIT 1;
  SELECT id INTO v_customer FROM public.customers WHERE branch_id=p_branch_id AND is_demo ORDER BY created_at LIMIT 1;
  SELECT id INTO v_supplier FROM public.suppliers WHERE branch_id=p_branch_id AND name='مورد تجريبي' LIMIT 1;
  IF v_supplier IS NULL THEN INSERT INTO public.suppliers(name,name_en,phone,branch_id,is_active,notes) VALUES('مورد تجريبي','Demo Supplier','01000000000',p_branch_id,true,'بيانات تجريبية') RETURNING id INTO v_supplier; END IF;
  IF v_supplier IS NOT NULL AND v_product IS NOT NULL AND v_wh IS NOT NULL THEN
    SELECT id INTO v_purchase FROM public.purchases WHERE branch_id=p_branch_id AND invoice_number='DEMO-PUR-001' LIMIT 1;
    IF v_purchase IS NULL THEN
      INSERT INTO public.purchases(invoice_number,supplier_id,branch_id,warehouse_id,buyer_id,subtotal,total,paid_amount,payment_method,status,notes) VALUES('DEMO-PUR-001',v_supplier,p_branch_id,v_wh,v_user,100,100,100,'cash','completed','بيانات تجريبية') RETURNING id INTO v_purchase;
      INSERT INTO public.purchase_items(purchase_id,product_id,quantity,unit_name,unit_cost,total,received_quantity) VALUES(v_purchase,v_product,10,'piece',10,100,10);
    END IF;
  END IF;
  IF v_product IS NOT NULL AND v_wh IS NOT NULL THEN
    SELECT sale_price INTO v_total FROM public.products WHERE id=v_product;
    SELECT id INTO v_sale FROM public.sales WHERE branch_id=p_branch_id AND invoice_number='DEMO-SALE-001' LIMIT 1;
    IF v_sale IS NULL THEN
      INSERT INTO public.sales(invoice_number,branch_id,warehouse_id,customer_id,cashier_id,salesperson_id,subtotal,total,paid_amount,payment_method,status,order_type,guest_count,notes) VALUES('DEMO-SALE-001',p_branch_id,v_wh,v_customer,v_user,v_user,v_total,v_total,v_total,'cash','completed','takeaway',1,'بيانات تجريبية') RETURNING id INTO v_sale;
      INSERT INTO public.sale_items(sale_id,product_id,quantity,unit_name,unit_price,total) VALUES(v_sale,v_product,1,'piece',v_total,v_total);
    END IF;
  END IF;
  IF v_product IS NOT NULL THEN
    SELECT id INTO v_order FROM public.orders WHERE branch_id=p_branch_id AND order_number='DEMO-ORD-001' LIMIT 1;
    IF v_order IS NULL THEN
      INSERT INTO public.orders(order_number,branch_id,order_type,status,customer_id,cashier_id,guest_count,subtotal,total,notes) VALUES('DEMO-ORD-001',p_branch_id,'takeaway','completed',v_customer,v_user,1,v_total,v_total,'طلب تجريبي') RETURNING id INTO v_order;
      INSERT INTO public.order_items(order_id,product_id,quantity,unit_name,unit_price,total) VALUES(v_order,v_product,1,'piece',v_total,v_total);
    END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.expenses WHERE branch_id=p_branch_id AND description='مصروف تجريبي') THEN INSERT INTO public.expenses(category,description,amount,branch_id,payment_method,expense_date,notes,created_by) VALUES('مصروفات تشغيل','مصروف تجريبي',50,p_branch_id,'cash',CURRENT_DATE,'بيانات تجريبية',v_user); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.shifts WHERE branch_id=p_branch_id AND notes='وردية تجريبية') THEN
    INSERT INTO public.shifts(branch_id,cashier_id,opening_amount,status,notes) VALUES(p_branch_id,v_user,500,'closed','وردية تجريبية') RETURNING id INTO v_shift;
    INSERT INTO public.shift_operations(shift_id,operation_type,amount,payment_method,created_by) VALUES(v_shift,'opening',500,'cash',v_user);
  END IF;
  SELECT id INTO v_cash_account FROM public.chart_of_accounts WHERE branch_id=p_branch_id AND account_type='asset' AND (name ILIKE '%نقد%' OR name_en ILIKE '%cash%') ORDER BY is_system DESC LIMIT 1;
  IF v_cash_account IS NOT NULL THEN
    SELECT id INTO v_treasury FROM public.treasury_accounts WHERE branch_id=p_branch_id AND account_type='cash' LIMIT 1;
    IF v_treasury IS NULL THEN INSERT INTO public.treasury_accounts(branch_id,account_id,account_type,account_name,opening_balance) VALUES(p_branch_id,v_cash_account,'cash','الخزينة التجريبية',500) RETURNING id INTO v_treasury; END IF;
  END IF;
  RETURN jsonb_build_object('success',true,'seeded',true,'section_count',11);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success',false,'error','SEED_FAILED','detail',SQLERRM);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Drop the raw_material_id columns (with their FK/index/check baggage).
-- ---------------------------------------------------------------------------
ALTER TABLE public.purchase_items DROP CONSTRAINT IF EXISTS purchase_items_one_target;
DROP INDEX IF EXISTS public.idx_purchase_items_raw;
ALTER TABLE public.purchase_items DROP COLUMN IF EXISTS raw_material_id;

ALTER TABLE public.purchase_request_items DROP CONSTRAINT IF EXISTS purchase_request_items_one_target;
ALTER TABLE public.purchase_request_items DROP COLUMN IF EXISTS raw_material_id;

ALTER TABLE public.rfq_items DROP CONSTRAINT IF EXISTS rfq_items_one_target;
ALTER TABLE public.rfq_items DROP COLUMN IF EXISTS raw_material_id;

ALTER TABLE public.supplier_quotation_items DROP CONSTRAINT IF EXISTS supplier_quotation_items_one_target;
ALTER TABLE public.supplier_quotation_items DROP COLUMN IF EXISTS raw_material_id;

DROP INDEX IF EXISTS public.idx_inventory_ledger_raw;
ALTER TABLE public.inventory_ledger DROP COLUMN IF EXISTS raw_material_id;

-- ---------------------------------------------------------------------------
-- 7. Drop the subsystem tables (leaf-first; raw_materials last).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.inventory_unit_recipes;
DROP TABLE IF EXISTS public.inventory_unit_productions;
DROP TABLE IF EXISTS public.waste_entries;
DROP TABLE IF EXISTS public.waste_categories;
DROP TABLE IF EXISTS public.production_waste;
DROP TABLE IF EXISTS public.production_orders;
DROP TABLE IF EXISTS public.recipe_items;
DROP TABLE IF EXISTS public.recipes;
DROP TABLE IF EXISTS public.raw_material_movements;
DROP TABLE IF EXISTS public.raw_material_batches;
DROP TABLE IF EXISTS public.raw_material_inventory;
DROP TABLE IF EXISTS public.raw_materials CASCADE;

-- ---------------------------------------------------------------------------
-- 8. Reload the PostgREST schema cache.
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';