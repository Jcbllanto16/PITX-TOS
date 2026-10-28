# PITX TOS — project context for Claude Code

Handoff from the claude.ai conversation of 28 Oct 2026 where this project was built. Read this first.

## What this is

Terminal Operating System (TOS) for PITX (Parañaque Integrated Terminal Exchange). Owner: Jacob Llanto (Megawide), GitHub `Jcbllanto16`.

PITX has two systems:
- **CTS** (central ticketing / slot booking) is built separately by **Matt**. Operators book a bay and timeslot from their fleet, using a masterfile of operators, franchises and buses, and PITX admin approves the slot. CTS lives in its own Supabase project, **"PITX Trip Scheduling"** (`nuezknlzwfkfxlicrgol`), in the same Megawide org. **Do not modify that project.**
- **TOS** (this repo) takes over at the gate. It talks to gate hardware (still being chosen: LPR cameras, RFID, boom barriers, displays) and does three things:
  1. Tells admins and passengers when a bus has arrived or departed.
  2. Shows departures on concourse screens.
  3. Controls access: keeps out late, unregistered, or expired-document buses, or holds them for admin.

  TOS will later be integrated with CTS.

UI theme deliberately matches Matt's CTS admin UI: dark charcoal sidebar with PITX wordmark, white top bar with dark bell and blue avatar, light grey canvas, rounded white cards, uppercase grey table headers, Inter font. Keep it that way.

## Live deployment

| What | Where |
|---|---|
| Repo | github.com/Jcbllanto16/PITX-TOS (branch `main`) |
| Admin site (GitHub Pages, main / root) | https://jcbllanto16.github.io/PITX-TOS/ |
| Public departure board (no login) | https://jcbllanto16.github.io/PITX-TOS/board.html |
| Supabase project | **PITX TOS**, ref `bekjgnqtazbfoejoldxw`, region ap-southeast-1, org "Megawide Construction Corporation" |
| Supabase dashboard | https://supabase.com/dashboard/project/bekjgnqtazbfoejoldxw |

Login: shared demo account `pitx.admin@megawide.com.ph`. Jacob set the password himself; never ask for it or store it. The account is on the `staff` list.

## Stack and files

A static site (plain HTML, CSS and JS, no build step, no npm) plus Supabase for Postgres, auth, realtime and an edge function.

- `index.html`: admin app shell (login, sidebar, top bar). Views are hash-routed: `#overview`, `#gates` (default), `#bays`, `#board`, `#cts`, `#devices`.
- `js/app.js`: all admin logic. It loads data from Supabase, subscribes to realtime on `gate_events`, `bookings` and `rules`, and calls the `gate_read`, `resolve_review` and `is_staff` RPCs. Times are minutes of the Manila day (UTC+8, no DST).
- `js/board.js`: board table rendering, shared by the app and `board.html`.
- `board.html`: public concourse board. It polls the `get_board()` RPC every 20 s.
- `js/config.js`: Supabase URL and legacy anon key. The key is public by design.
- `css/app.css`: theme.
- `supabase/schema.sql`: tables, RLS, staff allowlist, gate logic functions. Source of truth; keep it in sync with the live DB.
- `supabase/seed.sql`: sample operators, routes, ~60 vehicles, bays, gates, devices, plus `seed_demo_day()`.
- `supabase/functions/gate-read/index.ts`: hardware endpoint. **Not deployed yet.**
- `README.md`: setup guide written for Jacob (non-developer).

## Data model (public schema)

The CTS-side data:
- `operators`, `routes` and `vehicles`. Vehicles carry plate `ABC 1234`, body_no, bus_type, `cpc_valid_until` and `orcr_valid_until`.
- `bookings`, the approved bay slots: `slot_start` (= ETD − 30 min), `etd` and `bay_id`. TOS sets `arrived_at`, `departed_at`, `held` and `denied`.

