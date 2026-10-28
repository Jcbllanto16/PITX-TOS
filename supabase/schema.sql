-- PITX Terminal Operating System (TOS) — Supabase schema
-- Run this whole file once in Supabase: SQL Editor → New query → paste → Run.
-- Then run seed.sql for sample data.
-- Times are stored as timestamptz; PITX local time is Asia/Manila (UTC+8).

-- ============================================================
-- CTS data (masterfile + approved bookings).
-- In this separate project these are loaded from CTS (CSV import or sync).
-- ============================================================
create table if not exists public.operators (
  id          text primary key,
  name        text not null,
  trade_name  text
);

create table if not exists public.routes (
  id           serial primary key,
  operator_id  text not null references public.operators(id),
  destination  text not null,
  kind         text not null check (kind in ('prov','city')),
  weight       int  not null default 1
);

create table if not exists public.vehicles (
  plate             text primary key,            -- stored as 'ABC 1234'
  operator_id       text not null references public.operators(id),
  body_no           text,
  bus_type          text,
  cpc_valid_until   date,
  orcr_valid_until  date,
  rfid_tag          text unique
);

create table if not exists public.bays (
  id    text primary key,                       -- D01..D08 provincial, C01..C04 city
  kind  text not null check (kind in ('prov','city'))
);

create table if not exists public.bookings (
  id           text primary key,                -- CTS booking reference
  operator_id  text not null references public.operators(id),
  plate        text not null references public.vehicles(plate),
  destination  text not null,
  kind         text not null check (kind in ('prov','city')),
  bay_id       text references public.bays(id),
  slot_start   timestamptz not null,            -- bay slot opens (normally ETD - 30 min)
  etd          timestamptz not null,
  -- set by TOS from gate reads:
  arrived_at   timestamptz,
  departed_at  timestamptz,
  held         boolean not null default false,  -- sent to staging (early)
  denied       boolean not null default false
);
create index if not exists bookings_etd_idx   on public.bookings(etd);
create index if not exists bookings_plate_idx on public.bookings(plate);

-- ============================================================
-- TOS data
-- ============================================================
create table if not exists public.gates (
  id           text primary key,                -- G1, G2, X1
  name         text not null,
  description  text,
  direction    text not null check (direction in ('entry','exit'))
);

create table if not exists public.devices (
  id              text primary key,             -- e.g. G1-LPR
  gate_id         text references public.gates(id),
  location        text not null,
  kind            text not null,                -- LPR camera, RFID reader, Boom barrier, Display...
  role            text,
  status          text not null default 'online' check (status in ('online','offline','not installed','planned')),
  last_heartbeat  timestamptz
);

create table if not exists public.rules (
  id               int primary key default 1 check (id = 1),
  early_min        int  not null default 30,
  grace_min        int  not null default 10,
  on_late          text not null default 'REVIEW' check (on_late          in ('REVIEW','DENY')),
  on_expired       text not null default 'DENY'   check (on_expired       in ('REVIEW','DENY')),
  on_no_booking    text not null default 'DENY'   check (on_no_booking    in ('REVIEW','DENY')),
  on_unregistered  text not null default 'DENY'   check (on_unregistered  in ('REVIEW','DENY')),
  min_confidence   int  not null default 85 check (min_confidence between 0 and 100),
  updated_at       timestamptz not null default now()
);
insert into public.rules (id) values (1) on conflict do nothing;

create table if not exists public.gate_events (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),
  gate_id         text not null references public.gates(id),
  plate           text not null,
  confidence      numeric(4,3) not null default 1,
  decision        text not null check (decision in ('ALLOW','DENY','HOLD','REVIEW','EXIT')),
  category        text,
  reason          text,
  booking_id      text references public.bookings(id) on delete set null,
  pending         boolean not null default false,  -- waiting for admin
  resolution      text check (resolution in ('ALLOWED','DENIED')),
  resolved_at     timestamptz,
  resolved_by     uuid references auth.users(id),
  barrier_opened  boolean not null default false
);
create index if not exists gate_events_created_idx on public.gate_events(created_at desc);
create index if not exists gate_events_pending_idx on public.gate_events(pending) where pending;
create index if not exists gate_events_booking_idx on public.gate_events(booking_id);
create index if not exists gate_events_resolved_by_idx on public.gate_events(resolved_by);

