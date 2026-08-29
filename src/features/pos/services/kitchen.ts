import { supabase } from '@/api';
import type { KitchenSendItem, KitchenSendResult } from '../types';
import type { OrderItem, Product, ProductComponent } from '@/lib/types';

// In-flight locks to guarantee idempotency across rapid double-clicks
const activeSendLocks = new Set<string>();

export async function sendOrderToKitchen(p: {
  p_order_id: string;
  p_sent_by?: string | null;
}): Promise<KitchenSendResult> {
  const orderId = p.p_order_id;
  if (!orderId) return { success: false, error: 'NO_ORDER_ID', detail: 'Order ID is required' };

  if (activeSendLocks.has(orderId)) {
    return { success: false, error: 'SEND_IN_PROGRESS', detail: 'Kitchen send is already in progress for this order' };
  }

  activeSendLocks.add(orderId);

  try {
    // 1. Fetch the order details
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();

    if (orderErr || !order) {
      return {
        success: false,
        error: 'ORDER_NOT_FOUND',
        detail: orderErr?.message || 'Order not found',
      };
    }

    const branchId = order.branch_id;

    // 2. Fetch current order items
    const { data: items } = await supabase
      .from('order_items')
      .select('*')
      .eq('order_id', orderId);

    const orderItems = (items as OrderItem[]) || [];
    if (orderItems.length === 0) {
      return { success: true, items_sent_count: 0, all_sent: true, sent: [] };
    }

    // 3. Fetch existing kitchen sends for this order to compute already-sent quantities
    const { data: existingSends } = await supabase
      .from('order_kitchen_sends')
      .select('*')
      .eq('order_id', orderId);

    const sentCountByItemId: Record<string, number> = {};
    for (const send of (existingSends || []) as { order_item_id: string }[]) {
      sentCountByItemId[send.order_item_id] = (sentCountByItemId[send.order_item_id] || 0) + 1;
    }

    // 4. Determine items with unsent remaining quantities
    // Each order item represents a line. If the line was already sent (has a send record),
    // and its quantity hasn't changed, it won't be sent again.
    // If there are newly added items or items with remaining quantity, we process ONLY those.
    const itemsToSend: { item: OrderItem; remainingQty: number }[] = [];

    for (const item of orderItems) {
      const orderedQty = Number(item.quantity) || 0;
      const isAlreadySent = (sentCountByItemId[item.id] || 0) > 0;
      
      if (!isAlreadySent && orderedQty > 0) {
        itemsToSend.push({
          item,
          remainingQty: orderedQty,
        });
      }
    }

    if (itemsToSend.length === 0) {
      return {
        success: true,
        order_id: orderId,
        items_sent_count: 0,
        all_sent: true,
        sent: [],
      };
    }

    // 5. Fetch branch active warehouse for standard stock deduction
    let warehouseId: string | null = null;
    if (branchId) {
      const { data: wh } = await supabase
        .from('warehouses')
        .select('id')
        .eq('branch_id', branchId)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      warehouseId = wh?.id || null;
    }

    // 6. Fetch products information
    const productIds = itemsToSend.map((x) => x.item.product_id).filter(Boolean) as string[];
    const productsMap: Record<string, Product> = {};
    if (productIds.length > 0) {
      const { data: prods } = await supabase.from('products').select('*').in('id', productIds);
      for (const p of (prods || []) as Product[]) productsMap[p.id] = p;
    }

    const newSentItems: KitchenSendItem[] = [];
    const timestamp = new Date().toISOString();
    const isNewAdditionBatch = (existingSends?.length || 0) > 0;

    // 7. Deduct Inventory & Raw Materials Component per Unsent Quantity
    for (const { item, remainingQty } of itemsToSend) {
      if (!item.product_id) continue;
      const prod = productsMap[item.product_id];

      // A. Check for Recipe & Ingredients (Manufacturing / Restaurant Recipe)
      const { data: recipe } = await supabase
        .from('recipes')
        .select('*, recipe_items(*, raw_material:raw_materials(*))')
        .eq('product_id', item.product_id)
        .eq('branch_id', branchId)
        .maybeSingle();

      if (recipe && recipe.recipe_items && Array.isArray(recipe.recipe_items) && recipe.recipe_items.length > 0) {
        const yieldQty = Number(recipe.yield_quantity) || 1;
        const multiplier = remainingQty / yieldQty;

        for (const rItem of recipe.recipe_items) {
          const wastage = Number(rItem.wastage_percent) || 0;
          const rDeduct = Number(rItem.quantity) * multiplier * (1 + wastage / 100);

          // Deduct from raw material inventory
          const { data: rmInv } = await supabase
            .from('raw_material_inventory')
            .select('*')
            .eq('raw_material_id', rItem.raw_material_id)
            .eq('branch_id', branchId)
            .maybeSingle();

          if (rmInv) {
            const updatedQty = Math.max(0, Number(rmInv.quantity) - rDeduct);
            await supabase
              .from('raw_material_inventory')
              .update({ quantity: updatedQty, updated_at: timestamp })
              .eq('id', rmInv.id);
          }

          try {
            await supabase.from('raw_material_movements').insert({
              raw_material_id: rItem.raw_material_id,
              branch_id: branchId,
              movement_type: 'pos_kitchen_consume',
              quantity: -rDeduct,
              reference_id: orderId,
              created_at: timestamp,
            });
          } catch {
            // Best effort logging
          }
        }
      } else {
        // Check secondary product_components if recipe table wasn't populated
        const { data: comps } = await supabase
          .from('product_components')
          .select('*')
          .eq('product_id', item.product_id);

        if (comps && comps.length > 0) {
          for (const comp of comps as ProductComponent[]) {
            const compDeduct = (Number(comp.quantity) || 0) * remainingQty;
            if (compDeduct > 0 && warehouseId) {
              const { data: cInv } = await supabase
                .from('inventory')
                .select('*')
                .eq('product_id', comp.component_product_id)
                .eq('warehouse_id', warehouseId)
                .maybeSingle();

              if (cInv) {
                const newQty = Math.max(0, Number(cInv.quantity) - compDeduct);
                await supabase
                  .from('inventory')
                  .update({ quantity: newQty, updated_at: timestamp })
                  .eq('id', cInv.id);
              }

              try {
                await supabase.from('inventory_movements').insert({
                  product_id: comp.component_product_id,
                  warehouse_id: warehouseId,
                  movement_type: 'pos_kitchen_consume',
                  quantity: -compDeduct,
                  reference_id: orderId,
                  created_at: timestamp,
                });
              } catch {
                // Best effort
              }
            }
          }
        } else if (warehouseId && prod) {
          // B. Direct Product Inventory deduction (Ready / Standard item)
          const { data: inv } = await supabase
            .from('inventory')
            .select('*')
            .eq('product_id', item.product_id)
            .eq('warehouse_id', warehouseId)
            .maybeSingle();

          if (inv) {
            const newQty = Math.max(0, Number(inv.quantity) - remainingQty);
            await supabase
              .from('inventory')
              .update({ quantity: newQty, updated_at: timestamp })
              .eq('id', inv.id);

            try {
              await supabase.from('inventory_movements').insert({
                product_id: item.product_id,
                warehouse_id: warehouseId,
                movement_type: 'pos_kitchen_consume',
                quantity: -remainingQty,
                reference_id: orderId,
                created_at: timestamp,
              });
            } catch {
              // Best effort
            }
          }
        }
      }

      // 8. Record in order_kitchen_sends
      const { data: sendRow } = await supabase
        .from('order_kitchen_sends')
        .insert({
          branch_id: branchId,
          order_id: orderId,
          order_item_id: item.id,
          sent_at: timestamp,
          sent_by: p.p_sent_by || null,
        })
        .select()
        .single();

      newSentItems.push({
        send_id: sendRow?.id || `send_${item.id}_${Date.now()}`,
        order_item_id: item.id,
        product_id: item.product_id,
        product_name: prod?.name || null,
        unit_name: item.unit_name,
        quantity: remainingQty,
        unit_price: Number(item.unit_price) || 0,
        discount_amount: Number(item.discount_amount) || 0,
        bonus_quantity: Number(item.bonus_quantity) || 0,
        total: Number(item.total) || 0,
        notes: item.notes || null,
      });
    }

    // 9. Update order status and dining table if occupied
    try {
      await supabase
        .from('orders')
        .update({
          status: 'open',
          updated_at: timestamp,
          notes: isNewAdditionBatch && order.notes && !order.notes.includes('[تعديل]')
            ? `${order.notes}`
            : order.notes,
        })
        .eq('id', orderId);

      if (order.table_id) {
        await supabase
          .from('dining_tables')
          .update({ status: 'occupied', updated_at: timestamp })
          .eq('id', order.table_id);
      }
    } catch {
      // Best effort
    }

    return {
      success: true,
      order_id: orderId,
      sent: newSentItems,
      items_sent_count: newSentItems.length,
      all_sent: true,
    };
  } catch (err) {
    return {
      success: false,
      error: 'KITCHEN_SEND_FAILED',
      detail: err instanceof Error ? err.message : 'Unknown error during kitchen send',
    };
  } finally {
    activeSendLocks.delete(orderId);
  }
}