The TOS-side data:
- `bays`: D01–D08 provincial, C01–C04 city.
- `gates`: G1 entry provincial, G2 entry city, X1 exit.
- `devices`.
- `rules`: a single row with id 1.
- `gate_events`: each read, holding decision ALLOW/DENY/HOLD/REVIEW/EXIT, `pending` (waiting for admin), resolution and `barrier_opened`.
- `staff`: allowlist of auth user ids.

Gate decision order in `gate_read()`:
1. Read confidence below the minimum leads to REVIEW.
2. A plate not in `vehicles` is treated as unregistered.
3. Expired OR/CR or CPC is treated as expired.
4. No open booking is treated as no-booking.
5. Arriving more than `early_min` before the slot leads to HOLD (staging).
6. Arriving more than `grace_min` after the slot is treated as late.
7. Otherwise the bus is allowed.

The rule settings for late, expired, no-booking and unregistered are either `DENY` or `REVIEW`. Defaults: early 30, grace 10, late REVIEW, all others DENY, min confidence 85.

Security:
- All tables have RLS: read for `is_staff()` only, and `rules` can be updated by staff.
- Writes happen only through SECURITY DEFINER functions.
- `gate_read` and `resolve_review` refuse non-staff unless the JWT role is `service_role` (the edge function).
- `get_board()` is the only thing anon can call.
- Advisor warnings about SECURITY DEFINER RPCs are expected and intentional.

Migrations applied to the live DB, in order:
1. `tos_schema`
2. `tos_demo_seed`
3. `tos_staff_access`

To add a staff member after creating their user in Authentication → Users:
```sql
insert into public.staff (user_id, email) select id, email from auth.users where email = '...';
```

To reset the demo, run `select public.seed_demo_day();` (callable by service role or the SQL editor only). It rebuilds today's bookings and replays realistic gate reads up to now. The sample data is fictional: operators such as "Bicol Royal Transit" and "BEX Liner", and invented plates.

## Working rules

- Never create accounts or set or enter passwords for Jacob. He creates logins himself in the Supabase dashboard.
- Never touch the CTS Supabase project `nuezknlzwfkfxlicrgol`.
- Test SQL changes locally before applying them live. Postgres 16 is a good stand-in if you stub `auth.uid()`, `auth.jwt()`, the anon, authenticated and service_role roles, and the `supabase_realtime` publication. Then apply them as a named migration and update `supabase/schema.sql` to match.
- Jacob is not a developer. Give him short, click-by-click instructions, and don't send him to a terminal.
- Commit trailer used so far:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Open items / next steps

1. **Hardware.** The vendor is not chosen yet. Deploy `gate-read` once there's a device to test:
   ```
   supabase secrets set DEVICE_API_KEY=...
   supabase functions deploy gate-read --no-verify-jwt
   ```
   Questions for the vendor are in the README: HTTPS POST per read, confidence score, remote barrier control, display input.
2. **CTS integration.** Today the bookings and masterfile in this project are sample data. The plan is to sync approved slots and the masterfile from Matt's CTS project, via a webhook or scheduled pull. That needs Matt's schema (his Vehicles screen shows destination, CPC validity, OR/CR validity, body number and bus type, with expired dates in red).
3. **Per-person logins.** Replace the shared admin with individual staff logins so `resolved_by` records who opened a barrier. A "Staff accounts" page in the app was offered but not built.
4. **Public sign-up.** It's still on in Supabase Auth settings. The staff list already blocks outsiders, but turn it off anyway: Authentication → Sign In / Providers → Email.
5. **Real data.** Replace the sample gate and bay layout (D01–D08, C01–C04, G1/G2/X1) with PITX's actual layout once Jacob confirms it.
6. **Other modules.** Jacob's wider PITX digitalization scope also includes OBTS (online booking/ticketing). Not started in this repo.

## Related artifact

An earlier clickable prototype (simulated clock, no backend) was published as a claude.ai artifact, "PITX Terminal Ops": https://claude.ai/artifact/9KNdiHfCYCjeSnFovnnvxx
