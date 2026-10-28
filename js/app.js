// PITX Terminal Operating System — admin web app (Supabase backend).
(function () {
  const $ = s => document.querySelector(s);
  const { fmt, esc } = window.TOSBoard;
  const pad = n => String(n).padStart(2, '0');
  const cfg = window.TOS_CONFIG || {};

  if (!cfg.supabaseUrl || cfg.supabaseUrl.includes('YOUR-') || !cfg.supabaseAnonKey || cfg.supabaseAnonKey.includes('YOUR-')) {
    $('#setup').hidden = false;
    return;
  }
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  /* ---------- Time: PITX runs on Manila time (UTC+8, no daylight saving) ---------- */
  const OFF = 480, DAY = 1440;
  const nowMin = () => (Date.now() / 60000 + OFF) % DAY;
  const mm = ts => (ts ? (Date.parse(ts) / 60000 + OFF) % DAY : null);
  const dayStartISO = () => new Date((Math.floor((Date.now() / 60000 + OFF) / DAY) * DAY - OFF) * 60000).toISOString();
  const todayISO = () => new Date(Date.now() + OFF * 60000).toISOString().slice(0, 10);
  const dayLabel = () => new Date().toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', day: 'numeric', month: 'short' });
  let now = nowMin();

  /* ---------- State loaded from Supabase ---------- */
  let OPS = {}, vehicles = [], VEH = {}, BAYS = [], GATES = {}, DEVICES = [], bookings = [], log = [];
  let rules = { early: 30, grace: 10, late: 'REVIEW', docs: 'DENY', nobook: 'DENY', unreg: 'DENY', conf: 85 };
  const plateKey = p => String(p || '').replace(/\s+/g, '').toUpperCase();
  const expired = v => v.cpc < todayISO() || v.orcr < todayISO();
  const byB = id => bookings.find(b => b.id === id);
  const GROUPS = [{ kind: 'prov', label: 'Provincial departure bays' }, { kind: 'city', label: 'City P2P bays' }];

  function check(res, what) { if (res.error) throw new Error(`${what}: ${res.error.message}`); return res.data; }

  async function loadStatic() {
    const [o, v, b, g, d, r] = await Promise.all([
      sb.from('operators').select('*'),
      sb.from('vehicles').select('*').order('plate'),
      sb.from('bays').select('*').order('id'),
      sb.from('gates').select('*').order('id'),
      sb.from('devices').select('*').order('id'),
      sb.from('rules').select('*').eq('id', 1).single()
    ]);
    OPS = {}; check(o, 'operators').forEach(x => OPS[x.id] = { name: x.name, trade: x.trade_name || x.name });
    vehicles = check(v, 'vehicles').map(x => ({ plate: x.plate, op: x.operator_id, body: x.body_no || '—', type: x.bus_type || '—', cpc: x.cpc_valid_until || '—', orcr: x.orcr_valid_until || '—' }));
    VEH = {}; vehicles.forEach(x => VEH[plateKey(x.plate)] = x);
    BAYS = check(b, 'bays');
    DEVICES = check(d, 'devices');
    GATES = {}; check(g, 'gates').forEach(x => GATES[x.id] = { name: x.name, sub: x.description || '', dir: x.direction });
    setRules(check(r, 'rules'));
  }
  function setRules(x) { rules = { early: x.early_min, grace: x.grace_min, late: x.on_late, docs: x.on_expired, nobook: x.on_no_booking, unreg: x.on_unregistered, conf: x.min_confidence }; }

  async function loadDay() {
    const start = dayStartISO(), end = new Date(Date.parse(start) + DAY * 60000).toISOString();
    const [b, e] = await Promise.all([
      sb.from('bookings').select('*').gte('etd', start).lt('etd', end).order('etd'),
      sb.from('gate_events').select('*').gte('created_at', start).order('created_at', { ascending: false }).limit(1000)
    ]);
    bookings = check(b, 'bookings').map(x => ({
      id: x.id, op: x.operator_id, dest: x.destination, kind: x.kind, plate: x.plate, bay: x.bay_id,
      dep: mm(x.etd), slot: mm(x.slot_start), arrivedAt: mm(x.arrived_at), departedAt: mm(x.departed_at), denied: x.denied, held: x.held
    }));
    log = check(e, 'gate events').map(x => ({
      id: x.id, at: mm(x.created_at), gate: x.gate_id, plate: x.plate, conf: Number(x.confidence), decision: x.decision,
      cat: x.category, reason: x.reason, bid: x.booking_id, pending: x.pending, resolution: x.resolution,
      resolvedAt: mm(x.resolved_at), opened: x.barrier_opened
    }));
  }

  /* ---------- Status helpers ---------- */
  const pending = () => log.filter(e => e.pending);
  function bStatus(b) {
    if (b.denied) return 'Denied entry';
    if (b.departedAt != null) return 'Departed';
    if (b.arrivedAt != null) { if (now >= b.dep - 15) return 'Boarding'; return now - b.arrivedAt < 3 ? 'Entered gate' : 'At bay'; }
    if (b.held) return 'In staging';
    if (log.some(e => e.pending && e.bid === b.id)) return 'At gate · review';
    if (now > b.dep + 20) return 'No-show';
    if (now > b.slot + rules.grace) return 'Overdue';
    return 'Booked';
  }
  const BCLS = { 'Booked': 's-sched', 'Overdue': 's-delay', 'In staging': 's-pending', 'At gate · review': 's-pending', 'Entered gate': 's-bay', 'At bay': 's-bay', 'Boarding': 's-board', 'Departed': 's-done', 'Denied entry': 's-cancel', 'No-show': 's-cancel' };
  const pill = (t, c) => `<span class="pill ${c}">${t}</span>`;
  const bpill = b => { const s = bStatus(b); return pill(s, BCLS[s]); };
  const DEC = { ALLOW: ['Allowed', 's-bay'], DENY: ['Denied', 's-cancel'], HOLD: ['Held in staging', 's-pending'], REVIEW: ['Needs decision', 's-sched'], EXIT: ['Exited', 's-done'] };
  function dpill(e) {
    if (e.resolution) return pill(e.resolution === 'ALLOWED' ? 'Allowed by admin' : 'Denied by admin', e.resolution === 'ALLOWED' ? 's-bay' : 's-cancel');
    const [d, c] = DEC[e.decision] || [e.decision, 's-done']; return pill(d, c);
  }
  const plateChip = p => `<span class="plate${VEH[plateKey(p)] ? '' : ' unk'}">${esc(p)}</span>`;
  const gateName = id => (GATES[id] ? GATES[id].name : id);
  const opTrade = id => (OPS[id] ? OPS[id].trade : id);

  /* ---------- Shell ---------- */
  let view = 'gates', selected = null, feedFilter = 'all', ctsTab = 'bookings', ctsQuery = '';
  const VIEWS = ['overview', 'gates', 'bays', 'board', 'cts', 'devices'];
  const setHTML = (el, h) => { if (el && el._h !== h) { el.innerHTML = h; el._h = h; } };
  function toast(m) { const el = $('#toast'); el.textContent = m; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => el.hidden = true, 3200); }
  const head = (t, p, right = '') => `<div class="view-head"><div><h1>${t}</h1><p>${p}</p></div>${right}</div>`;

  /* ---------- Gate monitor ---------- */
  function buildGates() {
    return head('Gate monitor', 'Every bus read at the gates is checked against its approved CTS booking and the vehicle masterfile. TOS opens the barrier, sends it to staging, or holds it for an admin decision.') +
      `<div class="gates" id="gtiles"></div>
      <div class="gm">
        <section class="panel"><div class="ph"><h2>Gate events today</h2>
          <div class="seg" role="group" aria-label="Filter events">${[['all', 'All'], ['ALLOW', 'Allowed'], ['DENY', 'Denied'], ['HOLD', 'Staging'], ['EXIT', 'Exits']].map(([k, l]) => `<button data-act="ff" data-v="${k}" aria-pressed="${k === feedFilter}">${l}</button>`).join('')}</div></div>
          <div class="tscroll" id="feed"></div></section>
        <div class="side">
          <section class="panel" id="reviews"></section>
          <section class="panel"><div class="ph"><h2>Test a vehicle at the gate</h2></div><div class="pb">
            <p class="muted" style="margin:0 0 12px;font-size:13px">Sends a plate read through the same gate rules the cameras will use. Results are saved like real reads.</p>
            <div class="scen">
              <button class="btn" data-act="sim" data-v="ontime">On-time bus<small>Booked, docs valid</small></button>
              <button class="btn" data-act="sim" data-v="late">Late bus<small>Past grace period</small></button>
              <button class="btn" data-act="sim" data-v="early">Early bus<small>Before entry window</small></button>
              <button class="btn" data-act="sim" data-v="unreg">Unregistered<small>Not in masterfile</small></button>
              <button class="btn" data-act="sim" data-v="expired">Expired OR/CR<small>Registered, docs lapsed</small></button>
              <button class="btn" data-act="sim" data-v="unclear">Unclear read<small>Low camera match</small></button>
              <button class="btn" data-act="sim" data-v="exit">Bus leaving<small>Exit gate read</small></button>
              <button class="btn" data-act="sim" data-v="manual">Type a plate<small>Any plate at Gate 1</small></button>
            </div></div></section>
        </div>
      </div>`;
  }
  function gateTile(id) {
    const g = GATES[id], evs = log.filter(e => e.gate === id), last = evs[0];
    const hold = pending().some(e => e.gate === id);
    const open = !hold && last && last.opened && now - (last.resolvedAt != null ? last.resolvedAt : last.at) < 0.5;
    const st = hold ? ['hold', 'Holding · awaiting admin'] : open ? ['open', 'Barrier open'] : ['', 'Barrier closed'];
    const inn = evs.filter(e => e.opened).length, den = evs.filter(e => e.decision === 'DENY' || e.resolution === 'DENIED').length;
    const devs = DEVICES.filter(d => d.gate_id === id);
    return `<div class="panel gate"><div class="gh"><div><b>${esc(g.name)}</b><small>${esc(g.sub)}</small></div></div>
      <div class="barrier ${st[0]}"><i></i>${st[1]}</div>
      <div class="glast">${last ? `Last read ${fmt(last.at)} ${plateChip(last.plate)} ${dpill(last)}` : 'No reads yet today'}</div>
      <div class="gstats"><span><b>${inn}</b>${g.dir === 'exit' ? 'exited' : 'let in'}</span>${g.dir === 'exit' ? '' : `<span><b>${den}</b>turned away</span>`}</div>
      <div class="devs">${devs.map(d => `<span class="dev ${d.status === 'online' ? '' : d.status === 'offline' ? 'warn' : 'off'}">${esc(d.kind)}${d.status === 'online' ? '' : ' · ' + d.status}</span>`).join('')}</div></div>`;
  }
  function bookingLine(e) { const b = e.bid && byB(e.bid); return b ? `<b>${esc(b.dest)}</b><div class="muted" style="font-size:12.5px">${esc(b.id)} · slot ${fmt(b.slot)} · bay ${esc(b.bay)}</div>` : '<span class="muted">No matching booking</span>'; }
  function feedHTML() {
    const rows = log.filter(e => feedFilter === 'all' || (feedFilter === 'ALLOW' ? (e.decision === 'ALLOW' || e.resolution === 'ALLOWED') : feedFilter === 'DENY' ? (e.decision === 'DENY' || e.resolution === 'DENIED') : e.decision === feedFilter)).slice(0, 50);
    if (!rows.length) return '<div class="empty">No gate events in this filter yet today.</div>';
    return `<table><thead><tr><th>Time</th><th>Gate</th><th>Plate</th><th>CTS booking</th><th>Decision</th></tr></thead><tbody>${rows.map(e =>
      `<tr${e.bid ? ` data-act="selb" data-id="${esc(e.bid)}"` : ''}><td class="num">${fmt(e.at)}</td><td class="muted">${esc(gateName(e.gate).replace('Entry ', ''))}</td>
      <td>${plateChip(e.plate)}<span class="conf${e.conf * 100 < rules.conf ? ' low' : ''}">${Math.round(e.conf * 100)}% read</span></td>
      <td>${bookingLine(e)}</td><td>${dpill(e)}<div class="reason">${esc(e.reason)}</div></td></tr>`).join('')}</tbody></table>`;
  }
  function reviewsHTML() {
    const p = pending();
    return `<div class="ph"><h2>Waiting for admin<span class="count${p.length ? '' : ' zero'}">${p.length}</span></h2></div>` + (p.length ? `<ul class="att">${p.map(e => {
      const v = VEH[plateKey(e.plate)], b = e.bid && byB(e.bid);
      return `<li><span class="stripe k-req"></span><div>
        <div class="t">${plateChip(e.plate)} at ${esc(gateName(e.gate))}</div>
        <div class="why">${esc(e.reason)}</div>
        <div class="d">${v ? esc(opTrade(v.op)) + ' · body ' + esc(v.body) : 'Unknown vehicle'}${b ? ' · ' + esc(b.dest) + ' ' + fmt(b.dep) : ''} · read ${fmt(e.at)}</div>
        <div class="a"><button class="btn sm primary" data-act="allow" data-id="${e.id}">Open barrier</button><button class="btn sm danger" data-act="deny" data-id="${e.id}">Keep closed</button></div></div></li>`;
    }).join('')}</ul>` : '<div class="empty">No vehicles waiting. Late arrivals and unclear plate reads land here.</div>');
  }
  function updateGates() { setHTML($('#gtiles'), Object.keys(GATES).map(gateTile).join('')); setHTML($('#feed'), feedHTML()); setHTML($('#reviews'), reviewsHTML()); }

  async function simulate(kind) {
    const open = bookings.filter(b => b.arrivedAt == null && !b.denied && !b.held);
    const near = (lo, hi) => open.filter(b => b.slot - now >= lo && b.slot - now <= hi).sort((a, b) => Math.abs(a.slot - now) - Math.abs(b.slot - now))[0];
    let plate, gate = 'G1', conf = 0.96, b;
    if (kind === 'ontime' || kind === 'unclear') { b = near(-rules.grace + 1, rules.early - 1) || near(-rules.grace + 1, 240); if (kind === 'unclear') conf = 0.66; }
    else if (kind === 'late') { b = near(-120, -rules.grace - 1); if (!b) return toast('No overdue booking right now.'); }
    else if (kind === 'early') { b = near(rules.early + 15, 600); if (!b) return toast('No later bookings left today.'); }
    else if (kind === 'unreg') { const L = 'ABCDEFGHJKLMNPRSTUVWXYZ'; plate = [0, 0, 0].map(() => L[Math.floor(Math.random() * L.length)]).join('') + ' ' + (1000 + Math.floor(Math.random() * 9000)); gate = Math.random() < .7 ? 'G1' : 'G2'; }
    else if (kind === 'expired') { const v = vehicles.find(expired); if (!v) return toast('No vehicle with expired documents in the masterfile.'); plate = v.plate; gate = v.op === 'MPP' ? 'G2' : 'G1'; }
    else if (kind === 'exit') { const x = bookings.filter(b => b.arrivedAt != null && b.departedAt == null).sort((a, c) => a.dep - c.dep)[0]; if (!x) return toast('No bus inside the terminal yet. Let one in first.'); plate = x.plate; gate = 'X1'; }
    else if (kind === 'manual') { showPlateForm(); return; }
    if (b) { plate = b.plate; gate = b.kind === 'city' ? 'G2' : 'G1'; }
    if (!plate) return toast('No suitable booking found for that test.');
    await read(gate, plate, conf);
  }
  async function read(gate, plate, conf) {
    const { data, error } = await sb.rpc('gate_read', { p_gate: gate, p_plate: plate, p_confidence: conf });
    if (error) return toast('Gate read failed: ' + error.message);
    const label = data.decision === 'EXIT' ? 'exited' : (DEC[data.decision] || [data.decision])[0].toLowerCase();
    toast(`${data.plate} at ${gateName(gate)}: ${label}`);
    await refresh();
  }
  function showPlateForm() {
    const p = $('#reviews');
    const box = document.createElement('section');
    box.className = 'panel'; box.id = 'plateform';
    box.innerHTML = `<form class="pb" id="pf"><div class="field"><label for="pf-plate">Plate number</label><input id="pf-plate" placeholder="e.g. NBC 4821" autocomplete="off" required></div>
      <div class="field"><label for="pf-gate">Gate</label><select id="pf-gate">${Object.entries(GATES).map(([k, g]) => `<option value="${k}">${esc(g.name)}</option>`).join('')}</select></div>
      <div class="actions"><button class="btn primary" type="submit">Send read</button><button class="btn" type="button" data-act="closepf">Cancel</button></div></form>`;
    document.getElementById('plateform')?.remove();
    p.after(box);
    $('#pf-plate').focus();
    $('#pf').addEventListener('submit', async ev => { ev.preventDefault(); const v = $('#pf-plate').value.trim(); if (!v) return; box.remove(); await read($('#pf-gate').value, v, 0.95); });
  }

  /* ---------- Bay timeline ---------- */
  const PX = 3, WIN = 300;
  function buildBays() {
    return head('Bay timeline', 'Bay slots approved in CTS, coloured by what the gates have seen. A slot turns green when its bus is let in and grey once it leaves through the exit gate.',
      `<div class="legend">${['Booked', 'Overdue', 'At bay', 'Boarding', 'Departed', 'No-show'].map(s => pill(s, BCLS[s])).join('')}</div>`) +
      `<div class="dispatch"><section class="panel"><div class="ph"><h2>Today · ${dayLabel()}</h2><span class="muted" style="font-size:12.5px">Boarding opens 15 min before ETD</span></div>
      <div class="gantt-scroll"><div class="gantt" id="gantt"></div></div></section>
      <section class="panel detail" id="detail"></section></div>`;
  }
  function ganttHTML() {
    const ws = Math.floor((now - 60) / 30) * 30, we = ws + WIN;
    let h = `<div class="g-axis"><div class="g-label"></div><div class="g-track">`;
    for (let m = ws; m < we; m += 30) h += `<span class="tick${m === ws ? ' first' : ''}" style="left:${(m - ws) * PX}px">${fmt(m)}</span>`;
    h += '</div></div>';
    for (const g of GROUPS) {
      const bays = BAYS.filter(x => x.kind === g.kind); if (!bays.length) continue;
      h += `<div class="g-group">${g.label}</div>`;
      for (const bay of bays) {
        h += `<div class="g-row"><div class="g-label">${esc(bay.id)}</div><div class="g-track">`;
        bookings.filter(b => b.bay === bay.id).forEach(b => {
          const a = b.slot, e = b.departedAt != null ? Math.max(b.departedAt, b.slot + 5) : b.dep; if (e <= ws || a >= we) return;
          const l = Math.max(0, a - ws) * PX, r = Math.min(WIN, e - ws) * PX, s = bStatus(b);
          const cls = s === 'No-show' || s === 'Denied entry' ? 's-cancel conflict' : BCLS[s];
          h += `<button class="blk ${cls}${selected === b.id ? ' sel' : ''}" data-act="selb" data-id="${esc(b.id)}" style="left:${l}px;width:${Math.max(r - l, 6)}px" title="${esc(b.id)} · ${esc(b.dest)} · ${s}">${fmt(b.dep)} ${esc(b.dest)}</button>`;
        });
        h += '</div></div>';
      }
    }
    return h + '<div class="now-line" id="nowline"></div>';
  }
  function detailHTML() {
    const b = selected && byB(selected);
    if (!b) return `<div class="ph"><h2>Booking detail</h2></div><div class="empty">Select a slot on the timeline or a row in Gate events to see the bus, its documents and everything the gates recorded.</div>`;
    const v = VEH[plateKey(b.plate)] || { body: '—', type: '—', cpc: '—', orcr: '—' }, evs = log.filter(e => e.bid === b.id).slice().reverse();
    const cls = e => e.resolution === 'DENIED' || e.decision === 'DENY' ? 'bad' : e.decision === 'HOLD' || e.pending ? 'mid' : 'ok';
    const pend = evs.find(e => e.pending), t = todayISO();
    return `<div class="ph"><h2>${esc(b.id)}</h2>${bpill(b)}</div><div class="pb">
      <div class="muted" style="font-size:13px">${esc(OPS[b.op] ? OPS[b.op].name : b.op)} · ${esc(opTrade(b.op))}</div><h3>${esc(b.dest)}</h3>
      <dl class="kv"><dt>ETD</dt><dd>${fmt(b.dep)}</dd><dt>Bay slot</dt><dd>${esc(b.bay)} · ${fmt(b.slot)}–${fmt(b.dep)}</dd>
      <dt>Bus</dt><dd>${plateChip(b.plate)} body ${esc(v.body)}</dd><dt>Type</dt><dd>${esc(v.type)}</dd>
      <dt>CPC validity</dt><dd class="${v.cpc < t ? 'exp' : ''}">${esc(v.cpc)}</dd><dt>OR/CR validity</dt><dd class="${v.orcr < t ? 'exp' : ''}">${esc(v.orcr)}</dd></dl>
      ${pend ? `<div class="warnbox">${esc(pend.reason)}</div><div class="actions" style="margin-bottom:14px"><button class="btn primary" data-act="allow" data-id="${pend.id}">Open barrier</button><button class="btn danger" data-act="deny" data-id="${pend.id}">Keep closed</button></div>` : ''}
      <h2 style="margin-bottom:10px">Gate history</h2>
      ${evs.length ? `<ul class="hist">${evs.map(e => `<li class="${cls(e)}"><span class="ht">${fmt(e.at)}</span> ${esc(gateName(e.gate))} · ${e.resolution ? (e.resolution === 'ALLOWED' ? 'Allowed by admin' : 'Denied by admin') + ' at ' + fmt(e.resolvedAt) : (DEC[e.decision] || [e.decision])[0]}<div class="muted">${esc(e.reason)}</div></li>`).join('')}</ul>` : `<p class="muted" style="margin:0">No gate reads yet for this bus.</p>`}
      <p class="hint">Booking changes are made in CTS. TOS only records what happens at the gate.</p></div>`;
  }
  function updateBays() {
    setHTML($('#gantt'), ganttHTML());
    const ws = Math.floor((now - 60) / 30) * 30, nl = $('#nowline'); if (nl) nl.style.left = (72 + (now - ws) * PX) + 'px';
    setHTML($('#detail'), detailHTML());
  }

  /* ---------- Passenger board ---------- */
  const boardRows = () => bookings.map(b => ({ dep: b.dep, slot: b.slot, arrivedAt: b.arrivedAt, departedAt: b.departedAt, denied: b.denied, held: b.held, review: log.some(e => e.pending && e.bid === b.id), dest: b.dest, trade: opTrade(b.op), bay: b.bay }));
  function buildBoard() {
    return `<div class="board"><div class="board-top"><div class="ttl">Departures<small>Pag-alis · Parañaque Integrated Terminal Exchange</small></div><div class="board-clock" id="bclock"></div></div>
      <div class="board-scroll" id="bdep"></div></div>
      <p class="hint">Concourse screens show the public version at <a href="board.html" target="_blank" rel="noopener">board.html</a> — no login needed. Remarks follow the gate reads: “Bus at bay” when the entry camera lets the bus in, cleared when the exit camera sees it leave.</p>`;
  }
  function updateBoard() { setHTML($('#bclock'), fmt(now)); setHTML($('#bdep'), window.TOSBoard.table(boardRows(), now, rules.grace)); }

  /* ---------- Overview ---------- */
  function buildOverview() {
    return head('Overview', `Gate activity for ${dayLabel()}, from the first bus in to now.`) +
      `<div class="kpis" id="kpis"></div>
      <div class="mgrid"><section class="panel"><div class="ph"><h2>Gate entries per hour</h2><div class="leg"><span style="--c:var(--accent)">Let in</span><span style="--c:var(--crit)">Turned away</span></div></div><div class="pb chart" id="perhour"></div></section>
      <section class="panel"><div class="ph"><h2>Why buses were stopped</h2></div><div class="tscroll" id="reasons"></div></section></div>`;
  }
  function updateOverview() {
    const ent = log.filter(e => GATES[e.gate] && GATES[e.gate].dir === 'entry');
    const inn = ent.filter(e => e.opened), den = ent.filter(e => e.decision === 'DENY' || e.resolution === 'DENIED');
    const arrived = bookings.filter(b => b.arrivedAt != null);
    const onT = arrived.filter(b => b.arrivedAt - b.slot <= rules.grace).length;
    const late = ent.filter(e => e.cat === 'Late').length, ns = bookings.filter(b => bStatus(b) === 'No-show').length, unreg = ent.filter(e => e.cat === 'Unregistered vehicle').length;
    setHTML($('#kpis'), [['Buses let in', inn.length, `of ${bookings.filter(b => b.slot <= now).length} slots due so far`], ['On-time arrivals', arrived.length ? Math.round(onT / arrived.length * 100) + '%' : '—', `within ${rules.grace}-min grace`],
      ['Turned away', den.length, `${unreg} unregistered plates`], ['Late arrivals', late, 'sent to admin or denied'], ['No-shows', ns, 'slot passed, bus never read'], ['Waiting for admin', pending().length, 'at the gate now']]
      .map(([l, v, s]) => `<div class="panel kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join(''));
    const W = 720, Hh = 230, pl = 34, pb = 26, pt = 10, hrs = []; for (let h = 5; h <= 22; h++) hrs.push(h);
    const when = e => (e.resolvedAt != null ? e.resolvedAt : e.at);
    const data = hrs.map(h => ({ h, a: inn.filter(e => Math.floor(when(e) / 60) === h).length, d: den.filter(e => Math.floor(when(e) / 60) === h).length }));
    const ymax = Math.max(4, Math.ceil(Math.max(...data.map(d => Math.max(d.a, d.d))) / 4) * 4), bw = (W - pl - 6) / hrs.length, y = v => pt + (Hh - pt - pb) * (1 - v / ymax), cur = Math.floor(now / 60);
    let svg = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Gate entries per hour">`;
    [0, ymax / 2, ymax].forEach(v => { svg += `<line x1="${pl}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="Inter, sans-serif">${v}</text>`; });
    data.forEach((d, i) => {
      const x = pl + i * bw + bw * .14, w = bw * .34;
      if (d.a) svg += `<rect x="${x}" y="${y(d.a)}" width="${w}" height="${y(0) - y(d.a)}" rx="2" fill="var(--accent)"/>`;
      if (d.d) svg += `<rect x="${x + w + 2}" y="${y(d.d)}" width="${w}" height="${y(0) - y(d.d)}" rx="2" fill="var(--crit)"/>`;
      if (i % 2 === 0 || d.h === cur) svg += `<text x="${pl + i * bw + bw / 2}" y="${Hh - 8}" text-anchor="middle" font-size="11" fill="${d.h === cur ? 'var(--ink)' : 'var(--muted)'}" font-weight="${d.h === cur ? 700 : 400}" font-family="Inter, sans-serif">${pad(d.h)}</text>`;
    });
    setHTML($('#perhour'), svg + '</svg>');
    const g = {}; ent.filter(e => e.decision !== 'ALLOW').forEach(e => { const k = e.cat || 'Other'; g[k] = g[k] || { n: 0, a: 0, d: 0 }; g[k].n++; if (e.resolution === 'ALLOWED') g[k].a++; else if (e.decision === 'DENY' || e.resolution === 'DENIED') g[k].d++; });
    const rows = Object.entries(g).sort((a, b) => b[1].n - a[1].n);
    setHTML($('#reasons'), rows.length ? `<table><thead><tr><th>Reason</th><th>Stops</th><th>Let in after</th><th>Denied</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num">${v.a}</td><td class="num">${v.d}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No buses stopped yet today.</div>');
  }

  /* ---------- CTS feed ---------- */
  function buildCts() {
    return head('CTS feed', 'What TOS receives from CTS: approved bay bookings for today and the operator vehicle masterfile. TOS reads these; it never edits them.', `<span class="muted" style="font-weight:600">${vehicles.length} vehicles registered across all operators</span>`) +
      `<div class="toolbar"><input class="search" id="cts-q" type="search" placeholder="Plate no., operator, body no., destination" value="${esc(ctsQuery)}">
      <div class="seg" role="group" aria-label="Dataset">${[['bookings', 'Approved bookings'], ['vehicles', 'Vehicle masterfile'], ['expired', 'Expired documents']].map(([k, l]) => `<button data-act="ct" data-v="${k}" aria-pressed="${k === ctsTab}">${l}</button>`).join('')}</div></div>
      <section class="panel"><div class="tscroll" id="ctstable"></div></section>`;
  }
  function updateCts() {
    const q = ctsQuery.toLowerCase(), m = (...xs) => !q || xs.join(' ').toLowerCase().includes(q), t = todayISO();
    if (ctsTab === 'bookings') {
      const rows = bookings.filter(b => m(b.id, b.dest, b.plate, OPS[b.op] && OPS[b.op].name, opTrade(b.op), VEH[plateKey(b.plate)] && VEH[plateKey(b.plate)].body)).filter(b => q || b.dep >= now - 30).slice(0, 60);
      setHTML($('#ctstable'), rows.length ? `<table><thead><tr><th>Booking</th><th>ETD</th><th>Destination</th><th>Operator</th><th>Plate</th><th>Bay slot</th><th>TOS status</th></tr></thead><tbody>${rows.map(b =>
        `<tr data-act="selb" data-id="${esc(b.id)}"><td class="num">${esc(b.id)}</td><td class="num">${fmt(b.dep)}</td><td>${esc(String(b.dest).toUpperCase())}</td><td class="muted">${esc(opTrade(b.op))}</td><td>${plateChip(b.plate)}</td><td class="num">${esc(b.bay)} · ${fmt(b.slot)}</td><td>${bpill(b)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No bookings match that search.</div>');
    } else {
      const rows = vehicles.filter(v => (ctsTab !== 'expired' || expired(v)) && m(v.plate, v.body, OPS[v.op] && OPS[v.op].name, opTrade(v.op)));
      setHTML($('#ctstable'), rows.length ? `<table><thead><tr><th>Plate</th><th>Body number</th><th>Operator</th><th>Trade name</th><th>Bus type</th><th>CPC validity</th><th>OR/CR validity</th></tr></thead><tbody>${rows.map(v =>
        `<tr><td>${plateChip(v.plate)}</td><td class="num">${esc(v.body)}</td><td>${esc(OPS[v.op] ? OPS[v.op].name : v.op)}</td><td class="muted">${esc(opTrade(v.op))}</td><td class="muted">${esc(v.type)}</td><td class="num${v.cpc < t ? ' exp' : ''}">${esc(v.cpc)}</td><td class="num${v.orcr < t ? ' exp' : ''}">${esc(v.orcr)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No vehicles match that search.</div>');
    }
  }

  /* ---------- Devices & rules ---------- */
  function buildDevices() {
    const sel = (id, v, opts) => `<select id="${id}">${opts.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    const act = [['DENY', 'Keep barrier closed'], ['REVIEW', 'Ask admin']];
    const num = (id, v, min, max, step, unit) => `<div style="display:flex;gap:8px;align-items:center"><input id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${v}"><span>${unit}</span></div>`;
    return head('Devices & rules', 'The gate rules TOS applies to every read, and the hardware it talks to. Hardware is still being finalized, so each device connects through the gate endpoint and the rules stay the same whichever vendor is chosen.') +
      `<section class="panel" style="margin-bottom:20px"><div class="ph"><h2>How TOS connects</h2></div>
      <div class="flow">
        <div class="fbox"><b>CTS</b><span>Approved bay bookings</span><span>Operator, franchise &amp; vehicle masterfile</span></div>
        <div class="farrow" aria-hidden="true">→</div>
        <div class="fbox core"><b>TOS gate rules</b><span>Match plate to booking and masterfile, check slot timing and documents, decide: open, staging, admin, or deny</span></div>
        <div class="farrow" aria-hidden="true">⇄</div>
        <div class="fstack"><div class="fbox"><b>Gate endpoint</b><span>LPR cameras, RFID, boom barriers post reads and get open / closed back</span></div><div class="fbox"><b>Outputs</b><span>Concourse and bay displays, admin alerts</span></div></div>
      </div></section>
      <div class="mgrid">
        <section class="panel"><div class="ph"><h2>Gate rules</h2><span class="muted" style="font-size:12.5px">Saved to Supabase, applies to every gate</span></div><div class="rules">
          <div class="rule"><div><b>Early entry window</b><span>Buses earlier than this before their slot wait in staging.</span></div>${num('r-early', rules.early, 0, 180, 5, 'min')}</div>
          <div class="rule"><div><b>Late grace period</b><span>Minutes after slot start a bus still enters automatically.</span></div>${num('r-grace', rules.grace, 0, 60, 5, 'min')}</div>
          <div class="rule"><div><b>Late beyond grace</b><span>What happens when a bus misses its slot.</span></div>${sel('r-late', rules.late, act)}</div>
          <div class="rule"><div><b>Expired CPC or OR/CR</b><span>Checked against the CTS masterfile on every read.</span></div>${sel('r-docs', rules.docs, act)}</div>
          <div class="rule"><div><b>No booking today</b><span>Registered bus with no approved slot.</span></div>${sel('r-nobook', rules.nobook, act)}</div>
          <div class="rule"><div><b>Unregistered plate</b><span>Plate not found in the masterfile.</span></div>${sel('r-unreg', rules.unreg, act)}</div>
          <div class="rule"><div><b>Minimum plate read confidence</b><span>Below this, admin confirms on camera.</span></div>${num('r-conf', rules.conf, 0, 100, 1, '%')}</div>
        </div></section>
        <section class="panel"><div class="ph"><h2>Connected devices</h2></div><div class="tscroll" id="devtable"></div></section>
      </div>`;
  }
  function updateDevices() {
    const sp = { online: 's-bay', offline: 's-cancel', planned: 's-sched', 'not installed': 's-done' };
    setHTML($('#devtable'), `<table><thead><tr><th>Location</th><th>Device</th><th>Status</th></tr></thead><tbody>${DEVICES.map(d => `<tr><td>${esc(d.location)}</td><td><b>${esc(d.kind)}</b><div class="muted" style="font-size:12.5px">${esc(d.role || '')}</div></td><td>${pill(d.status.charAt(0).toUpperCase() + d.status.slice(1), sp[d.status] || 's-done')}${d.last_heartbeat ? `<div class="muted" style="font-size:12px;margin-top:3px">last seen ${fmt(mm(d.last_heartbeat))}</div>` : ''}</td></tr>`).join('')}</tbody></table>`);
  }
  async function saveRule(col, val) {
    const { data, error } = await sb.from('rules').update({ [col]: val, updated_at: new Date().toISOString() }).eq('id', 1).select().single();
    if (error) return toast('Could not save rule: ' + error.message);
    setRules(data); toast('Rule saved. Applies from the next vehicle read.');
  }

  /* ---------- Routing & rendering ---------- */
  const BUILD = { overview: buildOverview, gates: buildGates, bays: buildBays, board: buildBoard, cts: buildCts, devices: buildDevices };
  const UPDATE = { overview: updateOverview, gates: updateGates, bays: updateBays, board: updateBoard, cts: updateCts, devices: updateDevices };
  function go() {
    const h = location.hash.slice(1); view = VIEWS.includes(h) ? h : 'gates';
    document.querySelectorAll('.nav a').forEach(a => a.setAttribute('aria-current', a.getAttribute('href') === '#' + view ? 'page' : 'false'));
    $('#app').classList.remove('open'); $('#scrim').hidden = true;
    $('#main').innerHTML = BUILD[view]();
    if (view === 'cts') $('#cts-q').addEventListener('input', e => { ctsQuery = e.target.value; updateCts(); });
    if (view === 'devices') {
      const bind = (id, col, isNum) => $('#' + id).addEventListener('change', e => { const v = isNum ? Math.max(0, parseInt(e.target.value, 10) || 0) : e.target.value; saveRule(col, v); });
      bind('r-early', 'early_min', 1); bind('r-grace', 'grace_min', 1); bind('r-conf', 'min_confidence', 1);
      bind('r-late', 'on_late'); bind('r-docs', 'on_expired'); bind('r-nobook', 'on_no_booking'); bind('r-unreg', 'on_unregistered');
    }
    render();
  }
  function render() {
    now = nowMin();
    const p = pending().length; $('#badge').textContent = p; $('#badge').hidden = !p;
    $('#clk').textContent = fmt(now); $('#clk-sub').textContent = dayLabel() + ' · Manila time';
    UPDATE[view]();
  }
  let refreshing = null;
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = loadDay().then(render).catch(err => toast(err.message)).finally(() => { refreshing = null; });
    return refreshing;
  }

  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const a = el.dataset.act, v = el.dataset.v, id = el.dataset.id;
    switch (a) {
      case 'ff': feedFilter = v; el.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === el ? 'true' : 'false')); break;
      case 'ct': ctsTab = v; el.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === el ? 'true' : 'false')); break;
      case 'selb': selected = id; if (view !== 'bays') { location.hash = 'bays'; return; } break;
      case 'allow': case 'deny': {
        el.disabled = true;
        const { error } = await sb.rpc('resolve_review', { p_event: Number(id), p_allow: a === 'allow' });
        if (error) toast(error.message); else toast(a === 'allow' ? 'Barrier opened' : 'Vehicle kept out');
        await refresh(); return;
      }
      case 'sim': el.disabled = true; await simulate(v); el.disabled = false; return;
      case 'closepf': document.getElementById('plateform')?.remove(); return;
      case 'signout': await sb.auth.signOut(); location.reload(); return;
    }
    render();
  });

  /* ---------- Sign-in and start ---------- */
  async function start(session) {
    $('#login').hidden = true; $('#app').hidden = false;
    const email = session.user.email || '';
    $('#avatar').textContent = (email.split('@')[0].replace(/[^a-z]/gi, '').slice(0, 2) || 'PT').toUpperCase();
    $('#user-email').textContent = email;
    const staff = await sb.rpc('is_staff');
    if (staff.error || !staff.data) {
      $('#main').innerHTML = `<div class="panel pb" style="max-width:640px"><h1>Account not yet authorised</h1><p class="muted">You're signed in as ${esc(email)}, but this account isn't on the TOS staff list. Ask the system administrator to add it, then sign in again.</p><button class="btn" data-act="signout">Sign out</button></div>`;
      return;
    }
    try { await loadStatic(); await loadDay(); }
    catch (err) { $('#main').innerHTML = `<div class="panel pb"><h1>Could not load data</h1><p class="muted">${esc(err.message)}</p><p class="muted">Check that schema.sql and seed.sql have been run in this Supabase project, and that this account can sign in.</p></div>`; return; }

    sb.channel('tos-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gate_events' }, payload => {
        if (payload.eventType === 'INSERT' && payload.new.pending) toast(`${payload.new.plate} waiting for a decision at ${gateName(payload.new.gate_id)}`);
        refresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => refresh())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rules' }, payload => { setRules(payload.new); render(); })
      .subscribe();

    window.addEventListener('hashchange', go);
    setInterval(render, 15000);
    setInterval(refresh, 120000);
    go();
  }

  const narrow = () => window.matchMedia('(max-width:900px)').matches;
  $('#menubtn').addEventListener('click', () => { const app = $('#app'); if (narrow()) { app.classList.remove('collapsed'); const o = app.classList.toggle('open'); $('#scrim').hidden = !o; } else app.classList.toggle('collapsed'); });
  $('#scrim').addEventListener('click', () => { $('#app').classList.remove('open'); $('#scrim').hidden = true; });
  $('#bell').addEventListener('click', () => { if (view === 'gates') $('#reviews')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); else location.hash = 'gates'; });
  $('#avatar').addEventListener('click', () => { $('#usermenu').hidden = !$('#usermenu').hidden; });
  document.addEventListener('click', e => { if (!e.target.closest('#avatar,#usermenu')) $('#usermenu').hidden = true; });

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#login-btn'), err = $('#login-err');
    btn.disabled = true; err.textContent = '';
    const { data, error } = await sb.auth.signInWithPassword({ email: $('#login-email').value.trim(), password: $('#login-password').value });
    btn.disabled = false;
    if (error) { err.textContent = error.message === 'Invalid login credentials' ? 'Email or password is incorrect.' : error.message; return; }
    start(data.session);
  });

  sb.auth.getSession().then(({ data }) => {
    if (data.session) start(data.session);
    else { $('#login').hidden = false; $('#login-email').focus(); }
  });
})();
