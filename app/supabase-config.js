// ── Where Brace's data lives ───────────────────────────────────────────────
// Constants only, deliberately. The portal needs these without pulling in the
// member app's client: importing a module runs it, so importing app/supabase.js
// just to read a URL was quietly standing up a second auth client on the same
// origin. Two clients for one project means two token-refresh loops competing
// over the same session, and supabase-js warns about exactly this.
//
// The anon key is public by design — Row Level Security is what protects data,
// so it is safe to ship in the client.
export const SUPABASE_URL = 'https://tvcbizxwadibtclamnyy.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2Y2Jpenh3YWRpYnRjbGFtbnl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NTcwNzQsImV4cCI6MjA5ODEzMzA3NH0.lH9bdpbc6vdQMMj50fxY8Lin_K-x6x2C-kdyHRsODBA';
