import { supabase } from '@/api';
import type { KitchenSendItem, KitchenSendResult } from '../types';

// In-flight locks to guarantee idempotency across rapid double-clicks
const activeSendLocks = new Set<string>();

/**
 * Thin client for the authoritative send_to_kitchen RPC.
 *
 * All inventory consumption (recipe / composite-component / direct product
 * deduction) is performed exactly-once inside the SECURITY DEFINER RPC in a
 * single transaction, keyed per order_item on the UNIQUE order_kitchen_sends
 * row. This client only snapshots the unsent (or grown) lines for the printed
 * ticket and relays errors.
 */
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
    const { data, error } = await supabase.rpc('send_to_kitchen', {
      p_order_id: orderId,
      p_sent_by: p.p_sent_by ?? null,
    });

    if (error) {
      return { success: false, error: 'KITCHEN_SEND_FAILED', detail: error.message };
    }

    const result = (data ?? {}) as Record<string, unknown>;

    if (result.success === false) {
      return {
        success: false,
        error: (result.error as string) || 'KITCHEN_SEND_FAILED',
        detail: (result.detail as string) || undefined,
      };
    }

    return {
      success: true,
      order_id: (result.order_id as string) || orderId,
      sent: (result.sent as KitchenSendItem[]) || [],
      items_sent_count: Number(result.items_sent_count) || 0,
      all_sent: Boolean(result.all_sent),
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
