import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Brace Supabase project (eu-west-2). The anon key is public by design — Row
// Level Security protects the data.
export const SUPABASE_URL = 'https://tvcbizxwadibtclamnyy.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2Y2Jpenh3YWRpYnRjbGFtbnl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NTcwNzQsImV4cCI6MjA5ODEzMzA3NH0.lH9bdpbc6vdQMMj50fxY8Lin_K-x6x2C-kdyHRsODBA';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
