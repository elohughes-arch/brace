// ── Supabase client for the owners portal ──────────────────────────────────
// Its own instance, for two reasons:
//   · detectSessionInUrl must be ON so the magic-link callback completes here
//     (the member app deliberately turns it off).
//   · a separate storageKey so signing in/out of the portal never disturbs a
//     member session in the same browser.
//   · it reads the project constants from supabase-config.js, not from
//     app/supabase.js — importing that file would also *create* the member
//     app's client, leaving two auth clients refreshing one session.
import { createClient } from '../assets/vendor/supabase-client.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../app/supabase-config.js';
import { boundedLock } from '../app/supabase-lock.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'brace-portal-auth',
    lock: boundedLock,
  },
});
