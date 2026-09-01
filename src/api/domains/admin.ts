import type { ApiResult } from '../types';
import type { RpcResult } from '@/lib/types';
import { rpc } from '../rpc';

export const admin = {
  createUser(p: { p_email: string; p_password: string; p_full_name: string; p_role: string; p_branch_id: string | null; p_is_active: boolean; p_username: string }): ApiResult<RpcResult> { return rpc('create_user', p); },
  updateUserPassword(p: { p_user_id: string; p_new_password: string }): ApiResult<null> { return rpc('update_user_password', p); },
  deleteUser(p: { p_user_id: string }): ApiResult<null> { return rpc('delete_user', p); },
  getLoginEmail(p: { p_username: string }): ApiResult<{ success?: boolean; email?: string; error?: string }> { return rpc('get_login_email', p); },
  recordLoginFailure(p: { p_username: string }): ApiResult<{ success?: boolean }> { return rpc('record_login_failure', p); },
  recordLoginSuccess(p: { p_user_id: string }): ApiResult<{ success?: boolean; error?: string }> { return rpc('record_login_success', p); },
  seedDemoData(p: { p_branch_id: string }): ApiResult<RpcResult & { seeded?: number; existing?: boolean; products?: number; customers?: number; tables?: number }> { return rpc('seed_demo_data', p); },
  deleteDemoData(p: { p_branch_id: string }): ApiResult<RpcResult & { orders?: number; sales?: number; customers?: number; products?: number; tables?: number }> { return rpc('delete_demo_data', p); },
  deleteDataSection(p: { p_branch_id: string; p_section: string }): ApiResult<RpcResult & { affected?: number; section?: string }> { return rpc('admin_data_delete_section', p); },
  seedAllDemoData(p: { p_branch_id: string }): ApiResult<RpcResult & { seeded?: boolean; section_count?: number }> { return rpc('admin_data_seed_all', p); },
  registerTenant(p: {
    p_store_name: string;
    p_owner_name: string;
    p_email: string;
    p_password: string;
    p_store_name_en?: string | null;
    p_phone?: string | null;
    p_address?: string | null;
    p_currency?: string | null;
  }): ApiResult<RpcResult & { organization_id?: string; branch_id?: string; warehouse_id?: string; user_id?: string; membership_role?: string; success?: boolean; error?: string }> {
    return rpc('register_tenant', p);
  },
  getSystemSettings(p: { p_key?: string }): ApiResult<{ key: string; value: unknown; updated_at?: string } | { key: string; value: unknown; updated_at?: string }[]> {
    return rpc('get_system_settings', p);
  },
  setSystemSetting(p: { p_key: string; p_value: unknown }): ApiResult<{ key: string; value: unknown; success?: boolean; error?: string }> {
    return rpc('set_system_setting', p);
  },
  canCreateNewUser(p: { p_branch_id?: string | null; p_tenant_id?: string | null }): ApiResult<{ allowed: boolean; reason?: string; message?: string; current?: number; limit?: number }> {
    return rpc('can_create_new_user', p);
  },
};