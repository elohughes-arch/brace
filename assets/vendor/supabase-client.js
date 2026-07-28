// The Supabase client, served from our own origin.
//
// This used to be imported straight from esm.sh. That put a third-party CDN in
// the critical path of the page that guards the agentic software: if it was
// slow, blocked, or having a bad day, the import never settled and the portal
// sat on a spinner with no way in and no way to sign out.
//
// assets/vendor/supabase-js-2.45.4.js is the official UMD build (MIT), loaded
// by a plain script tag before the module. This re-exports it so the rest of
// the code imports it exactly as before.
if (!window.supabase || typeof window.supabase.createClient !== 'function') {
  throw new Error(
    'The Supabase client did not load. Expected assets/vendor/supabase-js-2.45.4.js '
    + 'to have run before this module.');
}

export const createClient = window.supabase.createClient;
