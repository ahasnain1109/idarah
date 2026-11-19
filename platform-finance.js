/**
 * Idarah platform - Finance tab of a module: funds, donations, expenses,
 * receipts, reversals and ledger verification.
 * platform-finance.js
 *
 * The browser only collects input. The database enforces every money rule
 * (overdraft, Zakat categories, append-only ledger, hash chain, receipt numbers,
 * reversal mirroring), so nothing here can be bypassed from the console.
 */
(function () {
  'use strict';

  const P = window.IdarahPlatform;
  const esc = window.escapeHtml;
  const money = window.formatCurrency;

  // ---- tiny accessible modal -------------------------------------------------

  function openModal(title, bodyHtml) {
    const previous = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.innerHTML = '<div class="modal-dialog"><div class="modal-header"><h3 class="modal-title">' + esc(title) +
      '</h3><button type="button" class="modal-close-btn" aria-label="Close">✕</button></div><div class="modal-body">' + bodyHtml + '</div></div>';
    document.body.appendChild(overlay);

    function close() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (previous && previous.focus && previous.isConnected) previous.focus();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    const first = overlay.querySelector('input, select, textarea, button.btn');
    if (first) first.focus();
    return { el: overlay, close };
  }

  const opt = (list, selected) => list.map(c => '<option value="' + esc(c[0]) + '"' + (c[0] === selected ? ' selected' : '') + '>' + esc(c[1]) + '</option>').join('');
  const istDate = iso => (typeof window.getISTTimestamp === 'function' ? window.getISTTimestamp(new Date(iso)) : iso);

  // ---- main renderer -----------------------------------------------------------

  /**
   * host: element to render into; mod: organization_modules row;
   * ctx: { committee: {id,name}, canWrite: boolean }
   */
  P.renderFinance = async function (host, mod, ctx) {
    host.innerHTML = '<div class="card pf-center" aria-busy="true"><div class="pf-spinner"></div><p>Loading finance…</p></div>';

    let funds, balances, entries;
    try {
      [funds, balances, entries] = await Promise.all([
        P.api.listFunds(mod.id), P.api.fundBalances(mod.id), P.api.listLedger(mod.id, 200)
      ]);
    } catch (err) {
      host.innerHTML = '<div class="card"><p class="pf-form-error">' + esc(err.message) + '</p>' +
        '<button class="btn btn-primary" id="pf-fin-retry">Try again</button></div>';
      host.querySelector('#pf-fin-retry').addEventListener('click', () => P.renderFinance(host, mod, ctx));
      return;
    }

    const fundById = Object.fromEntries(funds.map(f => [f.id, f]));
    const reversed = new Set(entries.filter(e => e.reverses_entry_id).map(e => e.reverses_entry_id));
    const total = Object.values(balances).reduce((a, b) => a + b, 0);
    const refresh = () => P.renderFinance(host, mod, ctx);

    const badge = e => e.type === 'donation' ? ['badge-general', '📥 Donation'] : e.type === 'expense' ? ['badge-zakat', '📤 Expense'] : ['badge-zakat', '🔄 Reversal'];

    host.innerHTML =
      '<div class="card-header"><div><h3 class="card-title">💰 Finance</h3>' +
      '<p class="card-subtitle">Total across funds: <strong>' + esc(money(total)) + '</strong></p></div>' +
      '<div class="pf-btnrow">' +
      (ctx.canWrite ? '<button class="btn btn-primary btn-sm" id="fin-donation">➕ Donation</button><button class="btn btn-secondary btn-sm" id="fin-expense">➖ Expense</button>' : '') +
      '<button class="btn btn-outline btn-sm" id="fin-verify">🔍 Verify ledger</button></div></div>' +
      '<div id="fin-banner" aria-live="polite"></div>' +
      '<div class="metrics-grid">' + funds.map(f => {
        const bal = balances[f.id] || 0;
        return '<div class="metric-card ' + (f.is_zakat_eligible ? 'zakat-restricted' : 'general-fund') + '">' +
          '<div class="metric-card-title">' + esc(f.name) + '</div><div class="metric-card-amount">' + esc(money(bal)) + '</div>' +
          '<span class="metric-card-badge ' + (f.is_zakat_eligible ? 'badge-zakat' : 'badge-general') + '">' +
          (f.is_zakat_eligible ? '⚠️ Zakat-restricted' : '✅ General') + '</span></div>';
      }).join('') + '</div>' +
      '<div class="card"><h4 style="margin-bottom:10px">Transactions (' + entries.length + (entries.length === 200 ? '+, latest 200' : '') + ')</h4>' +
      (entries.length === 0 ? '<p class="card-subtitle">No transactions yet.</p>' :
        '<div class="table-responsive"><table class="data-table"><thead><tr><th>#</th><th>Date (IST)</th><th>Type</th><th>Fund</th><th>Details</th><th>Amount</th><th>Receipt</th><th>Hash</th><th></th></tr></thead><tbody>' +
        entries.map(e => {
          const isRev = e.type === 'reversal';
          const wasReversed = reversed.has(e.id);
          const b = badge(e);
          const sign = e.type === 'donation' ? '+' : '-';
          const amtClass = e.type === 'donation' ? 'amount-positive' : 'amount-negative';
          const fund = fundById[e.fund_id];
          return '<tr class="' + (wasReversed ? 'row-reversed' : isRev ? 'row-reversal' : '') + '">' +
            '<td><strong>#' + e.seq + '</strong></td><td style="white-space:nowrap">' + esc(istDate(e.entry_date)) + '</td>' +
            '<td><span class="metric-card-badge ' + b[0] + '">' + esc(b[1]) + '</span>' + (wasReversed ? '<div class="pf-field-error">(Reversed)</div>' : '') + '</td>' +
            '<td>' + esc(fund ? fund.name : '—') + '</td>' +
            '<td><strong>' + esc(P.categoryLabel(e.category)) + '</strong><div class="card-subtitle">' +
            esc(e.type === 'donation' ? (e.donor_name || 'Anonymous') + ' · ' + (e.method || '') : (e.note || '')) + '</div></td>' +
            '<td class="' + amtClass + '">' + sign + esc(money(e.amount)) + '</td>' +
            '<td>' + (e.receipt_no ? '<button class="btn btn-outline btn-sm fin-receipt" data-id="' + esc(e.id) + '">🧾 ' + esc(e.receipt_no) + '</button>' : '—') + '</td>' +
            '<td><span class="hash-badge" title="' + esc(e.hash) + '">' + esc((e.hash || '').slice(0, 10)) + '…</span></td>' +
            '<td>' + (ctx.canWrite && !isRev && !wasReversed ? '<button class="btn btn-danger btn-sm fin-reverse" data-id="' + esc(e.id) + '">Reverse</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>') + '</div>';

    // ---- events
    host.querySelector('#fin-verify').addEventListener('click', async (ev) => {
      const banner = host.querySelector('#fin-banner');
      try {
        const v = await P.withLoading(ev.currentTarget, 'Checking…', () => P.api.verifyLedger(ctx.committee.id));
        banner.innerHTML = v.valid
          ? '<div class="integrity-banner intact"><span>✅ Ledger intact: ' + v.count + ' blocks verified</span><span style="font-family:monospace;font-size:.8rem">Last hash: ' + esc((v.last_hash || '').slice(0, 16)) + '…</span></div>'
          : '<div class="integrity-banner tampered"><span>🚨 Tampering detected at block #' + esc(v.broken_seq) + '</span></div>';
      } catch (err) { banner.innerHTML = '<div class="integrity-banner tampered">' + esc(err.message) + '</div>'; }
    });

    const don = host.querySelector('#fin-donation');
    if (don) don.addEventListener('click', () => donationModal(mod, ctx, funds, refresh));
    const exp = host.querySelector('#fin-expense');
    if (exp) exp.addEventListener('click', () => expenseModal(mod, ctx, funds, balances, refresh));
    host.querySelectorAll('.fin-receipt').forEach(b => b.addEventListener('click', () => {
      const e = entries.find(x => x.id === b.dataset.id);
      if (e) receiptModal(e, mod, ctx, fundById[e.fund_id]);
    }));
    host.querySelectorAll('.fin-reverse').forEach(b => b.addEventListener('click', () => {
      const e = entries.find(x => x.id === b.dataset.id);
      if (e) reverseModal(e, mod, ctx, fundById[e.fund_id], refresh);
    }));
  };

  // ---- donation --------------------------------------------------------------

  function amountOk(v) { return Number.isFinite(v) && v > 0 && v <= 99999999.99; }

  function donationModal(mod, ctx, funds, done) {
    const m = openModal('Record Donation',
      '<form id="fin-form" novalidate>' +
      '<div class="form-group"><label class="form-label" for="d-amt">Amount (₹) *</label><input id="d-amt" class="form-control" type="number" inputmode="decimal" min="0.01" step="0.01" required /></div>' +
      '<div class="form-group"><label class="form-label" for="d-fund">Fund *</label><select id="d-fund" class="form-control">' +
      funds.map(f => '<option value="' + esc(f.id) + '">' + esc(f.name) + (f.is_zakat_eligible ? ' (Zakat-restricted)' : '') + '</option>').join('') + '</select></div>' +
      '<div class="form-group"><label class="form-label" for="d-cat">Purpose *</label><select id="d-cat" class="form-control">' + opt(P.DONATION_CATEGORIES) + '</select></div>' +
      '<div class="form-group"><label class="form-label" for="d-method">Payment method *</label><select id="d-method" class="form-control">' + opt(P.PAYMENT_METHODS) + '</select></div>' +
      '<div class="form-group"><label class="form-label" for="d-name">Donor name <small>(blank = Anonymous)</small></label><input id="d-name" class="form-control" maxlength="100" /></div>' +
      '<div class="form-group"><label class="form-label" for="d-phone">Donor mobile <small>(optional)</small></label><input id="d-phone" class="form-control" type="tel" inputmode="numeric" maxlength="10" /></div>' +
      '<div class="form-group"><label class="form-label" for="d-note">Note</label><input id="d-note" class="form-control" maxlength="200" /></div>' +
      '<div id="fin-err" class="pf-form-error" role="alert"></div>' +
      '<button type="submit" class="btn btn-primary btn-block" id="fin-save">🧾 Save & Generate Receipt</button></form>');
    const q = s => m.el.querySelector(s);
    q('#d-phone').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); });
    q('#fin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const amount = Number(q('#d-amt').value);
      const phone = q('#d-phone').value.trim();
      if (!amountOk(amount)) return (q('#fin-err').textContent = 'Enter an amount greater than zero.');
      if (phone && !P.PHONE_RE.test(phone)) return (q('#fin-err').textContent = 'Enter a valid 10-digit mobile number or leave it blank.');
      q('#fin-err').textContent = '';
      try {
        const entry = await P.withLoading(q('#fin-save'), 'Saving…', () => P.api.addLedgerEntry({
          committee_id: ctx.committee.id, module_id: mod.id, type: 'donation', amount,
          fund_id: q('#d-fund').value, method: q('#d-method').value, category: q('#d-cat').value,
          note: q('#d-note').value.trim() || null,
          donor_name: q('#d-name').value.trim() || 'Anonymous', donor_phone: phone || null
        }));
        m.close(); P.toast('Donation recorded: ' + entry.receipt_no, 'success');
        const fund = funds.find(f => f.id === entry.fund_id);
        done(); receiptModal(entry, mod, ctx, fund);
      } catch (err) { q('#fin-err').textContent = err.message; P.toast(err.message, 'error'); }
    });
  }

  // ---- expense ---------------------------------------------------------------

  function expenseModal(mod, ctx, funds, balances, done) {
    const catsFor = f => f && f.is_zakat_eligible ? P.ZAKAT_CATEGORIES : P.GENERAL_EXPENSE_CATEGORIES;
    const m = openModal('Record Expense',
      '<form id="fin-form" novalidate>' +
      '<div class="form-group"><label class="form-label" for="x-fund">Fund *</label><select id="x-fund" class="form-control">' +
      funds.map(f => '<option value="' + esc(f.id) + '">' + esc(f.name) + (f.is_zakat_eligible ? ' (Zakat-restricted)' : '') + '</option>').join('') + '</select>' +
      '<div id="x-bal" class="card-subtitle" style="font-weight:600"></div></div>' +
      '<div class="form-group"><label class="form-label" for="x-cat">Category *</label><select id="x-cat" class="form-control"></select>' +
      '<div id="x-zakat" class="card-subtitle" style="color:#b45309;font-weight:600" hidden>Zakat funds may only be spent on Zakat-eligible categories.</div></div>' +
      '<div class="form-group"><label class="form-label" for="x-amt">Amount (₹) *</label><input id="x-amt" class="form-control" type="number" inputmode="decimal" min="0.01" step="0.01" required /></div>' +
      '<div class="form-group"><label class="form-label" for="x-note">Description / purpose</label><input id="x-note" class="form-control" maxlength="200" /></div>' +
      '<div id="fin-err" class="pf-form-error" role="alert"></div>' +
      '<button type="submit" class="btn btn-danger btn-block" id="fin-save">📦 Save Expense</button></form>');
    const q = s => m.el.querySelector(s);
    function sync() {
      const f = funds.find(x => x.id === q('#x-fund').value);
      q('#x-bal').textContent = 'Available in this fund: ' + money(balances[f.id] || 0);
      q('#x-cat').innerHTML = opt(catsFor(f));
      q('#x-zakat').hidden = !f.is_zakat_eligible;
    }
    q('#x-fund').addEventListener('change', sync);
    sync();
    q('#fin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = funds.find(x => x.id === q('#x-fund').value);
      const amount = Number(q('#x-amt').value);
      if (!amountOk(amount)) return (q('#fin-err').textContent = 'Enter an amount greater than zero.');
      if (amount > (balances[f.id] || 0)) return (q('#fin-err').textContent = 'Not enough money in ' + f.name + '. Available: ' + money(balances[f.id] || 0) + '.');
      q('#fin-err').textContent = '';
      try {
        const entry = await P.withLoading(q('#fin-save'), 'Saving…', () => P.api.addLedgerEntry({
          committee_id: ctx.committee.id, module_id: mod.id, type: 'expense', amount, fund_id: f.id,
          method: 'Cash', category: q('#x-cat').value, note: q('#x-note').value.trim() || null
        }));
        m.close(); P.toast('Expense recorded (block #' + entry.seq + ').', 'success'); done();
      } catch (err) { q('#fin-err').textContent = err.message; P.toast(err.message, 'error'); }
    });
  }

  // ---- receipt -----------------------------------------------------------------

  function receiptModal(e, mod, ctx, fund) {
    const text = ['*' + ctx.committee.name + ' — ' + mod.module_name + '*', 'Donation Receipt',
      'Receipt No: ' + e.receipt_no, 'Verification Code: ' + e.verify_code, 'Date: ' + istDate(e.entry_date),
      'Donor: ' + (e.donor_name || 'Anonymous'), 'Amount: ' + money(e.amount), 'Fund: ' + (fund ? fund.name : ''),
      'Method: ' + (e.method || ''), 'Digest: ' + (e.hash || '').slice(0, 16) + '…', 'JazakAllah Khair 🤲'].join('\n');
    const row = (l, v, strong) => '<div class="receipt-row"><span class="receipt-label">' + esc(l) + '</span><span class="receipt-val"' + (strong ? ' style="font-size:1.15rem;color:var(--success)"' : '') + '>' + esc(v) + '</span></div>';
    const m = openModal('Official Receipt',
      '<div class="receipt-box"><div class="receipt-watermark" aria-hidden="true">AUTHENTIC</div>' +
      '<div style="text-align:center;margin-bottom:14px"><h4 style="color:var(--primary)">' + esc(ctx.committee.name) + '</h4>' +
      '<div class="card-subtitle">' + esc(mod.module_name) + '</div></div>' +
      row('Receipt No', e.receipt_no) + row('Verification Code', e.verify_code) + row('Date (IST)', istDate(e.entry_date)) +
      row('Donor', e.donor_name || 'Anonymous') + row('Amount', money(e.amount), true) + row('Fund', fund ? fund.name : '—') + row('Method', e.method || '—') +
      '<div class="receipt-row" style="flex-direction:column;gap:4px;border-bottom:none"><span class="receipt-label">SHA-256 block digest</span>' +
      '<span style="font-family:monospace;font-size:.7rem;word-break:break-all;background:var(--bg-app);padding:4px 6px;border-radius:6px">' + esc(e.hash) + '</span></div></div>' +
      '<a class="btn btn-whatsapp btn-block" target="_blank" rel="noopener noreferrer" href="https://api.whatsapp.com/send?text=' + encodeURIComponent(text) + '">💬 Share on WhatsApp</a>');
    return m;
  }

  // ---- reversal ----------------------------------------------------------------

  function reverseModal(e, mod, ctx, fund, done) {
    const m = openModal('Reverse Entry #' + e.seq,
      '<form id="fin-form" novalidate>' +
      '<div class="integrity-banner tampered" style="font-weight:500">⚠️ This adds a permanent reversal block that undoes ' + esc(money(e.amount)) +
      ' (' + esc(fund ? fund.name : '') + '). The original entry is never deleted or edited.</div>' +
      '<div class="form-group"><label class="form-label" for="r-reason">Reason *</label><input id="r-reason" class="form-control" maxlength="200" required /></div>' +
      '<div id="fin-err" class="pf-form-error" role="alert"></div>' +
      '<div class="pf-actions"><button type="button" class="btn btn-outline" id="r-cancel">Cancel</button>' +
      '<button type="submit" class="btn btn-danger" id="fin-save">Confirm Reversal</button></div></form>');
    const q = s => m.el.querySelector(s);
    q('#r-cancel').addEventListener('click', m.close);
    q('#fin-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const reason = q('#r-reason').value.trim();
      if (!reason) return (q('#fin-err').textContent = 'Please give a reason.');
      try {
        // amount / fund / category are overwritten by the database to mirror the original entry
        await P.withLoading(q('#fin-save'), 'Saving…', () => P.api.addLedgerEntry({
          committee_id: ctx.committee.id, module_id: mod.id, type: 'reversal', amount: e.amount,
          fund_id: e.fund_id, category: 'reversal', note: reason, reverses_entry_id: e.id
        }));
        m.close(); P.toast('Entry reversed.', 'success'); done();
      } catch (err) { q('#fin-err').textContent = err.message; P.toast(err.message, 'error'); }
    });
  }
})();
