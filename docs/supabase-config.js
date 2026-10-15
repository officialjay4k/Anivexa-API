// ============================================================
// Cloud Hub — supabase-config.js
// ============================================================

const SUPABASE_URL = 'https://xddljjtxbssmyyzvhxcm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkZGxqanR4YnNzbXl5enZoeGNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwNzE0NTEsImV4cCI6MjEwNzY0NzQ1MX0.DsalG7n5QOVjsWw7mNezyaA4MiKKYUCMSxQ-EREB63s';

if (window.supabase && window.supabase.createClient) {
  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'cloudhub-auth'
    }
  });
} else {
  console.error('[Supabase] Client not loaded — check the CDN script tag.');
}
