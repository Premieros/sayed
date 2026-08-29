import { createClient } from '@supabase/supabase-js';

// SAYED must use its own Supabase project. Never fall back to Premier's database.
const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('SAYED Supabase configuration is missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
}

if (!supabaseUrl.includes('nahptrsihcidcxkjzwdp.supabase.co')) {
  throw new Error(`Invalid SAYED Supabase project: ${supabaseUrl}`);
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
