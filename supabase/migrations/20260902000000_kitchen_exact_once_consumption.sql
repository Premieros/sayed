-- ============================================================================
-- 20260902000000  Kitchen exact-once inventory consumption (unit store)
-- ----------------------------------------------------------------------------
-- Contract (established by 084 + 20260819xxxx): SALES consume inventory UNITS,
-- not product batches. Every sellable product must resolve to active
-- inventory_units via product_unit_links; process_sale routes each line
-- through deduct_sale_unit_inventory (inventory_unit_batches + entry ledger).
--
-- Historically "Send Kitchen" (048) only produced tickets. Stock was deducted
-- once, at settlement by process_sale, which consumed the full quantity of
-- every line (per the unit link) regardless of what the kitchen had already
-- cooked. The POS fallback (src/api/domains/pos.ts) was the only code that
-- tried to skip already-sent quantities, and only when the RPC failed.
--
-- This migration makes the kitchen the authoritative consumption point:
--
--   * order_kitchen_sends.consumed_qty records how much of each line the
--     kitchen has actually consumed, so settlement deducts ONLY the remainder.
--   * send_to_kitchen (same signature) consumes exactly the not-yet-consumed
--     delta of every order line through the same inventory-unit store that
--     sales use (branch-wide FIFO over inventory_unit_batches), logging
--     inventory_unit_entries as entry_type 'kitchen_consume' scoped to the
--     order. A re-send after resume/re-hold finds delta = 0 and is exactly
--     once. A stock shortage never blocks the kitchen ticket.
--   * set_order_status('cancelled') returns whatever the kitchen consumed
--     (ground truth = inventory_unit_entries 'kitchen_consume' rows) before
--     closing the order.
--   * process_sale routes each line through deduct_sale_unit_inventory but
--     passes only the real remainder (quantity + bonus - consumed_qty).
--
-- Signatures are unchanged, so all existing grants/callers keep working; the
-- functions are CREATE OR REPLACE replacements of the 048 definitions.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- consumed_qty on order_kitchen_sends
-- ---------------------------------------------------------------------------
ALTER TABLE public.order_kitchen_sends
  ADD COLUMN IF NOT EXISTS consumed_qty numeric(14,4) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- send_to_kitchen: snapshot + consume (unit store, lenient) exactly-once
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_to_kitchen(
  p_order_id uuid,
  p_sent_by uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_branch_id uuid;
  v_status text;
  v_order_number text;
  v_user_branch uuid;
  v_line record;
  v_u record;
  v_batch record;
  v_need numeric(14,4);
  v_take numeric(14,4);
  v_sent jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_all_sent boolean := false;
BEGIN
  BEGIN
    SELECT branch_id, status, order_number INTO v_branch_id, v_status, v_order_number
    FROM public.orders WHERE id = p_order_id;
    IF v_branch_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'ORDER_NOT_FOUND');
    END IF;
    IF v_status NOT IN ('open', 'held') THEN
      RETURN jsonb_build_object('success', false, 'error', 'ORDER_NOT_EDITABLE',
        'detail', 'Only open or held orders can be sent to the kitchen.');
    END IF;

    SELECT branch_id INTO v_user_branch FROM public.users WHERE id = auth.uid();
    IF NOT is_pos_admin() AND COALESCE(v_user_branch, '00000000-0000-0000-0000-000000000000'::uuid) <> v_branch_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'BRANCH_MISMATCH');
    END IF;

    -- Snapshot ONLY lines without a send row yet. order_item_id UNIQUE means
    -- even a concurrent double-send can never create a duplicate; brand-new
    -- rows start at consumed_qty = 0.
    INSERT INTO public.order_kitchen_sends (branch_id, order_id, order_item_id, sent_by)
    SELECT v_branch_id, p_order_id, oi.id, COALESCE(p_sent_by, auth.uid())
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND NOT EXISTS (
        SELECT 1 FROM public.order_kitchen_sends s
        WHERE s.order_item_id = oi.id
      )
    ON CONFLICT (order_item_id) DO NOTHING;

    -- Consumption plan: every line whose current quantity exceeds what the
    -- kitchen already consumed. Covers brand-new lines (delta = qty + bonus)
    -- AND in-place quantity growth after resume/re-hold (069). Lines that were
    -- sent before are already fully consumed -> delta = 0 -> no-op.
    CREATE TEMP TABLE IF NOT EXISTS _kct (
      order_item_id uuid PRIMARY KEY,
      send_qty numeric(14,4),
      delta numeric(14,4)
    ) ON COMMIT DROP;
    TRUNCATE _kct;

    INSERT INTO _kct (order_item_id, send_qty, delta)
    SELECT s.order_item_id,
           COALESCE(oi.quantity, 0) + COALESCE(oi.bonus_quantity, 0),
           GREATEST(0, COALESCE(oi.quantity, 0) + COALESCE(oi.bonus_quantity, 0) - COALESCE(s.consumed_qty, 0))
    FROM public.order_kitchen_sends s
    JOIN public.order_items oi ON oi.id = s.order_item_id
    WHERE s.order_id = p_order_id;

    -- Consume each line's delta FIFO from inventory_unit_batches, branch-wide
    -- (same unit store the sale path uses), and emit the ticket rows. A stock
    -- shortage never blocks the kitchen ticket - cooking continues; the unit
    -- entries record exactly what was removed and cancellation restores it.
    FOR v_line IN
      SELECT k.order_item_id, k.send_qty, k.delta,
             s.id AS send_id, oi.product_id, oi.unit_name, oi.quantity,
             oi.unit_price, oi.discount_amount, oi.bonus_quantity, oi.total,
             oi.notes, p.name AS product_name
      FROM _kct k
      JOIN public.order_kitchen_sends s ON s.order_item_id = k.order_item_id
      JOIN public.order_items oi ON oi.id = k.order_item_id
      LEFT JOIN public.products p ON p.id = oi.product_id
      WHERE k.delta > 0
      ORDER BY oi.created_at, oi.id
    LOOP
      IF v_line.product_id IS NOT NULL THEN
        FOR v_u IN
          SELECT pul.unit_id,
                 (v_line.delta * pul.quantity)::numeric(14,4) AS required
          FROM public.product_unit_links pul
          JOIN public.inventory_units iu ON iu.id = pul.unit_id
          WHERE pul.product_id = v_line.product_id
            AND iu.branch_id = v_branch_id
            AND iu.is_active = true
        LOOP
          v_need := v_u.required;
          FOR v_batch IN
            SELECT id, quantity, unit_cost, warehouse_id, batch_number
            FROM public.inventory_unit_batches
            WHERE unit_id = v_u.unit_id AND branch_id = v_branch_id AND quantity > 0
            ORDER BY created_at ASC, id ASC
          LOOP
            EXIT WHEN v_need <= 0;
            v_take := LEAST(v_need, v_batch.quantity);
            UPDATE public.inventory_unit_batches
            SET quantity = quantity - v_take
            WHERE id = v_batch.id;

            INSERT INTO public.inventory_unit_entries
              (unit_id, branch_id, warehouse_id, quantity, unit_cost,
               entry_type, reference_type, reference_id, reference_number,
               batch_number, created_by)
            VALUES
              (v_u.unit_id, v_branch_id, v_batch.warehouse_id, -v_take, v_batch.unit_cost,
               'kitchen_consume', 'order', p_order_id, v_order_number,
               v_batch.batch_number, auth.uid());

            v_need := v_need - v_take;
          END LOOP;
        END LOOP;
      END IF;

      UPDATE public.order_kitchen_sends
      SET consumed_qty = v_line.send_qty
      WHERE id = v_line.send_id;

      v_count := v_count + 1;
      v_sent := v_sent || jsonb_build_object(
        'send_id', v_line.send_id,
        'order_item_id', v_line.order_item_id,
        'product_id', v_line.product_id,
        'product_name', v_line.product_name,
        'unit_name', v_line.unit_name,
        'quantity', v_line.quantity,
        'unit_price', v_line.unit_price,
        'discount_amount', v_line.discount_amount,
        'bonus_quantity', v_line.bonus_quantity,
        'total', v_line.total,
        'notes', v_line.notes);
    END LOOP;

    SELECT NOT EXISTS (
      SELECT 1 FROM public.order_items oi
      WHERE oi.order_id = p_order_id
        AND NOT EXISTS (
          SELECT 1 FROM public.order_kitchen_sends s
          WHERE s.order_item_id = oi.id
        )
    ) INTO v_all_sent;

    RETURN jsonb_build_object('success', true,
      'order_id', p_order_id,
      'sent', v_sent,
      'items_sent_count', v_count,
      'all_sent', v_all_sent);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRANSACTION_FAILED', 'detail', SQLERRM);
  END;