-- ============================================================
-- Staff allowlist: only accounts listed here can use TOS. Signing up to the
-- Supabase project is not enough. Add a staff member after creating their
-- login (Authentication → Users):
--   insert into public.staff (user_id, email)
--   select id, email from auth.users where email = 'name@megawide.com.ph';
-- ============================================================
create table if not exists public.staff (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  email     text,
  added_at  timestamptz not null default now()
);
alter table public.staff enable row level security;
drop policy if exists "staff see own row" on public.staff;
create policy "staff see own row" on public.staff for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.staff where user_id = (select auth.uid())) $$;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

-- ============================================================
-- Row level security: staff can read everything and edit rules.
-- All gate writes go through the functions below.
-- ============================================================
alter table public.operators   enable row level security;
alter table public.routes      enable row level security;
alter table public.vehicles    enable row level security;
alter table public.bays        enable row level security;
alter table public.bookings    enable row level security;
alter table public.gates       enable row level security;
alter table public.devices     enable row level security;
alter table public.rules       enable row level security;
alter table public.gate_events enable row level security;

do $$
declare t text;
begin
  foreach t in array array['operators','routes','vehicles','bays','bookings','gates','devices','rules','gate_events'] loop
    execute format('drop policy if exists "staff can read" on public.%I', t);
    execute format('create policy "staff can read" on public.%I for select to authenticated using ((select public.is_staff()))', t);
  end loop;
end $$;

drop policy if exists "staff can edit rules" on public.rules;
create policy "staff can edit rules" on public.rules for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

-- ============================================================
-- Gate logic
-- ============================================================

-- One plate read at a gate. Called by the hardware endpoint (edge function)
-- and by the "Test a vehicle" buttons. Returns the event, including whether
-- the barrier should open.
create or replace function public.gate_read(p_gate text, p_plate text, p_confidence numeric default 0.95)
returns public.gate_events
language plpgsql security definer set search_path = public
as $$
declare
  r      public.rules;
  g      public.gates;
  v      public.vehicles;
  b      public.bookings;
  ev     public.gate_events;
  t_now  timestamptz := now();
  today  date := (now() at time zone 'Asia/Manila')::date;
  diff   int;
  d      text;
  cat    text;
  why    text;
  norm   text := upper(regexp_replace(trim(p_plate), '\s+', '', 'g'));
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and not public.is_staff() then
    raise exception 'This account is not authorised for TOS';
  end if;
  select * into r from public.rules where id = 1;
  select * into g from public.gates where id = p_gate;
  if not found then raise exception 'Unknown gate %', p_gate; end if;

  select * into v from public.vehicles where replace(plate, ' ', '') = norm;

  -- Exit gate: close out the open trip for this bus.
  if g.direction = 'exit' then
    if v.plate is not null then
      select * into b from public.bookings
       where plate = v.plate and arrived_at is not null and departed_at is null
       order by etd limit 1;
    end if;
    if b.id is not null then
      update public.bookings set departed_at = t_now where id = b.id;
      diff := round(extract(epoch from (t_now - b.etd)) / 60);
      why := case when diff > 2 then format('Left %s min after ETD', diff) else 'Left on time' end;
    else
      why := 'Exit without an open trip';
    end if;
    insert into public.gate_events (gate_id, plate, confidence, decision, category, reason, booking_id, barrier_opened)
    values (p_gate, coalesce(v.plate, upper(trim(p_plate))), p_confidence, 'EXIT', 'Exit', why, b.id, true)
    returning * into ev;
    return ev;
  end if;

  -- Entry gate: find the closest open booking for this bus.
  if v.plate is not null then
    select * into b from public.bookings
     where plate = v.plate and arrived_at is null and not denied
       and etd >= t_now - interval '60 minutes' and slot_start <= t_now + interval '12 hours'
     order by abs(extract(epoch from (slot_start - t_now)))
     limit 1;
  end if;

  if p_confidence * 100 < r.min_confidence then
    d := 'REVIEW'; cat := 'Unclear plate read';
    why := format('Plate read unclear (%s%% match), confirm on camera', round(p_confidence * 100));
  elsif v.plate is null then
    d := r.on_unregistered; cat := 'Unregistered vehicle'; why := 'Plate not in CTS vehicle masterfile';
  elsif v.orcr_valid_until < today then
    d := r.on_expired; cat := 'Expired documents'; why := 'OR/CR expired ' || v.orcr_valid_until;
  elsif v.cpc_valid_until < today then
    d := r.on_expired; cat := 'Expired documents'; why := 'CPC expired ' || v.cpc_valid_until;
  elsif b.id is null then
    d := r.on_no_booking; cat := 'No booking'; why := 'No approved CTS booking today';
  else
    diff := round(extract(epoch from (t_now - b.slot_start)) / 60);
    if diff < -r.early_min then
      d := 'HOLD'; cat := 'Early';
      why := format('Early by %s min. Sent to staging; entry opens %s', -diff,
                    to_char((b.slot_start - make_interval(mins => r.early_min)) at time zone 'Asia/Manila', 'HH24:MI'));
    elsif diff > r.grace_min then
      d := r.on_late; cat := 'Late';
      why := format('Late by %s min for %s slot (grace %s min)', diff,
                    to_char(b.slot_start at time zone 'Asia/Manila', 'HH24:MI'), r.grace_min);
    else
      d := 'ALLOW'; cat := 'On time';
      why := case when diff > 0 then format('On schedule, %s min into grace period', diff) else 'On schedule' end;
    end if;
  end if;

  insert into public.gate_events (gate_id, plate, confidence, decision, category, reason, booking_id, pending, barrier_opened)
  values (p_gate, coalesce(v.plate, upper(trim(p_plate))), p_confidence, d, cat, why, b.id, d = 'REVIEW', d = 'ALLOW')
  returning * into ev;

  if d = 'ALLOW' then
    update public.bookings set arrived_at = t_now, held = false where id = b.id;
  elsif d = 'HOLD' then
    update public.bookings set held = true where id = b.id;
  elsif d = 'DENY' and b.id is not null then
    update public.bookings set denied = true where id = b.id;
  end if;

  return ev;
