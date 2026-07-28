// ── Supabase client for the Brace app ──────────────────────────────────────
// Project: "Brace" (eu-west-2). The anon key is public by design — Row Level
// Security on the `sessions`/`profiles` tables and the private `clips` bucket
// is what protects data, so it's safe to ship in the client.
//
// The URL and key live in supabase-config.js so the portal can read them
// without importing this file, which would stand up a second auth client.
import { createClient } from '../assets/vendor/supabase-client.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { boundedLock } from './supabase-lock.js';

export { SUPABASE_URL, SUPABASE_ANON_KEY };

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
    lock: boundedLock,
  },
});
