// ── Supabase client for the Brace app ──────────────────────────────────────
// Project: "Brace" (eu-west-2). The anon key is public by design — Row Level
// Security on the `sessions`/`profiles` tables and the private `clips` bucket
// is what protects data, so it's safe to ship in the client.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const SUPABASE_URL = 'https://tvcbizxwadibtclamnyy.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2Y2Jpenh3YWRpYnRjbGFtbnl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NTcwNzQsImV4cCI6MjA5ODEzMzA3NH0.lH9bdpbc6vdQMMj50fxY8Lin_K-x6x2C-kdyHRsODBA';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