END;
$function$;

-- ---------------------------------------------------------------------------
-- set_order_status: return kitchen-consumed stock when an order is cancelled
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_order_status(p_order_id uuid, p_status text, p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_branch_id uuid;
  v_table_id uuid;
  v_status text;
  v_user_branch uuid;
  v_rev record;
BEGIN
  BEGIN
    IF p_status NOT IN ('open', 'held', 'completed', 'cancelled') THEN
      RETURN jsonb_build_object('success', false, 'error', 'INVALID_STATUS');
    END IF;

    SELECT branch_id, table_id, status INTO v_branch_id, v_table_id, v_status
    FROM public.orders WHERE id = p_order_id;
    IF v_branch_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'ORDER_NOT_FOUND');
    END IF;

    -- A settled/cancelled order is terminal: reopening it after a sale has
    -- posted would desync stock and accounting (H4).
    IF v_status IN ('completed', 'cancelled') AND p_status IN ('open', 'held') THEN
      RETURN jsonb_build_object('success', false, 'error', 'ORDER_CLOSED',
        'detail', 'Completed or cancelled orders cannot be reopened.');
    END IF;

    SELECT branch_id INTO v_user_branch FROM public.users WHERE id = auth.uid();
    IF NOT is_pos_admin() AND COALESCE(v_user_branch, '00000000-0000-0000-0000-000000000000'::uuid) <> v_branch_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'BRANCH_MISMATCH');
    END IF;

    -- Cancelling an already-sent order returns the units the kitchen consumed,
    -- using the exact amounts and unit costs actually removed (the
    -- inventory_unit_entries 'kitchen_consume' rows are ground truth, grouped
    -- per unit + warehouse). Idempotent by construction: a closed order cannot
    -- be reopened, so this leg only ever runs once.
    IF p_status = 'cancelled' AND v_status IN ('open', 'held') THEN
      FOR v_rev IN
        SELECT e.unit_id, e.warehouse_id, e.branch_id,
               SUM(e.quantity)::numeric(14,4) AS total_qty,
               CASE WHEN SUM(e.quantity) <> 0
                    THEN round(SUM(e.quantity * COALESCE(e.unit_cost, 0)) / SUM(e.quantity), 4)
                    ELSE 0 END AS avg_cost
        FROM public.inventory_unit_entries e
        WHERE e.reference_id = p_order_id
          AND e.reference_type = 'order'
          AND e.entry_type = 'kitchen_consume'
        GROUP BY e.unit_id, e.warehouse_id, e.branch_id
      LOOP
        IF v_rev.total_qty < 0 THEN
          INSERT INTO public.inventory_unit_batches
            (unit_id, branch_id, warehouse_id, quantity, unit_cost)
          VALUES
            (v_rev.unit_id, v_rev.branch_id, v_rev.warehouse_id, -v_rev.total_qty, v_rev.avg_cost);

          INSERT INTO public.inventory_unit_entries
            (unit_id, branch_id, warehouse_id, quantity, unit_cost,
             entry_type, reference_type, reference_id, created_by)
          VALUES
            (v_rev.unit_id, v_rev.branch_id, v_rev.warehouse_id, -v_rev.total_qty, v_rev.avg_cost,
             'kitchen_unconsume', 'order', p_order_id, auth.uid());
        END IF;
      END LOOP;
    END IF;

    UPDATE public.orders SET status = p_status, updated_at = now(),
      completed_at = CASE WHEN p_status IN ('completed', 'cancelled') THEN now() ELSE NULL END,
      notes = COALESCE(p_notes, notes)
    WHERE id = p_order_id;

    IF v_table_id IS NOT NULL THEN
      UPDATE public.dining_tables SET status =
        CASE WHEN p_status IN ('completed', 'cancelled') THEN 'vacant' ELSE 'occupied' END,
        updated_at = now()
      WHERE id = v_table_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'order_id', p_order_id, 'status', p_status);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRANSACTION_FAILED', 'detail', SQLERRM);
  END;
