// Supabase connection for the TOS web app (project: PITX TOS, Singapore).
// The anon (public) key is safe to publish: row level security limits it to the
// public departure board, and the admin screens only work for accounts on the
// staff list.
window.TOS_CONFIG = {
  supabaseUrl: 'https://bekjgnqtazbfoejoldxw.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJla2pnbnF0YXpiZm9lam9sZHh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxNzMxOTUsImV4cCI6MjEwODc0OTE5NX0.Z7FkZycwWxWHkFZvvyl2sLyamZi3Vdv6MNbUoS555Tw'
};
