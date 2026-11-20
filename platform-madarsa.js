/**
 * Idarah platform - Madarsa module screens: Students (+ monthly fees) and
 * Attendance with Sabaq / Sabqi / Manzil (Quran progress).
 * platform-madarsa.js
 *
 * Fee collection calls collect_student_fee(): ONE database call that records the
 * donation in the ledger (with receipt) and the fee payment, so a month can never
 * be paid twice and the two records can never disagree.
 */
(function () {
  'use strict';

  const P = window.IdarahPlatform;
  const esc = window.escapeHtml;
  const money = window.formatCurrency;

  // ---- Students & fees -----------------------------------------------------------

  const STUDENT_FIELDS = [
    { key: 'full_name', label: 'Student Name', type: 'text', required: true, maxLength: 100 },
    { key: 'guardian_name', label: 'Guardian Name', type: 'text', required: true, maxLength: 100 },
    { key: 'guardian_phone', label: 'Guardian Mobile', type: 'phone', required: true },
    { key: 'class_name', label: 'Class / Batch', type: 'text', required: true, maxLength: 60, placeholder: 'e.g. Hifz Batch A' },
    { key: 'monthly_fee', label: 'Monthly Fee (₹)', type: 'number', required: true, min: 0, max: 1000000 }
  ];

  async function renderStudents(host, mod, ctx) {
    host.innerHTML = P.loadingHtml('Loading students…');
    const month = window.getISTMonth();
    let students, paid, funds = [];
    try {
      [students, paid] = await Promise.all([
        P.api.listRows('students', { moduleId: mod.id, select: 'id, full_name, guardian_name, guardian_phone, class_name, monthly_fee', order: 'full_name' }),
        ctx.has('accountant', 'teacher')
          ? P.api.listRows('fee_payments', { moduleId: mod.id, eq: { month } }).catch(() => [])
          : Promise.resolve([])
      ]);
      if (ctx.has('accountant')) funds = await P.api.listFunds(mod.id).catch(() => []);
    } catch (err) {
      host.innerHTML = P.errorHtml(err.message, 'pf-st-retry');
      host.querySelector('#pf-st-retry').addEventListener('click', () => renderStudents(host, mod, ctx));
      return;
    }
    const paidIds = new Set(paid.map(p => p.student_id));
    const unpaid = students.filter(s => !paidIds.has(s.id));
    const dues = unpaid.reduce((a, s) => a + (Number(s.monthly_fee) || 0), 0);
    const canFees = ctx.has('accountant');

    host.innerHTML =
      (ctx.has('accountant', 'teacher') && students.length ?
        '<div class="card" style="padding:12px 16px"><strong style="color:' + (unpaid.length ? 'var(--gold)' : 'var(--success)') + '">' +
        '⚠️ Pending dues for ' + esc(month) + ': ' + unpaid.length + ' student(s) · ' + esc(money(dues)) + '</strong></div>' : '') +
      '<div id="pf-st-crud"></div>';

    await P.renderCrud(host.querySelector('#pf-st-crud'), {
      title: '👥 Students', table: 'students', committeeId: ctx.committee.id, moduleId: mod.id,
      canWrite: ctx.has('teacher'), order: 'full_name', addLabel: 'Add Student', fields: STUDENT_FIELDS,
      onChange: () => renderStudents(host, mod, ctx),
      emptyText: 'No students enrolled yet.', deleteText: 'Delete this student? Their fee history stays in the ledger.',
      defaults: () => ({ monthly_fee: (mod.details && mod.details.default_monthly_fee) || 0 }),
      columns: [
        { label: 'Student', html: r => '<strong>' + esc(r.full_name) + '</strong><div class="card-subtitle">Guardian: ' + esc(r.guardian_name || '—') + ' · 📞 ' + esc(r.guardian_phone || '—') + '</div>' },
        { label: 'Class', html: r => esc(r.class_name || 'General') },
        { label: 'Fee', html: r => '<strong>' + esc(money(r.monthly_fee)) + '</strong>' },
        { label: 'Fee (' + month + ')', html: r => paidIds.has(r.id)
          ? '<span class="metric-card-badge badge-general">✅ Paid</span>'
          : '<span class="metric-card-badge badge-zakat">⚠️ Due</span>' }
      ],
      extraActions: canFees ? [{
        label: '💳 Collect Fee', className: 'btn-primary', show: r => !paidIds.has(r.id),
        onClick: (row) => feeModal(row, mod, ctx, funds, month, () => renderStudents(host, mod, ctx))
      }] : []
    });
  }

  function feeModal(student, mod, ctx, funds, month, done) {
    const m = P.openModal('Collect Fee',
      '<form id="fee-form" novalidate>' +
      '<div style="background:var(--primary-light);padding:12px;border-radius:12px;margin-bottom:14px"><strong style="color:var(--primary)">' + esc(student.full_name) + '</strong>' +
      '<div class="card-subtitle">Class: ' + esc(student.class_name || '—') + ' · Fee: ' + esc(money(student.monthly_fee)) + '</div></div>' +
      '<div class="form-group"><label class="form-label" for="fee-month">Month *</label><input id="fee-month" class="form-control" type="month" value="' + esc(month) + '" required /></div>' +
      '<div class="form-group"><label class="form-label" for="fee-amt">Amount (₹) *</label><input id="fee-amt" class="form-control" type="number" min="1" step="0.01" value="' + esc(student.monthly_fee) + '" required /></div>' +
      '<div class="form-group"><label class="form-label" for="fee-mode">Payment method</label><select id="fee-mode" class="form-control">' +
      P.PAYMENT_METHODS.map(o => '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>').join('') + '</select></div>' +
      '<p class="card-subtitle" style="margin-bottom:12px">💡 The fee is recorded in the ledger automatically and a receipt is generated. A month can only be paid once.</p>' +
      '<div id="fee-err" class="pf-form-error" role="alert"></div>' +
      '<button type="submit" class="btn btn-primary btn-block" id="fee-save">💳 Confirm Fee Payment</button></form>');
    const q = s => m.el.querySelector(s);
    q('#fee-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const amount = Number(q('#fee-amt').value);
      const mm = q('#fee-month').value;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mm)) return (q('#fee-err').textContent = 'Choose a valid month.');
      if (!Number.isFinite(amount) || amount <= 0) return (q('#fee-err').textContent = 'Enter an amount greater than zero.');
      q('#fee-err').textContent = '';
      try {
        const entry = await P.withLoading(q('#fee-save'), 'Saving…', () => P.api.collectFee(student.id, mm, amount, q('#fee-mode').value));
        m.close(); P.toast('Fee recorded: ' + entry.receipt_number, 'success');
        done();
        P.showReceipt(entry, mod, ctx, funds.find(f => f.id === entry.fund_id));
      } catch (err) { q('#fee-err').textContent = err.message; P.toast(err.message, 'error'); }
    });
  }

  // ---- Attendance + Quran progress --------------------------------------------------

  async function renderAttendance(host, mod, ctx, date) {
    date = date || window.getISTDate();
    host.innerHTML = P.loadingHtml('Loading attendance…');
    let students, att, hifz;
    try {
      [students, att, hifz] = await Promise.all([
        P.api.listRows('students', { moduleId: mod.id, select: 'id, full_name, class_name', order: 'full_name' }),
        P.api.listRows('attendance', { moduleId: mod.id, eq: { attendance_date: date } }),
        P.api.listRows('hifz_logs', { moduleId: mod.id, eq: { log_date: date } })
      ]);
    } catch (err) {
      host.innerHTML = P.errorHtml(err.message, 'pf-at-retry');
      host.querySelector('#pf-at-retry').addEventListener('click', () => renderAttendance(host, mod, ctx, date));
      return;
    }
    const attBy = Object.fromEntries(att.map(a => [a.student_id, a]));
    const hifzBy = Object.fromEntries(hifz.map(h => [h.student_id, h]));
    const canWrite = ctx.has('teacher');

    host.innerHTML =
      '<div class="card"><div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">' +
      '<div class="form-group" style="margin-bottom:0"><label class="form-label" for="att-date">Date</label>' +
      '<input id="att-date" class="form-control" type="date" value="' + esc(date) + '" max="' + esc(window.getISTDate()) + '" /></div>' +
      (canWrite ? '<button class="btn btn-primary" id="att-save">💾 Save Attendance</button>' : '') + '</div></div>' +
      '<div class="card">' + (students.length === 0 ? '<p class="card-subtitle">Please enroll students first.</p>' :
        '<div class="table-responsive"><table class="data-table"><thead><tr><th>Student</th><th>Attendance</th><th>Sabaq</th><th>Sabqi</th><th>Manzil</th></tr></thead><tbody id="att-body">' +
        students.map(s => {
          const a = attBy[s.id] || {}, h = hifzBy[s.id] || {};
          const dis = canWrite ? '' : ' disabled';
          return '<tr data-sid="' + esc(s.id) + '"><td><strong>' + esc(s.full_name) + '</strong><div class="card-subtitle">' + esc(s.class_name || '') + '</div></td>' +
            '<td><div class="attendance-pills">' +
            '<label><input type="radio" class="attendance-pill-input" name="att_' + esc(s.id) + '" value="present"' + (a.status === 'present' ? ' checked' : '') + dis + ' /><span class="attendance-pill-label present">✓ Present</span></label>' +
            '<label><input type="radio" class="attendance-pill-input" name="att_' + esc(s.id) + '" value="absent"' + (a.status === 'absent' ? ' checked' : '') + dis + ' /><span class="attendance-pill-label absent">✗ Absent</span></label></div></td>' +
            ['sabaq', 'sabqi', 'manzil'].map(k => '<td><input class="form-control ' + k + '-in" style="min-height:38px" maxlength="120" value="' + esc(h[k] || '') + '" placeholder="' + k.charAt(0).toUpperCase() + k.slice(1) + '"' + dis + ' /></td>').join('') + '</tr>';
        }).join('') + '</tbody></table></div>') + '</div>';

    host.querySelector('#att-date').addEventListener('change', e => { if (e.target.value) renderAttendance(host, mod, ctx, e.target.value); });
    const save = host.querySelector('#att-save');
    if (!save) return;
    save.addEventListener('click', async () => {
      const attRows = [], hifzRows = [];
      host.querySelectorAll('#att-body tr').forEach(tr => {
        const sid = tr.dataset.sid;
        const checked = tr.querySelector('input[type=radio]:checked');
        if (checked) attRows.push({ committee_id: ctx.committee.id, module_id: mod.id, student_id: sid, attendance_date: date, status: checked.value });
        const sabaq = tr.querySelector('.sabaq-in').value.trim(), sabqi = tr.querySelector('.sabqi-in').value.trim(), manzil = tr.querySelector('.manzil-in').value.trim();
        if (sabaq || sabqi || manzil || hifzBy[sid]) {
          hifzRows.push({ committee_id: ctx.committee.id, module_id: mod.id, student_id: sid, log_date: date, sabaq, sabqi, manzil });
        }
      });
      try {
        await P.withLoading(save, 'Saving…', async () => {
          if (attRows.length) await P.api.upsertRows('attendance', attRows, 'student_id,attendance_date');
          if (hifzRows.length) await P.api.upsertRows('hifz_logs', hifzRows, 'student_id,log_date');
        });
        P.toast('Attendance saved for ' + date, 'success');
      } catch (err) { P.toast(err.message, 'error'); }
    });
  }

  P.registerSections('madarsa', [
    { key: 'students', label: 'Students & Fees', icon: '👥', render: renderStudents },
    { key: 'attendance', label: 'Attendance & Quran', icon: '📝', render: (host, mod, ctx) => renderAttendance(host, mod, ctx) }
  ]);
})();
