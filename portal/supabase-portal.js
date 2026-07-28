// ── Supabase client for the owners portal ──────────────────────────────────
// Its own instance, for two reasons:
//   · detectSessionInUrl must be ON so the magic-link callback completes here
//     (the member app deliberately turns it off).
//   · a separate storageKey so signing in/out of the portal never disturbs a
//     member session in the same browser.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../app/supabase.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'brace-portal-auth',
  },
});
