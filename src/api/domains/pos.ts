import { supabase } from '@/lib/supabase';
import type { ApiError, ApiResult, SaleItemInput } from '../types';
import type { RpcResult, Shift, OrderType } from '@/lib/types';
import { rpc } from '../rpc';

export const pos = {
  async getActiveShift(p: { p_branch_id: string }): ApiResult<Shift> {
    try {
      const res = await rpc<Shift>('get_active_shift', p);
      if (!res.error && res.data) {
        return res;
      }
    } catch {
      // Fallback below
    }

    try {
      const { data, error } = await supabase
        .from('shifts')
        .select('*')
        .eq('branch_id', p.p_branch_id)
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        return { data: null, error: error as unknown as ApiError };
      }

      if (!data) {
        return { data: null, error: null };
      }

      return {
        data: {
          open: true,
          shift: {
            id: data.id,
            expected: Number(data.expected_amount) || Number(data.opening_amount) || 0,
            opened_at: data.opened_at,
            opening_amount: Number(data.opening_amount) || 0,
          },
        } as unknown as Shift,
        error: null,
      };
    } catch (err) {
      return { data: null, error: err as unknown as ApiError };
    }
  },

  sendToKitchen(p: { p_order_id: string; p_sent_by?: string | null }): ApiResult<RpcResult & { order_id?: string; sent?: unknown[]; items_sent_count?: number; all_sent?: boolean }> { return rpc('send_to_kitchen', p); },
  nextDocumentNumber(p: { p_type: string }): ApiResult<RpcResult> { return rpc('next_document_number', p); },

  async processSale(p: {
    p_invoice_number: string;
    p_branch_id: string;
    p_shift_id: string | null;
    p_warehouse_id: string | null;
    p_customer_id: string | null;
    p_salesperson_id: string | null;
    p_subtotal: number;
    p_discount_amount: number;
    p_discount_type: 'percent' | 'amount';
    p_tax_amount: number;
    p_bonus_amount: number;
    p_total: number;
    p_paid_amount: number;
    p_payment_method: string;
    p_status: string;
    p_items: SaleItemInput[];
    p_order_type?: OrderType;
    p_table_id?: string | null;
    p_order_id?: string | null;
    p_guest_count?: number | null;
  }): ApiResult<RpcResult> {
    try {
      const res = await rpc<RpcResult>('process_sale', p);
      if (!res.error && res.data && res.data.success) {
        return res;
      }
    } catch {
      // Fallback below
    }

    // Resilient Direct Sale Processing Fallback
    try {
      let invNumber = p.p_invoice_number;
      if (!invNumber || invNumber === 'AUTO') {
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        invNumber = `INV-${dateStr}-${Math.floor(1000 + Math.random() * 9000)}`;
      }

      // 1. Determine effective warehouse
      let warehouseId = p.p_warehouse_id;
      if (!warehouseId && p.p_branch_id) {
        const { data: wh } = await supabase
          .from('warehouses')
          .select('id')
          .eq('branch_id', p.p_branch_id)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();
        warehouseId = wh?.id || null;
      }

      const timestamp = new Date().toISOString();

      // 2. Insert Sale record
      const { data: saleData, error: saleError } = await supabase
        .from('sales')
        .insert({
          invoice_number: invNumber,
          branch_id: p.p_branch_id,
          warehouse_id: warehouseId,
          customer_id: p.p_customer_id || null,
          salesperson_id: p.p_salesperson_id || null,
          subtotal: p.p_subtotal,
          discount_amount: p.p_discount_amount,
          discount_type: p.p_discount_type,
          tax_amount: p.p_tax_amount,
          bonus_amount: p.p_bonus_amount,
          total: p.p_total,
          paid_amount: p.p_paid_amount,
          payment_method: p.p_payment_method,
          status: p.p_status || 'completed',
          order_type: p.p_order_type || 'takeaway',
          table_id: p.p_table_id || null,
          created_at: timestamp,
        })
        .select()
        .single();

      if (saleError) {
        return { data: { success: false, error: saleError.message }, error: saleError as unknown as ApiError };
      }

      const saleId = saleData.id;

      // 3. Insert Sale Items and deduct stock/raw materials
      if (p.p_items && p.p_items.length > 0) {
        const itemRows = p.p_items.map((it) => ({
          sale_id: saleId,
          product_id: it.product_id || null,
          unit_name: it.unit_name || 'piece',
          quantity: it.quantity,
          unit_price: it.unit_price,
          discount_amount: it.discount_amount || 0,
          bonus_quantity: it.bonus_quantity || 0,
          total: it.total,
          created_at: timestamp,
        }));

        await supabase.from('sale_items').insert(itemRows);

        // Already-consumed quantities: the kitchen consumed EXACTLY consumed_qty
        // per order line at send time inside send_to_kitchen. A sale on a linked
        // order must therefore deduct only the remainder (exact-once).
        const consumedQtyByProductId: Record<string, number> = {};
        if (p.p_order_id) {
          const { data: sentRows } = await supabase
            .from('order_kitchen_sends')
            .select('consumed_qty, order_items!inner(product_id)')
            .eq('order_id', p.p_order_id);

          for (const s of (sentRows || []) as { consumed_qty?: number | null; order_items?: { product_id: string | null }[] }[]) {
            const pid = s.order_items?.[0]?.product_id;
            if (pid) {
              consumedQtyByProductId[pid] = (consumedQtyByProductId[pid] || 0) + (Number(s.consumed_qty) || 0);
            }
          }
        }

        // Process inventory deduction for items not yet consumed at the kitchen
        for (const it of p.p_items) {
          if (!it.product_id) continue;
          
          const totalSoldQty = (Number(it.quantity) || 0) + (Number(it.bonus_quantity) || 0);
          const alreadyConsumed = consumedQtyByProductId[it.product_id] || 0;
          const qtyToDeduct = Math.max(0, totalSoldQty - alreadyConsumed);
          
          // Consumed quantity no longer counts against any future deduction
          consumedQtyByProductId[it.product_id] = Math.max(0, alreadyConsumed - totalSoldQty);

          if (qtyToDeduct <= 0) {
            // Already fully consumed at kitchen dispatch
            continue;
          }

          if (warehouseId) {
            const { data: inv } = await supabase
              .from('inventory')
              .select('*')
              .eq('product_id', it.product_id)
              .eq('warehouse_id', warehouseId)
              .maybeSingle();

            if (inv) {
              const newQty = Math.max(0, Number(inv.quantity) - qtyToDeduct);
              await supabase
                .from('inventory')
                .update({ quantity: newQty, updated_at: timestamp })
                .eq('id', inv.id);

              try {
                await supabase.from('inventory_movements').insert({
                  product_id: it.product_id,
                  warehouse_id: warehouseId,
                  movement_type: 'sale',
                  quantity: -qtyToDeduct,
                  reference_id: saleId,
                  created_at: timestamp,
                });
              } catch {
                // Best effort
              }
            }
          }
        }
      }

      // 4. Update customer balance if credit sale or customer attached
      if (p.p_customer_id && p.p_total > 0) {
        try {
          const { data: cust } = await supabase
            .from('customers')
            .select('id, balance')
            .eq('id', p.p_customer_id)
            .maybeSingle();

          if (cust) {
            const unpaidAmount = Math.max(0, p.p_total - (p.p_paid_amount || 0));
            if (unpaidAmount > 0) {
              const newBalance = (Number(cust.balance) || 0) + unpaidAmount;
              await supabase
                .from('customers')
                .update({ balance: newBalance, updated_at: timestamp })
                .eq('id', p.p_customer_id);
            }
          }
        } catch {
          // Best effort
        }
      }

      // 5. Insert payment record if payment was received
      if (p.p_paid_amount > 0) {
        try {
          await supabase.from('payments').insert({
            sale_id: saleId,
            branch_id: p.p_branch_id,
            customer_id: p.p_customer_id || null,
            amount: p.p_paid_amount,
            payment_method: p.p_payment_method,
            status: 'completed',
            created_at: timestamp,
          });
        } catch {
          // Best effort
        }
      }

      // 6. Update dining table status if occupied
      if (p.p_table_id) {
        try {
          await supabase
            .from('dining_tables')
            .update({ status: 'vacant', updated_at: timestamp })
            .eq('id', p.p_table_id);
        } catch {
          // Best effort
        }
      }

      // 7. Update order status if order_id was linked
      if (p.p_order_id) {
        try {
          await supabase
            .from('orders')
            .update({ status: 'completed', updated_at: timestamp })
            .eq('id', p.p_order_id);
        } catch {
          // Best effort
        }
      }

      return {
        data: {
          success: true,
          sale_id: saleId,
          invoice_number: invNumber,
        },
        error: null,
      };
    } catch (err) {
      return {
        data: { success: false, error: err instanceof Error ? err.message : 'Sale processing failed' },
        error: null,
      };
    }
  },
};


