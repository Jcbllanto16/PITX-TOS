-- Sample data for the PITX TOS demo. Run after schema.sql.
-- Operators, routes, vehicles and bookings here are ILLUSTRATIVE ONLY.
-- Replace them with the real CTS masterfile when it is available.

insert into public.operators (id, name, trade_name) values
  ('BRT','Bicol Royal Transit','Bicol Royal'),
  ('BEX','Batangas Express Corp.','BEX Liner'),
  ('SSL','Southern Star Liner','Southern Star'),
  ('LGT','Laguna Gateway Transport','LG Transit'),
  ('TRL','Tagaytay Ridge Line','Ridge Line'),
  ('MPP','Metro P2P Inc.','Metro P2P')
on conflict (id) do nothing;

insert into public.routes (operator_id, destination, kind, weight)
select * from (values
  ('BRT','Pilar, Sorsogon','prov',2),('BRT','Pio Duran','prov',1),('BRT','Tabaco City','prov',1),('BRT','Legazpi','prov',1),
  ('BEX','Batangas City','prov',4),('BEX','Lipa','prov',3),
  ('SSL','Lucena','prov',3),('SSL','Nasugbu','prov',2),
  ('LGT','Sta. Cruz','prov',2),('LGT','Calamba','prov',3),
  ('TRL','Tagaytay','prov',3),
  ('MPP','Makati (Ayala)','city',1),('MPP','Ortigas','city',1),('MPP','BGC','city',1)
) as r(operator_id, destination, kind, weight)
where not exists (select 1 from public.routes);

insert into public.bays (id, kind)
select 'D' || lpad(i::text, 2, '0'), 'prov' from generate_series(1, 8) i
union all
select 'C' || lpad(i::text, 2, '0'), 'city' from generate_series(1, 4) i
on conflict (id) do nothing;

insert into public.gates (id, name, description, direction) values
  ('G1','Entry Gate 1','Provincial buses','entry'),
  ('G2','Entry Gate 2','City P2P buses','entry'),
  ('X1','Exit Gate','All departures','exit')
on conflict (id) do nothing;

insert into public.devices (id, gate_id, location, kind, role, status, last_heartbeat) values
  ('G1-LPR','G1','Entry Gate 1','LPR camera','Reads plate, returns match confidence','online',now()),
  ('G1-RFID','G1','Entry Gate 1','RFID reader','Reads windshield tag as a second ID','online',now()),
  ('G1-BAR','G1','Entry Gate 1','Boom barrier','Open / keep closed command','online',now()),
  ('G2-LPR','G2','Entry Gate 2','LPR camera','Reads plate, returns match confidence','online',now()),
  ('G2-BAR','G2','Entry Gate 2','Boom barrier','Open / keep closed command','online',now()),
  ('X1-LPR','X1','Exit Gate','LPR camera','Marks the trip departed','online',now()),
  ('X1-BAR','X1','Exit Gate','Boom barrier','Opens for every exiting bus','online',now()),
  ('X1-RFID','X1','Exit Gate','RFID reader','Optional second ID','not installed',null),
  ('DISP-CONC',null,'Concourse','Departure displays (4)','Shows ETD, bay and remarks','online',now()),
  ('DISP-BAY',null,'Bays D01–D08, C01–C04','Bay signs','Shows destination at each bay','planned',null),
  ('ADMIN',null,'Admin office','Alert console','Bell for vehicles held at the gate','online',now())
on conflict (id) do nothing;

-- Vehicle masterfile: ~60 buses, about 1 in 12 with lapsed CPC or OR/CR.
do $$
declare
  o record; i int; p text;
  letters text := 'ABCDEFGHJKLMNPRSTUVWXYZ';
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  if exists (select 1 from public.vehicles) then return; end if;
  perform setseed(0.1028);
  for o in select * from (values ('BRT',14,5005),('BEX',12,3100),('SSL',10,2040),('LGT',10,7710),('TRL',6,6020),('MPP',10,9001)) t(id, fleet, body) loop
    for i in 0 .. o.fleet - 1 loop
      p := substr(letters, 1 + floor(random()*23)::int, 1) || substr(letters, 1 + floor(random()*23)::int, 1)
        || substr(letters, 1 + floor(random()*23)::int, 1) || ' ' || (1000 + floor(random()*9000)::int);
      insert into public.vehicles (plate, operator_id, body_no, bus_type, cpc_valid_until, orcr_valid_until)
      values (
        p, o.id,
        (o.body + i / 3)::text || substr('ABCDEFGHJK', 1 + i % 10, 1),
        case when o.id = 'MPP' then 'P2P' else (array['Regular aircon','Deluxe','Super deluxe'])[1 + floor(random()*3)::int] end,
        case when random() < 0.08 then today - (20 + floor(random()*280))::int else today + (60 + floor(random()*580))::int end,
        case when random() < 0.08 then today - (10 + floor(random()*490))::int else today + (30 + floor(random()*490))::int end
      ) on conflict do nothing;
    end loop;
  end loop;
end $$;

-- Generates a full day of approved bookings for today (Manila time), clears
-- today's gate events and replays realistic gate reads up to now.
-- Re-run any day to reset the demo:  select public.seed_demo_day();
create or replace function public.seed_demo_day()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  d0     timestamptz := date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  today  date := (now() at time zone 'Asia/Manila')::date;
  t      int;
  n      int := 0;
  rt     record;
  rr     record;
  bk     record;
  gt     text;
  rnd    float8;
  v_at   timestamptz;
  v_in   timestamptz;
  v_out  timestamptz;
  v_late int;
  vp     text;
  v_bay  text;
  v_etd  timestamptz;
  v_slot timestamptz;
  pfx    text := 'BK-' || to_char(now() at time zone 'Asia/Manila', 'MMDD') || '-';
