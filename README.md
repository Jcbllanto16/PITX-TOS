# PITX Terminal Operating System (TOS)

Web app for PITX terminal operations. CTS handles operator bookings and approvals.
TOS takes over at the gate:

- **Gate monitor.** Every plate read at an entry gate is checked against the bus's approved CTS booking and the vehicle masterfile (CPC and OR/CR validity). TOS then opens the barrier, sends the bus to staging, keeps it out, or asks an admin.
- **Admin alerts.** Late buses and unclear plate reads wait for an admin to choose *Open barrier* or *Keep closed*.
- **Bay timeline.** The day's CTS bay slots, coloured by what the gates recorded.
- **Passenger board.** Remarks follow the gate reads (Bus at bay, Boarding, Departed). It is also available publicly at `board.html` for concourse screens.
- **CTS feed.** A read-only view of the bookings and masterfile TOS works from.
- **Devices & rules.** Early window, grace period and what to do with late, expired, unbooked or unregistered buses.

Stack:
- A static site (HTML, CSS and plain JavaScript, no build step) hosted on **GitHub Pages**.
- **Supabase** for the database, staff login, realtime updates and the hardware endpoint.

```
index.html                         Admin app (sign-in required)
board.html                         Public departure board for concourse screens
css/app.css                        Theme (matches the CTS admin UI)
js/config.js                       Supabase URL + anon key  ← edit this
js/app.js                          Admin app logic
js/board.js                        Board rendering shared by both pages
supabase/schema.sql                Tables, security rules, gate logic functions
supabase/seed.sql                  Sample operators, vehicles and a day of bookings
supabase/functions/gate-read/      Endpoint for cameras / RFID / barrier controllers
```

---

## 1. Create the Supabase project

1. Create a new project at <https://supabase.com/dashboard>. Region: **Southeast Asia (Singapore)**.
2. Open **SQL Editor → New query**. Paste the whole of `supabase/schema.sql` and click **Run**.
3. Open a second query. Paste `supabase/seed.sql` and click **Run**. This loads sample operators, about 60 buses and a full day of bookings for today.
4. Create the admin accounts:
   1. Go to **Authentication → Users → Add user → Create new user**.
   2. Enter an email and password, and tick **Auto Confirm User**.
   3. Repeat for each PITX admin.
   5. Put each admin on the TOS staff list. Signing in alone isn't enough; anyone not on the list sees "Account not yet authorised". In **SQL Editor**, run:
      ```sql
      insert into public.staff (user_id, email)
      select id, email from auth.users where email = 'name@megawide.com.ph';
      ```
5. Turn off public sign-ups so only the accounts you create can log in: **Authentication → Sign In / Providers → Email → Allow new users to sign up = off**.
6. Copy two values from **Project Settings → API** for the next step:
   - the **Project URL**
   - the **anon public** key

The sample data is for demos only. To start a fresh demo day, run `select public.seed_demo_day();` in the SQL Editor each morning. It rebuilds today's bookings and replays realistic gate reads up to the current time.

## 2. Connect the site

Edit `js/config.js` and paste both values:

```js
window.TOS_CONFIG = {
  supabaseUrl: 'https://abcdefghijkl.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...'
};
```

The anon key is meant to be public. Row level security means it can only read the departure board until a staff member signs in.

## 3. Publish on GitHub Pages

1. Push this folder to the GitHub repository.
2. In the repo, go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
3. After a minute the site is live at `https://<owner>.github.io/<repo>/`. The public board is at `.../board.html`.
4. In Supabase, go to **Authentication → URL Configuration** and set **Site URL** to that GitHub Pages address.

> GitHub Pages sites are public even when the repository is private, and private-repo Pages needs a paid GitHub plan. That's fine here: nothing works without signing in, except the departure board.

## 4. Connect the gate hardware

The hardware isn't final yet. Whatever the vendor supplies, it talks to one endpoint.

Deploy the endpoint once with the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase secrets set DEVICE_API_KEY=$(openssl rand -hex 24)
supabase functions deploy gate-read --no-verify-jwt
```

The device (or the vendor's controller) sends each read:

```http
POST https://<project-ref>.supabase.co/functions/v1/gate-read
x-device-key: <DEVICE_API_KEY>
content-type: application/json

{ "gate": "G1", "plate": "NBC 4821", "confidence": 0.94, "device_id": "G1-LPR" }
```

and gets back what the barrier should do:

```json
{ "action": "OPEN", "decision": "ALLOW", "reason": "On schedule", "event_id": 1234 }
```

| `action`            | Barrier does                                                          |
|---------------------|-----------------------------------------------------------------------|
| `OPEN`              | Open                                                                  |
| `KEEP_CLOSED`       | Stay closed (unregistered, expired documents, no booking, denied late) |
| `DIRECT_TO_STAGING` | Stay closed; bus goes to staging and is re-read when its window opens |
| `WAIT_FOR_ADMIN`    | Stay closed until an admin decides                                    |

For `WAIT_FOR_ADMIN`, poll `GET .../gate-read?event_id=1234` (same header) until the action changes to `OPEN` or `KEEP_CLOSED`. Alternatively, subscribe to Supabase Realtime on `gate_events`.

Gate IDs are `G1` (Entry Gate 1, provincial), `G2` (Entry Gate 2, city P2P) and `X1` (Exit Gate). Change them in the `gates` table to match the real layout. List the real devices in the `devices` table.

To ask the vendor:
- Can the camera or controller make an HTTPS POST per read, or do we need a small on-site relay?
- Does the read include a confidence score?
- How is the barrier opened remotely (relay, HTTP, Wiegand)?
- Can the displays take text over the network?

## 5. Loading real CTS data

This Supabase project is separate from CTS. Until the two are linked, load CTS exports into these tables with **Table Editor → Import data from CSV**:

| Table       | Columns                                                                                       |
|-------------|-----------------------------------------------------------------------------------------------|
| `operators` | `id`, `name`, `trade_name`                                                                    |
| `vehicles`  | `plate` (format `ABC 1234`), `operator_id`, `body_no`, `bus_type`, `cpc_valid_until`, `orcr_valid_until` |
| `bookings`  | `id`, `operator_id`, `plate`, `destination`, `kind` (`prov`/`city`), `bay_id`, `slot_start`, `etd` |

The next step is an automatic sync: CTS calls a webhook or writes to these tables when a slot is approved.

## Gate rules (defaults)

| Situation                        | Default                      |
|----------------------------------|------------------------------|
| More than 30 min before slot     | Staging                      |
| Up to 10 min after slot start    | Open                         |
| Later than grace                 | Ask admin                    |
| CPC or OR/CR expired             | Keep closed                  |
| No approved booking today        | Keep closed                  |
| Plate not in masterfile          | Keep closed                  |
| Read confidence below 85%        | Ask admin                    |

Admins change these under **Devices & rules**. Changes take effect from the next read.
