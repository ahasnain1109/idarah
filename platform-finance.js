/**
 * Idarah platform - Finance tab of a module: funds (incl. custom funds), donations,
 * expenses, receipts, reversals and ledger verification.
 * platform-finance.js
 *
 * The browser only collects input. The database enforces every money rule
 * (overdraft, the 7 Zakat categories, append-only ledger, hash chain, receipt
 * numbers, reversal mirroring), so nothing here can be bypassed from the console.
 */
(function () {
  'use strict';

  const P = window.IdarahPlatform;
  const esc = window.escapeHtml;
  const money = window.formatCurrency;

  // ---- tiny accessible modal -------------------------------------------------

  const openModal = P.openModal;   // shared accessible modal (platform-ui.js)

  const opt = (list, selected) => list.map(c => '<option value="' + esc(c[0]) + '"' + (c[0] === selected ? ' selected' : '') + '>' + esc(c[1]) + '</option>').join('');
  const istDate = iso => (typeof window.getISTTimestamp === 'function' ? window.getISTTimestamp(new Date(iso)) : iso);
  const amountOk = v => Number.isFinite(v) && v > 0 && v <= 99999999.99;
  const fundOptions = funds => funds.map(f => '<option value="' + esc(f.id) + '">' + esc(f.name) + (f.is_zakat_restricted ? ' (Zakat-restricted)' : '') + '</option>').join('');

  // ---- main renderer -----------------------------------------------------------

  /**
   * host: element to render into; mod: organization_modules row;
   * ctx: { committee: {id,name}, canWrite: boolean }
   */
  // exposed so other screens (e.g. fee collection) can show the same official receipt
  P.showReceipt = (e, mod, ctx, fund) => receiptModal(e, mod, ctx, fund);

  P.renderFinance = async function (host, mod, ctx) {
    host.innerHTML = '<div class="card pf-center" aria-busy="true"><div class="pf-spinner"></div><p>Loading finance…</p></div>';

    let funds, entries;
    try {
      [funds, entries] = await Promise.all([P.api.listFunds(mod.id), P.api.listLedger(mod.id, 200)]);
    } catch (err) {
      host.innerHTML = '<div class="card"><p class="pf-form-error">' + esc(err.message) + '</p>' +
        '<button class="btn btn-primary" id="pf-fin-retry">Try again</button></div>';
      host.querySelector('#pf-fin-retry').addEventListener('click', () => P.renderFinance(host, mod, ctx));
      return;
    }

    const fundById = Object.fromEntries(funds.map(f => [f.id, f]));
    const entryById = Object.fromEntries(entries.map(e => [e.id, e]));
    const reversalOf = {};   // original id -> its reversal entry (if loaded)
    entries.forEach(e => { if (e.reversed_entry_id) reversalOf[e.reversed_entry_id] = e; });
    const total = funds.reduce((a, f) => a + f.current_balance, 0);
    const refresh = () => P.renderFinance(host, mod, ctx);

    const badge = e => e.entry_type === 'donation' ? ['badge-general', '📥 Donation'] : e.entry_type === 'expense' ? ['badge-zakat', '📤 Expense'] : ['badge-zakat', '🔄 Reversal'];

    host.innerHTML =
      '<div class="card-header"><div><h3 class="card-title">💰 Finance</h3>' +
      '<p class="card-subtitle">Total across funds: <strong>' + esc(money(total)) + '</strong></p></div>' +
      '<div class="pf-btnrow">' +
      (ctx.canWrite ? '<button class="btn btn-primary btn-sm" id="fin-donation">➕ Donation</button>' +
        '<button class="btn btn-secondary btn-sm" id="fin-expense">➖ Expense</button>' +
        '<button class="btn btn-outline btn-sm" id="fin-newfund">+ Create New Fund</button>' : '') +
      '<button class="btn btn-outline btn-sm" id="fin-verify">🔍 Verify Ledger</button></div></div>' +
      '<div id="fin-banner" aria-live="polite"></div>' +
      '<div class="metrics-grid">' + funds.map(f =>
        '<div class="metric-card ' + (f.is_zakat_restricted ? 'zakat-restricted' : 'general-fund') + '"' + (f.description ? ' title="' + esc(f.description) + '"' : '') + '>' +
        '<div class="metric-card-title">' + esc(f.name) + '</div><div class="metric-card-amount">' + esc(money(f.current_balance)) + '</div>' +
        '<span class="metric-card-badge ' + (f.is_zakat_restricted ? 'badge-zakat' : 'badge-general') + '">' +
        (f.is_zakat_restricted ? '⚠️ Zakat Restricted' : '✅ General') + '</span>' +
        (f.is_default ? '' : ' <span class="metric-card-badge badge-general">Custom</span>') +
        (f.description ? '<div class="card-subtitle" style="margin-top:6px">' + esc(f.description) + '</div>' : '') + '</div>').join('') + '</div>' +
      '<div class="card"><h4 style="margin-bottom:10px">Transactions (' + entries.length + (entries.length === 200 ? '+, latest 200' : '') + ')</h4>' +
      (entries.length === 0 ? '<p class="card-subtitle">No transactions yet.</p>' :
        '<div class="table-responsive"><table class="data-table"><thead><tr><th>#</th><th>Date (IST)</th><th>Type</th><th>Fund</th><th>Details</th><th>Amount</th><th>Receipt</th><th>Hash</th><th></th></tr></thead><tbody>' +
        entries.map(e => {
          const isRev = e.entry_type === 'reversal';
          const b = badge(e);
          const sign = e.entry_type === 'donation' ? '+' : '-';
          const amtClass = e.entry_type === 'donation' ? 'amount-positive' : 'amount-negative';
          const fund = fundById[e.fund_id];
          const rv = reversalOf[e.id];
          const reasonTip = e.is_reversed ? 'Reversed' + (rv ? ': ' + rv.reversal_reason : '') : (isRev ? 'Reason: ' + (e.reversal_reason || '') : '');
          const orig = isRev ? entryById[e.reversed_entry_id] : null;
          const detail = e.entry_type === 'donation'
            ? (e.donor_or_payee_name || 'Anonymous') + ' · ' + P.paymentLabel(e.payment_mode)
            : isRev ? 'Reverses #' + (orig ? orig.sequence_no : '?') + ' — ' + (e.reversal_reason || '')
            : [e.donor_or_payee_name, e.notes].filter(Boolean).join(' · ');
          return '<tr class="' + (e.is_reversed ? 'row-reversed' : isRev ? 'row-reversal' : '') + '"' + (reasonTip ? ' title="' + esc(reasonTip) + '"' : '') + '>' +
            '<td><strong>#' + e.sequence_no + '</strong></td><td style="white-space:nowrap">' + esc(istDate(e.created_at)) + '</td>' +
            '<td><span class="metric-card-badge ' + b[0] + '">' + esc(b[1]) + '</span>' + (e.is_reversed ? '<div class="pf-field-error">Reversed</div>' : '') + '</td>' +
            '<td>' + esc(fund ? fund.name : '—') + '</td>' +
            '<td><strong>' + esc(P.categoryLabel(e.category)) + '</strong><div class="card-subtitle">' + esc(detail) + '</div>' +
            (e.is_reversed && rv ? '<div class="pf-field-error">Reason: ' + esc(rv.reversal_reason) + '</div>' : '') + '</td>' +
            '<td class="' + amtClass + '">' + sign + esc(money(e.amount)) + '</td>' +
            '<td>' + (e.receipt_number ? '<button class="btn btn-outline btn-sm fin-receipt" data-id="' + esc(e.id) + '">🧾 ' + esc(e.receipt_number) + '</button>' : '—') + '</td>' +
            '<td><span class="hash-badge" title="' + esc(e.entry_hash) + '">' + esc((e.entry_hash || '').slice(0, 10)) + '…</span></td>' +
            '<td>' + (ctx.canWrite && !isRev && !e.is_reversed ? '<button class="btn btn-danger btn-sm fin-reverse" data-id="' + esc(e.id) + '">Reverse</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>') + '</div>';

    // ---- events
    host.querySelector('#fin-verify').addEventListener('click', async (ev) => {
      const banner = host.querySelector('#fin-banner');
      try {
        const v = await P.withLoading(ev.currentTarget, 'Checking…', () => P.api.verifyModuleLedger(mod.id));
        banner.innerHTML = v.valid
          ? '<div class="integrity-banner intact"><span>✅ Ledger Verified (' + esc(v.count) + ' entries intact)</span><span style="font-family:monospace;font-size:.8rem">Last hash: ' + esc((v.last_hash || '').slice(0, 16)) + '…</span></div>'
          : '<div class="integrity-banner tampered"><span>🚨 Tampering detected at sequence #' + esc(v.broken_sequence_no) + '</span></div>';
      } catch (err) { banner.innerHTML = '<div class="integrity-banner tampered">' + esc(err.message) + '</div>'; }
    });

    const on = (sel, fn) => { const el = host.querySelector(sel); if (el) el.addEventListener('click', fn); };
    on('#fin-donation', () => donationModal(mod, ctx, funds, refresh));
    on('#fin-expense', () => expenseModal(mod, ctx, funds, refresh));
    on('#fin-newfund', () => newFundModal(mod, ctx, refresh));
    host.querySelectorAll('.fin-receipt').forEach(b => b.addEventListener('click', () => {
      const e = entryById[b.dataset.id];
      if (e) receiptModal(e, mod, ctx, fundById[e.fund_id]);
    }));
    host.querySelectorAll('.fin-reverse').forEach(b => b.addEventListener('click', () => {
      const e = entryById[b.dataset.id];
      if (e) reverseModal(e, mod, ctx, fundById[e.fund_id], refresh);
    }));
  };

  // ---- create fund --------------------------------------------------------------

  function newFundModal(mod, ctx, done) {
    const m = openModal('Create New Fund',
      '<form id="fin-form" novalidate>' +
      '<div class="form-group"><label class="form-label" for="n-name">Fund Name *</label><input id="n-name" class="form-control" maxlength="80" placeholder="e.g. Ramadan Iftar Fund, Masjid Expansion" required /></div>' +
      '<div class="form-group"><label class="form-label" for="n-desc">Description <small>(optional)</small></label><input id="n-desc" class="form-control" maxlength="300" /></div>' +
      '<fieldset class="pf-fieldset"><legend class="form-label">Fund Rule Type *</legend>' +
      '<label class="pf-role-opt"><input type="radio" name="n-rule" value="general" checked /> <span><strong>General / Non-Zakat</strong><small>Can be spent on any normal category.</small></span></label>' +
      '<label class="pf-role-opt" style="margin-top:8px"><input type="radio" name="n-rule" value="zakat" /> <span><strong>Zakat-Restricted</strong><small>Strictly limited to the 7 Zakat categories. This cannot be changed later.</small></span></label></fieldset>' +
      '<div id="fin-err" class="pf-form-error" role="alert"></div>' +
      '<button type="submit" class="btn btn-primary btn-block" id="fin-save">Create Fund</button></form>');
    const q = s => m.el.querySelector(s);
    q('#fin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = q('#n-name').value.trim();
      if (name.length < 2) return (q('#fin-err').textContent = 'Enter a fund name (at least 2 characters).');
      q('#fin-err').textContent = '';
      try {
        await P.withLoading(q('#fin-save'), 'Creating…', () => P.api.createFund({
          committeeId: ctx.committee.id, moduleId: mod.id, name,
          description: q('#n-desc').value.trim(),
          zakatRestricted: m.el.querySelector('input[name="n-rule"]:checked').value === 'zakat'
        }));
        m.close(); P.toast('Fund created.', 'success'); done();
      } catch (err) { q('#fin-err').textContent = err.message; P.toast(err.message, 'error'); }
    });
  }

  // ---- donation --------------------------------------------------------------

  function donationModal(mod, ctx, funds, done) {
    const m = openModal('Record Donation',
      '<form id="fin-form" novalidate>' +
      '<div class="form-group"><label class="form-label" for="d-amt">Amount (₹) *</label><input id="d-amt" class="form-control" type="number" inputmode="decimal" min="0.01" step="0.01" required /></div>' +
      '<div class="form-group"><label class="form-label" for="d-fund">Fund *</label><select id="d-fund" class="form-control">' + fundOptions(funds) + '</select></div>' +
      '<div class="form-group"><label class="form-label" for="d-cat">Purpose *</label><select id="d-cat" class="form-control">' + opt(P.DONATION_CATEGORIES) + '</select></div>' +
      '<div class="form-group"><label class="form-label" for="d-method">Payment method *</label><select id="d-method" class="form-control">' + opt(P.PAYMENT_METHODS) + '</select></div>' +
      '<div class="form-group"><label class="form-label" for="d-name">Donor name <small>(blank = Anonymous)</small></label><input id="d-name" class="form-control" maxlength="100" /></div>' +
      '<div class="form-group"><label class="form-label" for="d-phone">Donor mobile <small>(optional, +91)</small></label><input id="d-phone" class="form-control" type="tel" inputmode="numeric" maxlength="10" /></div>' +
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
          committee_id: ctx.committee.id, module_id: mod.id, entry_type: 'donation', amount,
          fund_id: q('#d-fund').value, payment_mode: q('#d-method').value, category: q('#d-cat').value,
          notes: q('#d-note').value.trim() || null,
          donor_or_payee_name: q('#d-name').value.trim() || 'Anonymous', donor_phone: phone ? P.toE164(phone) : null
        }));
        m.close(); P.toast('Donation recorded: ' + entry.receipt_number, 'success');
        done(); receiptModal(entry, mod, ctx, funds.find(f => f.id === entry.fund_id));
      } catch (err) { q('#fin-err').textContent = err.message; P.toast(err.message, 'error'); }
    });
  }

  // ---- expense ---------------------------------------------------------------

  function expenseModal(mod, ctx, funds, done) {
    const catsFor = f => f && f.is_zakat_restricted ? P.ZAKAT_CATEGORIES : P.GENERAL_EXPENSE_CATEGORIES;
    const m = openModal('Record Expense',
      '<form id="fin-form" novalidate>' +
      '<div class="form-group"><label class="form-label" for="x-fund">Fund *</label><select id="x-fund" class="form-control">' + fundOptions(funds) + '</select>' +
      '<div id="x-bal" class="card-subtitle" style="font-weight:600"></div></div>' +
      '<div class="form-group"><label class="form-label" for="x-cat">Category *</label><select id="x-cat" class="form-control"></select>' +
      '<div id="x-zakat" class="card-subtitle" style="color:#b45309;font-weight:600" hidden>Zakat-restricted fund: only the 7 Zakat-eligible categories are allowed.</div></div>' +
      '<div class="form-group"><label class="form-label" for="x-amt">Amount (₹) *</label><input id="x-amt" class="form-control" type="number" inputmode="decimal" min="0.01" step="0.01" required /></div>' +
      '<div class="form-group"><label class="form-label" for="x-payee">Paid to <small>(optional)</small></label><input id="x-payee" class="form-control" maxlength="100" /></div>' +
      '<div class="form-group"><label class="form-label" for="x-method">Payment method</label><select id="x-method" class="form-control">' + opt(P.PAYMENT_METHODS) + '</select></div>' +
      '<div class="form-group"><label class="form-label" for="x-note">Description / purpose</label><input id="x-note" class="form-control" maxlength="200" /></div>' +
      '<div id="fin-err" class="pf-form-error" role="alert"></div>' +
      '<button type="submit" class="btn btn-danger btn-block" id="fin-save">📦 Save Expense</button></form>');
    const q = s => m.el.querySelector(s);
    function sync() {
      const f = funds.find(x => x.id === q('#x-fund').value);
      q('#x-bal').textContent = 'Available in this fund: ' + money(f.current_balance);
      q('#x-cat').innerHTML = opt(catsFor(f));
      q('#x-zakat').hidden = !f.is_zakat_restricted;
    }
    q('#x-fund').addEventListener('change', sync);
    sync();
    q('#fin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = funds.find(x => x.id === q('#x-fund').value);
      const amount = Number(q('#x-amt').value);
      if (!amountOk(amount)) return (q('#fin-err').textContent = 'Enter an amount greater than zero.');
      if (amount > f.current_balance) return (q('#fin-err').textContent = 'Not enough money in ' + f.name + '. Available: ' + money(f.current_balance) + '.');
      q('#fin-err').textContent = '';
      try {
        const entry = await P.withLoading(q('#fin-save'), 'Saving…', () => P.api.addLedgerEntry({
          committee_id: ctx.committee.id, module_id: mod.id, entry_type: 'expense', amount, fund_id: f.id,
          payment_mode: q('#x-method').value, category: q('#x-cat').value,
          donor_or_payee_name: q('#x-payee').value.trim() || null, notes: q('#x-note').value.trim() || null
        }));
        m.close(); P.toast('Expense recorded (entry #' + entry.sequence_no + ').', 'success'); done();
      } catch (err) { q('#fin-err').textContent = err.message; P.toast(err.message, 'error'); }
    });
  }

  // ---- receipt -----------------------------------------------------------------

  function receiptModal(e, mod, ctx, fund) {
    const text = ['*' + ctx.committee.name + ' — ' + mod.module_name + '*', 'Donation Receipt',
      'Receipt No: ' + e.receipt_number, 'Verification Code: ' + e.verification_code, 'Date: ' + istDate(e.created_at),
      'Donor: ' + (e.donor_or_payee_name || 'Anonymous'), 'Amount: ' + money(e.amount), 'Fund: ' + (fund ? fund.name : ''),
      'Mode: ' + P.paymentLabel(e.payment_mode), 'Digest: ' + (e.entry_hash || '').slice(0, 16) + '…', 'JazakAllah Khair 🤲'].join('\n');
    const waTarget = e.donor_phone ? e.donor_phone.replace(/\D/g, '') : '';   // 91XXXXXXXXXX
    const waUrl = 'https://wa.me/' + waTarget + '?text=' + encodeURIComponent(text);
    const row = (l, v, strong) => '<div class="receipt-row"><span class="receipt-label">' + esc(l) + '</span><span class="receipt-val"' + (strong ? ' style="font-size:1.15rem;color:var(--success)"' : '') + '>' + esc(v) + '</span></div>';
    const m = openModal('Official Receipt',
      '<div class="receipt-box"><div class="receipt-watermark" aria-hidden="true">AUTHENTIC</div>' +
      '<div style="text-align:center;margin-bottom:14px"><h4 style="color:var(--primary)">' + esc(ctx.committee.name) + '</h4>' +
      '<div class="card-subtitle">' + esc(mod.module_name) + '</div></div>' +
      row('Receipt No', e.receipt_number) + row('Verification Code', e.verification_code) + row('Date (IST)', istDate(e.created_at)) +
      row('Donor', e.donor_or_payee_name || 'Anonymous') + row('Amount', money(e.amount), true) + row('Fund', fund ? fund.name : '—') + row('Mode', P.paymentLabel(e.payment_mode)) +
      '<div class="receipt-row" style="flex-direction:column;gap:4px;border-bottom:none"><span class="receipt-label">SHA-256 block digest</span>' +
      '<span style="font-family:monospace;font-size:.7rem;word-break:break-all;background:var(--bg-app);padding:4px 6px;border-radius:6px">' + esc(e.entry_hash) + '</span></div></div>' +
      '<div class="pf-btnrow pf-no-print" style="margin-top:14px"><a class="btn btn-whatsapp" style="flex:2" target="_blank" rel="noopener noreferrer" href="' + esc(waUrl) + '">💬 Share on WhatsApp</a>' +
      '<button type="button" class="btn btn-secondary" id="fin-print" style="flex:1">🖨️ Print</button></div>');
    m.el.querySelector('#fin-print').addEventListener('click', () => {
      document.body.classList.add('pf-printing-receipt');
      const cleanup = () => { document.body.classList.remove('pf-printing-receipt'); window.removeEventListener('afterprint', cleanup); };
      window.addEventListener('afterprint', cleanup);
      window.print();
      setTimeout(cleanup, 1500);
    });
    return m;
  }

  // ---- reversal ----------------------------------------------------------------

  function reverseModal(e, mod, ctx, fund, done) {
    const m = openModal('Reverse Entry #' + e.sequence_no,
      '<form id="fin-form" novalidate>' +
      '<div class="integrity-banner tampered" style="font-weight:500">⚠️ This adds a permanent reversal that undoes ' + esc(money(e.amount)) +
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
        // fund, amount and category are overwritten by the database to mirror the original entry
        await P.withLoading(q('#fin-save'), 'Saving…', () => P.api.addLedgerEntry({
          committee_id: ctx.committee.id, module_id: mod.id, entry_type: 'reversal', amount: e.amount,
          fund_id: e.fund_id, category: 'reversal', reversed_entry_id: e.id, reversal_reason: reason
        }));
        m.close(); P.toast('Entry reversed.', 'success'); done();
      } catch (err) { q('#fin-err').textContent = err.message; P.toast(err.message, 'error'); }
    });
  }
})();
