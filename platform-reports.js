/**
 * Idarah platform - Reports tab: printable monthly financial report per module
 * (or all modules together), in India Standard Time.
 * platform-reports.js
 */
(function () {
  'use strict';

  const P = window.IdarahPlatform;
  const esc = window.escapeHtml;
  const money = window.formatCurrency;

  const istMonthOf = iso => window.getISTDate(new Date(iso)).slice(0, 7);

  /** Signed effect of one ledger entry on the money held (reversals undo their target). */
  function effect(e, byId) {
    if (e.entry_type === 'donation') return { in: e.amount, out: 0 };
    if (e.entry_type === 'expense') return { in: 0, out: e.amount };
    const t = byId[e.reversed_entry_id];
    if (t && t.entry_type === 'donation') return { in: -e.amount, out: 0 };
    return { in: 0, out: -e.amount };     // reversal of an expense gives the money back
  }

  P.renderReports = async function (host, committee, mods, ctx) {
    const months = { sel: window.getISTMonth(), modId: mods.length === 1 ? mods[0].id : 'all' };
    host.innerHTML = P.loadingHtml('Loading report data…');

    const cache = {};   // moduleId -> { entries, funds }
    async function load(mod) {
      if (!cache[mod.id]) {
        const [entries, funds] = await Promise.all([
          P.api.listRows('ledger_entries', {
            moduleId: mod.id, order: 'sequence_no', ascending: true, limit: 5000,
            select: 'id, sequence_no, created_at, entry_type, amount, fund_id, category, notes, donor_or_payee_name, receipt_number, reversed_entry_id, entry_hash, is_reversed'
          }),
          P.api.listFunds(mod.id)
        ]);
        entries.forEach(e => { e.amount = Number(e.amount); });
        cache[mod.id] = { entries, funds };
      }
      return cache[mod.id];
    }

    async function draw() {
      const chosen = months.modId === 'all' ? mods : mods.filter(m => m.id === months.modId);
      const body = host.querySelector('#rep-body');
      body.innerHTML = P.loadingHtml('Calculating…');
      let opening = 0, inflow = 0, outflow = 0;
      const rows = [];
      try {
        for (const mod of chosen) {
          const { entries, funds } = await load(mod);
          const byId = Object.fromEntries(entries.map(e => [e.id, e]));
          const fundName = Object.fromEntries(funds.map(f => [f.id, f.name]));
          entries.forEach(e => {
            const m = istMonthOf(e.created_at);
            const fx = effect(e, byId);
            if (m < months.sel) opening += fx.in - fx.out;
            else if (m === months.sel) { inflow += fx.in; outflow += fx.out; rows.push({ e, mod, fund: fundName[e.fund_id] }); }
          });
        }
      } catch (err) { body.innerHTML = P.errorHtml(err.message); return; }
      const closing = opening + inflow - outflow;
      const showMod = chosen.length > 1;
      const title = months.modId === 'all' ? committee.name + ' — All Modules' : chosen[0].module_name;

      body.innerHTML =
        '<div id="printable-report-wrapper" class="card">' +
        '<div style="text-align:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px">' +
        '<h1 style="font-size:1.5rem;font-weight:800;color:var(--primary)">' + esc(committee.name) + '</h1>' +
        '<p style="font-size:.95rem">' + esc([committee.city, committee.state].filter(Boolean).join(', ')) + '</p>' +
        '<h2 style="font-size:1.2rem;font-weight:700;margin-top:10px">Monthly Financial Report — ' + esc(months.sel) + ' (IST)</h2>' +
        '<div style="font-weight:600">' + esc(title) + '</div>' +
        '<div style="font-size:.8rem;color:var(--text-muted)">Generated: ' + esc(window.getISTTimestamp()) + '</div></div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px;text-align:center">' +
        box('Opening Balance', money(opening), '') + box('Inflow', '+' + money(inflow), 'color:var(--success)') +
        box('Outflow', '-' + money(outflow), 'color:var(--danger)') + box('Closing Balance', money(closing), 'background:var(--primary-light);color:var(--primary)') + '</div>' +
        '<h4 style="margin-bottom:8px">Detailed Ledger</h4>' +
        (rows.length === 0 ? '<p class="card-subtitle">No transactions in this month.</p>' :
          '<div class="table-responsive"><table class="data-table"><thead><tr><th>#</th><th>Date &amp; Time (IST)</th>' + (showMod ? '<th>Module</th>' : '') +
          '<th>Type</th><th>Fund</th><th>Details</th><th>Amount (₹)</th><th>Receipt</th><th>SHA-256</th></tr></thead><tbody>' +
          rows.map(({ e, mod, fund }) => '<tr><td>#' + e.sequence_no + '</td><td style="white-space:nowrap">' + esc(window.getISTTimestamp(new Date(e.created_at))) + '</td>' +
            (showMod ? '<td>' + esc(mod.module_name) + '</td>' : '') + '<td>' + esc(e.entry_type) + (e.is_reversed ? ' (reversed)' : '') + '</td><td>' + esc(fund || '—') + '</td>' +
            '<td>' + esc(P.categoryLabel(e.category)) + (e.notes ? ' (' + esc(e.notes) + ')' : '') + '</td><td><strong>' + esc(money(e.amount)) + '</strong></td>' +
            '<td>' + esc(e.receipt_number || '-') + '</td><td><span class="hash-badge">' + esc((e.entry_hash || '').slice(0, 10)) + '…</span></td></tr>').join('') +
          '</tbody></table></div>') +
        '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:40px;padding-top:20px;border-top:1px dotted #888">' +
        ['Mutawalli / President', 'Treasurer / Secretary', 'Auditor / Stamp'].map(l =>
          '<div style="text-align:center;width:200px"><div style="border-bottom:1px solid #000;height:40px"></div><div style="font-size:.85rem;font-weight:700;margin-top:6px">' + l + '</div></div>').join('') +
        '</div></div>';
    }
    const box = (label, value, style) => '<div style="border:1px solid var(--border-color);padding:10px;border-radius:8px;' + style + '"><div style="font-size:.75rem;font-weight:700">' + esc(label) + '</div><div style="font-size:1.25rem;font-weight:800">' + esc(value) + '</div></div>';

    host.innerHTML =
      '<div class="card-header no-print"><div><h2 class="card-title">📑 Monthly Report</h2><p class="card-subtitle">Printable report with signature boxes</p></div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      (mods.length > 1 ? '<select id="rep-mod" class="form-control" style="width:auto;min-height:40px" aria-label="Module"><option value="all">All modules</option>' +
        mods.map(m => '<option value="' + esc(m.id) + '">' + esc(P.MODULE_DEFS[m.module_type].icon + ' ' + m.module_name) + '</option>').join('') + '</select>' : '') +
      '<input id="rep-month" class="form-control" type="month" value="' + esc(months.sel) + '" style="width:auto;min-height:40px" aria-label="Month" />' +
      '<button class="btn btn-primary" id="rep-print">🖨️ Print / Save as PDF</button></div></div><div id="rep-body"></div>';

    const modSel = host.querySelector('#rep-mod');
    if (modSel) { modSel.value = months.modId; modSel.addEventListener('change', e => { months.modId = e.target.value; draw(); }); }
    host.querySelector('#rep-month').addEventListener('change', e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { months.sel = e.target.value; draw(); } });
    host.querySelector('#rep-print').addEventListener('click', () => window.print());
    await draw();
  };
})();