end $$;

-- Admin decision on a vehicle held at the gate.
create or replace function public.resolve_review(p_event bigint, p_allow boolean)
returns public.gate_events
language plpgsql security definer set search_path = public
as $$
declare ev public.gate_events;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and not public.is_staff() then
    raise exception 'This account is not authorised for TOS';
  end if;
  update public.gate_events
     set pending = false,
         resolution = case when p_allow then 'ALLOWED' else 'DENIED' end,
         resolved_at = now(),
         resolved_by = auth.uid(),
         barrier_opened = p_allow
   where id = p_event and pending
  returning * into ev;
  if not found then raise exception 'This vehicle was already decided'; end if;

  if ev.booking_id is not null then
    if p_allow then
      update public.bookings set arrived_at = now(), held = false where id = ev.booking_id;
    else
      update public.bookings set denied = true where id = ev.booking_id;
    end if;
  end if;
  return ev;
end $$;

-- Public departure board (concourse screens, no login).
create or replace function public.get_board()
returns table (
  id text, etd timestamptz, slot_start timestamptz, destination text, trade_name text, bay_id text,
  arrived_at timestamptz, departed_at timestamptz, denied boolean, held boolean, review_pending boolean, grace_min int
)
language sql stable security definer set search_path = public
as $$
  select b.id, b.etd, b.slot_start, b.destination, coalesce(o.trade_name, o.name), b.bay_id,
         b.arrived_at, b.departed_at, b.denied, b.held,
         exists (select 1 from public.gate_events e where e.booking_id = b.id and e.pending),
         (select grace_min from public.rules where id = 1)
    from public.bookings b
    join public.operators o on o.id = b.operator_id
   where b.etd between now() - interval '60 minutes' and now() + interval '180 minutes'
   order by b.etd;
$$;

revoke all on function public.gate_read(text, text, numeric)  from public, anon;
revoke all on function public.resolve_review(bigint, boolean) from public, anon;
grant execute on function public.gate_read(text, text, numeric)  to authenticated, service_role;
grant execute on function public.resolve_review(bigint, boolean) to authenticated, service_role;
grant execute on function public.get_board() to anon, authenticated;

-- Live updates for the admin screens.
do $$
begin
  begin alter publication supabase_realtime add table public.gate_events; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.bookings;    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.rules;       exception when duplicate_object then null; end;
end $$;
