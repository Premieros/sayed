import type { ApiResult } from '../types';
import { rpc } from '../rpc';
import { supabase } from '../client';

export const catalog = {
  replaceProductUnits(p: { p_product_id: string; p_units: unknown }): ApiResult<null> { return rpc('replace_product_units', p); },

  async listInventoryUnits(filters?: { branch_id?: string; unit_type?: string; is_active?: boolean }) {
    let q = supabase.from('inventory_units').select('*').order('name');
    if (filters?.branch_id) q = q.eq('branch_id', filters.branch_id);
    if (filters?.unit_type) q = q.eq('unit_type', filters.unit_type);
    if (filters?.is_active !== undefined) q = q.eq('is_active', filters.is_active);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  },

  async getInventoryUnit(id: string) {
    const { data, error } = await supabase.from('inventory_units').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  },

  async createInventoryUnit(unit: Record<string, unknown>) {
    const { data, error } = await supabase.from('inventory_units').insert(unit).select().single();
    if (error) throw error;
    return data;
  },

  async updateInventoryUnit(id: string, updates: Record<string, unknown>) {
    const { data, error } = await supabase.from('inventory_units').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },

  async deleteInventoryUnit(id: string) {
    const { error } = await supabase.from('inventory_units').delete().eq('id', id);
    if (error) throw error;
  },

  async getProductUnitLinks(product_id: string) {
    const { data, error } = await supabase
      .from('product_unit_links')
      .select('*, unit:inventory_units(*)')
      .eq('product_id', product_id);
    if (error) throw error;
    return data;
  },

  async setProductUnitLinks(product_id: string, links: { unit_id: string; quantity: number }[]) {
    const { error: delErr } = await supabase.from('product_unit_links').delete().eq('product_id', product_id);
    if (delErr) throw delErr;
    if (links.length === 0) return;
    const rows = links.map(l => ({ product_id, unit_id: l.unit_id, quantity: l.quantity }));
    const { error } = await supabase.from('product_unit_links').insert(rows);
    if (error) throw error;
  },

  async listMeasurementUnits() {
    const { data, error } = await supabase.from('measurement_units').select('*').eq('is_active', true).order('name');
    if (error) throw error;
    return data;
  },

  // ─── Kitchen ─────────────────────────────────────────────
  async listKitchenStations() {
    const { data, error } = await supabase.from('kitchen_stations').select('*').order('sort_order');
    if (error) throw error;
    return data;
  },

  async createKitchenStation(station: { code: string; name_ar: string; name_en: string; sort_order?: number }) {
    const { data, error } = await supabase.from('kitchen_stations').insert(station).select().single();
    if (error) throw error;
    return data;
  },

  async updateKitchenStation(id: string, updates: { name_ar?: string; name_en?: string; is_active?: boolean; sort_order?: number }) {
    const { data, error } = await supabase.from('kitchen_stations').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },

  async deleteKitchenStation(id: string) {
    const { error } = await supabase.from('kitchen_stations').delete().eq('id', id);
    if (error) throw error;
  },

  async getKitchenQueue(p_station?: string) {
    const { data, error } = await supabase.rpc('get_kitchen_queue', { p_station: p_station ?? null });
    if (error) throw error;
    return data;
  },

  async routeToStation(p_order_id: string, p_station: string) {
    const { error } = await supabase.rpc('route_to_station', { p_order_id, p_station });
    if (error) throw error;
  },

  async setKitchenStatus(p_order_id: string, p_status: string) {
    const { error } = await supabase.rpc('set_kitchen_status', { p_order_id, p_status });
    if (error) throw error;
  },
};
