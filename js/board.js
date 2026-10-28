// Departure board rendering shared by the admin app and the public board.html page.
window.TOSBoard = (function () {
  const pad = n => String(n).padStart(2, '0');
  const fmt = m => { m = Math.floor(m); m = ((m % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // r: { dep, slot, arrivedAt, departedAt, denied, held, review } — all times in minutes of the Manila day
  function remark(r, now, grace) {
    if (r.departedAt != null) return ['DEPARTED ' + fmt(r.departedAt), 'r-gone', true];
    if (r.denied || (r.arrivedAt == null && now > r.dep + 20)) return ['CANCELLED · SEE COUNTER', 'r-cancel'];
    if (r.arrivedAt != null) {
      if (now >= r.dep - 5) return ['FINAL CALL', 'r-final'];
      if (now >= r.dep - 15) return ['BOARDING', 'r-board'];
      return ['BUS AT BAY', 'r-board'];
    }
    if (r.held || r.review) return ['BUS ARRIVED', ''];
    if (now > r.slot + grace) return [now > r.dep ? 'DELAYED' : 'BUS NOT YET ARRIVED', 'r-delay'];
    return ['ON TIME', ''];
  }

  function table(rows, now, grace) {
    const list = rows
      .filter(r => (r.departedAt != null ? r.departedAt >= now - 5 : r.dep >= now - 40) && r.dep <= now + 150)
      .sort((a, b) => a.dep - b.dep)
      .slice(0, 15);
    if (!list.length) return '<p class="board-empty">No departures in the next 2½ hours.</p>';
    return `<table class="btab"><thead><tr><th>ETD</th><th>Destination</th><th>Operator</th><th>Bay</th><th>Remarks</th></tr></thead><tbody>${list.map(r => {
      const [txt, cls, gone] = remark(r, now, grace);
      return `<tr class="${gone ? 'gone' : ''}"><td>${fmt(r.dep)}</td><td class="dest">${esc(r.dest)}</td><td>${esc(r.trade)}</td><td><span class="bay-chip">${esc(r.bay || '—')}</span></td><td class="${cls}">${txt}</td></tr>`;
    }).join('')}</tbody></table>`;
  }

  return { table, remark, fmt, esc };
})();