begin
  delete from public.gate_events where created_at >= d0;
  delete from public.bookings where etd >= d0 and etd < d0 + interval '1 day';

  -- provincial departures every 6–12 min from 05:20, city P2P every 15 min from 05:45
  for rt in
    select g.m, g.kind from (
      select s.m, 'prov' as kind from generate_series(320, 1300, 9) s(m)
      union all
      select s.m, 'city' from generate_series(345, 1320, 15) s(m)
    ) g order by g.m
  loop
    v_etd  := d0 + make_interval(mins => rt.m + case when rt.kind = 'prov' then floor(random()*5)::int - 2 else 0 end);
    v_slot := v_etd - interval '30 minutes';

    select x.operator_id, x.destination into rr
      from public.routes x where x.kind = rt.kind
     order by -ln(1 - random()) / x.weight limit 1;

    select v.plate into vp from public.vehicles v
     where v.operator_id = rr.operator_id
       and ((v.cpc_valid_until >= today and v.orcr_valid_until >= today) or random() < 0.05)
     order by random() limit 1;

    select b.id into v_bay from public.bays b
     where b.kind = rt.kind
       and not exists (select 1 from public.bookings x where x.bay_id = b.id and x.slot_start < v_etd and x.etd > v_slot)
     order by b.id limit 1;

    n := n + 1;
    insert into public.bookings (id, operator_id, plate, destination, kind, bay_id, slot_start, etd)
    values (pfx || lpad(n::text, 3, '0'), rr.operator_id, vp, rr.destination, rt.kind, v_bay, v_slot, v_etd);
  end loop;

  -- Replay this morning's gate reads so the demo opens mid-shift.
  for bk in
    select b.*, (v.cpc_valid_until < today or v.orcr_valid_until < today) as lapsed, v.cpc_valid_until, v.orcr_valid_until
      from public.bookings b join public.vehicles v on v.plate = b.plate
     where b.etd >= d0 and b.slot_start < now()
     order by b.slot_start
  loop
    gt  := case when bk.kind = 'city' then 'G2' else 'G1' end;
    rnd := random();
    if rnd < 0.05 then
      continue;                                    -- no-show
    elsif bk.lapsed then
      v_at := bk.slot_start - make_interval(mins => floor(random()*10)::int);
      if v_at > now() then continue; end if;
      insert into public.gate_events (created_at, gate_id, plate, confidence, decision, category, reason, booking_id)
      values (v_at, gt, bk.plate, 0.95, 'DENY', 'Expired documents',
              case when bk.orcr_valid_until < today then 'OR/CR expired ' || bk.orcr_valid_until else 'CPC expired ' || bk.cpc_valid_until end, bk.id);
      update public.bookings set denied = true where id = bk.id;
      continue;
    elsif rnd < 0.13 then                          -- late, let in by admin
      v_late := 12 + floor(random()*20)::int;
      v_at := bk.slot_start + make_interval(mins => v_late);
      if v_at + interval '2 minutes' > now() then continue; end if;
      v_in := v_at + interval '2 minutes';
      insert into public.gate_events (created_at, gate_id, plate, confidence, decision, category, reason, booking_id, resolution, resolved_at, barrier_opened)
      values (v_at, gt, bk.plate, 0.95, 'REVIEW', 'Late',
              format('Late by %s min for %s slot (grace 10 min)', v_late, to_char(bk.slot_start at time zone 'Asia/Manila', 'HH24:MI')),
              bk.id, 'ALLOWED', v_in, true);
    else                                           -- on time
      v_at := bk.slot_start + make_interval(mins => floor(random()*18)::int - 10);
      if v_at > now() then continue; end if;
      v_in := v_at;
      insert into public.gate_events (created_at, gate_id, plate, confidence, decision, category, reason, booking_id, barrier_opened)
      values (v_at, gt, bk.plate, 0.90 + random()*0.09, 'ALLOW', 'On time', 'On schedule', bk.id, true);
    end if;
    update public.bookings set arrived_at = v_in where id = bk.id;

    v_out := greatest(bk.etd, v_in + interval '20 minutes') + make_interval(mins => case when random() < 0.2 then 2 + floor(random()*8)::int else floor(random()*2)::int end);
    if v_out < now() then
      update public.bookings set departed_at = v_out where id = bk.id;
      insert into public.gate_events (created_at, gate_id, plate, confidence, decision, category, reason, booking_id, barrier_opened)
      values (v_out, 'X1', bk.plate, 0.97, 'EXIT', 'Exit',
              case when v_out > bk.etd + interval '2 minutes' then format('Left %s min after ETD', round(extract(epoch from (v_out - bk.etd)) / 60)) else 'Left on time' end,
              bk.id, true);
    end if;
  end loop;

  -- A few unregistered vehicles turned away during the morning.
  for v_at in select d0 + make_interval(mins => m) from generate_series(340, 1300, 55) m loop
    exit when v_at > now();
    insert into public.gate_events (created_at, gate_id, plate, confidence, decision, category, reason)
    values (v_at, case when random() < 0.7 then 'G1' else 'G2' end,
            chr(65 + floor(random()*26)::int) || chr(65 + floor(random()*26)::int) || chr(65 + floor(random()*26)::int) || ' ' || (1000 + floor(random()*9000)::int),
            0.93, 'DENY', 'Unregistered vehicle', 'Plate not in CTS vehicle masterfile');
  end loop;

  return n;
end $$;

revoke all on function public.seed_demo_day() from public, anon, authenticated;

select public.seed_demo_day();