END;
$function$;

-- ---------------------------------------------------------------------------
-- process_sale: deduct only the not-yet-kitchen-consumed remainder (units)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_sale(p_invoice_number text, p_branch_id uuid, p_warehouse_id uuid, p_customer_id uuid, p_salesperson_id uuid, p_subtotal numeric, p_discount_amount numeric, p_discount_type text, p_tax_amount numeric, p_bonus_amount numeric, p_total numeric, p_paid_amount numeric, p_payment_method text, p_status text, p_items jsonb, p_shift_id uuid DEFAULT NULL::uuid, p_order_type text DEFAULT 'takeaway', p_table_id uuid DEFAULT NULL::uuid, p_order_id uuid DEFAULT NULL::uuid, p_guest_count integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sale_id uuid;
  v_user_branch uuid;
  v_role text;
  v_shift_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_quantity numeric(14,4);
  v_unit_price numeric(12,2);
  v_discount_amount numeric(14,2);
  v_bonus_quantity numeric(14,4);
  v_item_total numeric(14,2);
  v_res jsonb;
  v_cogs_total numeric(14,2) := 0;
  v_consumed numeric(14,4) := 0;
  v_net numeric(14,4) := 0;
  v_subtotal numeric(14,2) := 0;
  v_discount numeric(14,2);
  v_tax numeric(14,2) := 0;
  v_tax_enabled boolean;
  v_tax_rate numeric(14,2);
  v_total numeric(14,2);
  v_paid numeric(14,2);
  v_ar numeric(14,2);
  v_lines jsonb := '[]'::jsonb;
  v_dr numeric(14,2) := 0;
  v_cr numeric(14,2) := 0;
  v_diff numeric(14,2);
  v_balance_account text;
  v_order_table uuid;
BEGIN
  BEGIN
    IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'EMPTY_CART');
    END IF;

    -- Subscription gate: only super_admin may sell on an expired / non-active
    -- subscription. Owners manage plans from the console but do not bypass.
    IF NOT EXISTS (
      SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'
    ) AND public.subscription_expired(p_branch_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'SUBSCRIPTION_EXPIRED',
        'subscription', public.subscription_status(p_branch_id));
    END IF;

    SELECT role, branch_id INTO v_role, v_user_branch FROM public.users WHERE id = auth.uid();

    -- Branch isolation (mirror of RLS on sales)
    IF NOT is_pos_admin() THEN
      IF v_user_branch IS NOT NULL AND v_user_branch <> p_branch_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'BRANCH_MISMATCH');
      END IF;
    END IF;

    -- Origin table must belong to the sale branch
    IF p_table_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.dining_tables WHERE id = p_table_id AND branch_id = p_branch_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'TABLE_NOT_IN_BRANCH', 'table_id', p_table_id);
    END IF;

    -- Shift enforcement for register operators
    IF v_role = 'cashier' AND NOT is_pos_admin() THEN
      IF p_shift_id IS NULL THEN
        SELECT id INTO v_shift_id
        FROM shifts
        WHERE cashier_id = auth.uid() AND branch_id = p_branch_id AND status = 'open'
        ORDER BY opened_at DESC LIMIT 1;
      ELSE
        IF NOT EXISTS (
          SELECT 1 FROM shifts
          WHERE id = p_shift_id AND cashier_id = auth.uid() AND branch_id = p_branch_id AND status = 'open'
        ) THEN
          RETURN jsonb_build_object('success', false, 'error', 'NO_OPEN_SHIFT',
            'detail', 'Open a shift before selling. The sale was not created.');
        END IF;
        v_shift_id := p_shift_id;
      END IF;

      IF v_shift_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'NO_OPEN_SHIFT',
          'detail', 'Open a shift before selling. The sale was not created.');
      END IF;
    END IF;

    -- ===== VALIDATE the linked order BEFORE any writes =====
    -- FOUND (not the table value) is what matters: a held takeaway/delivery
    -- order legitimately has table_id = NULL and must still be payable. Any
    -- RETURN here is safe because nothing has been written yet.
    IF p_order_id IS NOT NULL THEN
      SELECT table_id INTO v_order_table
      FROM public.orders
      WHERE id = p_order_id AND branch_id = p_branch_id AND status IN ('open', 'held');

      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'ORDER_NOT_FOUND',
          'detail', 'The order must exist, belong to this branch, and be open or held. No sale was created.');
      END IF;
    END IF;

    -- ===== VALIDATION PHASE: check every item BEFORE writing anything =====
    -- (stock/unit availability is enforced atomically inside
    -- deduct_sale_unit_inventory during the deduction phase)
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_product_id := (v_item->>'product_id')::uuid;
      v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
      IF v_quantity <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_QUANTITY', 'product_id', v_product_id);
      END IF;

      IF NOT EXISTS (SELECT 1 FROM products WHERE id = v_product_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'PRODUCT_NOT_FOUND', 'product_id', v_product_id);
      END IF;

      -- Branch ownership: the product must belong to the sale branch
      IF NOT EXISTS (
        SELECT 1 FROM products WHERE id = v_product_id AND branch_id = p_branch_id
      ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'PRODUCT_NOT_IN_BRANCH',
          'product_id', v_product_id, 'branch_id', p_branch_id);
      END IF;

      -- Accumulate the authoritative subtotal (catalog price, clamped discount)
      SELECT COALESCE(sale_price, 0) INTO v_unit_price FROM products WHERE id = v_product_id;
      v_unit_price := COALESCE(v_unit_price, 0);
      IF v_discount_amount > v_quantity * v_unit_price THEN
        v_discount_amount := v_quantity * v_unit_price;
      END IF;
      v_subtotal := v_subtotal + ROUND(v_quantity * v_unit_price - v_discount_amount, 2);
    END LOOP;

    -- ===== SERVER-SIDE HEADER TOTALS (computed from authoritative prices) =====
    v_discount := GREATEST(COALESCE(p_discount_amount, 0), 0);
    IF v_discount > v_subtotal THEN v_discount := v_subtotal; END IF;
    SELECT COALESCE(tax_enabled, false), COALESCE(tax_rate, 0) INTO v_tax_enabled, v_tax_rate
    FROM public.settings LIMIT 1;
    IF v_tax_enabled THEN
      v_tax := ROUND((v_subtotal - v_discount) * v_tax_rate / 100, 2);
    END IF;
    v_total := ROUND(v_subtotal - v_discount + v_tax, 2);
    v_paid := ROUND(GREATEST(COALESCE(p_paid_amount, 0), 0), 2);
    v_ar := ROUND(GREATEST(v_total - v_paid, 0), 2);

    -- ===== WRITE PHASE 1: sale header (authoritative totals) =====
    INSERT INTO sales (invoice_number, branch_id, warehouse_id, customer_id, cashier_id, salesperson_id,
      subtotal, discount_amount, discount_type, tax_amount, bonus_amount, total, paid_amount, payment_method, status, order_type, table_id, guest_count)
    VALUES (p_invoice_number, p_branch_id, p_warehouse_id, p_customer_id, auth.uid(), p_salesperson_id,
      v_subtotal, v_discount, p_discount_type, v_tax, COALESCE(p_bonus_amount, 0),
      v_total, v_paid, p_payment_method, p_status, COALESCE(p_order_type, 'takeaway'), p_table_id, p_guest_count)
    RETURNING id INTO v_sale_id;

    -- ===== WRITE PHASE 2: items + FIFO unit deduction + ledger =====
    -- Only the not-yet-kitchen-consumed remainder of the linked order is
    -- deducted here; everything already consumed by send_to_kitchen is left
    -- untouched so stock & COGS are exact-once.
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_product_id := (v_item->>'product_id')::uuid;
      v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
      v_discount_amount := GREATEST(COALESCE((v_item->>'discount_amount')::numeric, 0), 0);

      SELECT sale_price INTO v_unit_price FROM products WHERE id = v_product_id;
      v_unit_price := COALESCE(v_unit_price, 0);
      IF v_discount_amount > v_quantity * v_unit_price THEN
        v_discount_amount := v_quantity * v_unit_price;
      END IF;
      v_bonus_quantity := COALESCE((v_item->>'bonus_quantity')::numeric, 0);
      v_item_total := ROUND(v_quantity * v_unit_price - v_discount_amount, 2);

      INSERT INTO sale_items (sale_id, product_id, unit_name, quantity, unit_price, discount_amount, bonus_quantity, total)
      VALUES (v_sale_id, v_product_id, COALESCE(v_item->>'unit_name', 'piece'),
        v_quantity, v_unit_price, v_discount_amount, v_bonus_quantity, v_item_total);

      v_consumed := 0;
      IF p_order_id IS NOT NULL THEN
        SELECT COALESCE(SUM(COALESCE(s.consumed_qty, 0)), 0) INTO v_consumed
        FROM public.order_kitchen_sends s
        JOIN public.order_items oi2 ON oi2.id = s.order_item_id
        WHERE oi2.order_id = p_order_id AND oi2.product_id = v_product_id;
      END IF;
      v_net := GREATEST(0, v_quantity + v_bonus_quantity - v_consumed);

      IF v_net > 0 THEN
        v_res := public.deduct_sale_unit_inventory(
          p_branch_id,
          p_warehouse_id,
          jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', v_net)),
          v_sale_id,
          p_invoice_number
        );
        IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
          RAISE EXCEPTION 'UNIT_SALE_DEDUCTION_FAILED: %',
            COALESCE(v_res->>'detail', v_res->>'error', 'unknown');
        END IF;
        v_cogs_total := v_cogs_total + COALESCE((v_res->>'total_cost')::numeric, 0);
      END IF;
    END LOOP;

    -- ===== WRITE PHASE 2b: settle the linked order + free tables atomically =====
    -- H4: only free a table when NO other open/held order still references it.
    -- H3: a direct dine-in sale (no linked order) frees its origin table here,
    --     inside the sale transaction, instead of client-side afterwards.
    IF p_order_id IS NOT NULL THEN
      UPDATE public.orders SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE id = p_order_id;
      -- NULL table (held takeaway/delivery) has no table to free.
      IF v_order_table IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.orders
        WHERE table_id = v_order_table AND status IN ('open', 'held') AND id <> p_order_id
      ) THEN
        UPDATE public.dining_tables SET status = 'vacant', updated_at = now()
        WHERE id = v_order_table;
      END IF;
    ELSIF p_table_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.orders
      WHERE table_id = p_table_id AND status IN ('open', 'held')
    ) THEN
      UPDATE public.dining_tables SET status = 'vacant', updated_at = now()
      WHERE id = p_table_id;
    END IF;

    -- ===== WRITE PHASE 3: log the sale into the active shift =====
    IF v_shift_id IS NOT NULL THEN
      INSERT INTO shift_operations (shift_id, operation_type, amount, payment_method, reference_type, reference_id, created_by)
      VALUES (v_shift_id, 'sale', v_paid, p_payment_method, 'sale', v_sale_id, auth.uid());
    END IF;

    -- ===== WRITE PHASE 4: post the sales + COGS journal entry =====
    IF v_paid > 0 THEN
      v_balance_account := CASE WHEN COALESCE(p_payment_method, 'cash') = 'cash' THEN 'cash' ELSE 'bank' END;
      v_lines := v_lines || jsonb_build_object('account_key', v_balance_account,
        'debit', v_paid, 'credit', 0, 'note', p_invoice_number);
      v_dr := v_dr + v_paid;
    END IF;
    IF v_ar > 0 THEN
      v_lines := v_lines || jsonb_build_object('account_key', 'ar',
        'debit', v_ar, 'credit', 0, 'customer_id', p_customer_id, 'note', p_invoice_number);
      v_dr := v_dr + v_ar;
    END IF;
    IF v_discount > 0 THEN
      v_lines := v_lines || jsonb_build_object('account_key', 'discount_given', 'debit', v_discount, 'credit', 0);
      v_dr := v_dr + v_discount;
    END IF;
    IF v_subtotal > 0 THEN
      v_lines := v_lines || jsonb_build_object('account_key', 'revenue', 'debit', 0, 'credit', v_subtotal);
      v_cr := v_cr + v_subtotal;
    END IF;
    IF v_tax > 0 THEN
      v_lines := v_lines || jsonb_build_object('account_key', 'vat_payable', 'debit', 0, 'credit', v_tax);
      v_cr := v_cr + v_tax;
    END IF;
    IF v_cogs_total > 0 THEN
      v_lines := v_lines || jsonb_build_object('account_key', 'cogs', 'debit', v_cogs_total, 'credit', 0);
      v_lines := v_lines || jsonb_build_object('account_key', 'inventory_fg', 'debit', 0, 'credit', v_cogs_total);
      v_dr := v_dr + v_cogs_total;
      v_cr := v_cr + v_cogs_total;
    END IF;

    -- Balance any rounding/frontend discrepancy on the discount account so a
    -- posted entry is always balanced (normally the difference is zero).
    v_diff := round(v_dr - v_cr, 2);
    IF v_diff <> 0 THEN
      IF v_diff > 0 THEN
        v_lines := v_lines || jsonb_build_object('account_key', 'discount_given', 'debit', 0, 'credit', v_diff);
      ELSE
        v_lines := v_lines || jsonb_build_object('account_key', 'discount_given', 'debit', -v_diff, 'credit', 0);
      END IF;
    END IF;

    PERFORM public._post_journal_entry(p_branch_id, 'sale', v_sale_id, p_invoice_number,
      'فاتورة مبيعات ' || p_invoice_number, v_lines);

    RETURN jsonb_build_object('success', true, 'sale_id', v_sale_id, 'invoice_number', p_invoice_number,
      'cogs', v_cogs_total);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'UNIT_SALE_DEDUCTION_FAILED%' OR SQLERRM LIKE 'INSUFFICIENT_UNIT_STOCK%' THEN
      RETURN jsonb_build_object('success', false, 'error', 'INSUFFICIENT_STOCK', 'detail', SQLERRM);
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'TRANSACTION_FAILED', 'detail', SQLERRM);
  END;
END;
$function$;

NOTIFY pgrst, 'reload schema';