// Supabase connection for the TOS web app.
// Find both values in Supabase: Project Settings → API.
// The anon (public) key is safe to publish: row level security limits it to the
// public departure board until a staff member signs in.
window.TOS_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-PUBLIC-KEY'
};
