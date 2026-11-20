/**
 * Idarah platform - Mosque operations (Salah timings, staff & salaries, Nikah / Janazah
 * registers, assets, notices) and the register screens of the other module types
 * (Dargah, Imambargah, Waqf / Charity).
 * platform-mosque.js
 *
 * Which roles may change what is decided by the database (RLS); `ctx.has()` only hides
 * buttons: imam_zakir -> timings, notices, registers, events; admin/trustee -> staff list;
 * accountant -> salaries, assets, waqf assets, beneficiaries; volunteer -> langar / niyaz.
 */
(function () {
  'use strict';

  const P = window.IdarahPlatform;
  const esc = window.escapeHtml;
  const money = window.formatCurrency;
  const dash = v => (v === null || v === undefined || v === '' ? '—' : esc(v));

  // ---- Salah timings -------------------------------------------------------------

  const PRAYERS = [['fajr', 'Fajr'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha'], ['jumuah', "Jumu'ah"]];
  const hhmm = t => (t ? String(t).slice(0, 5) : '');

  async function renderTimings(host, mod, ctx) {
    host.innerHTML = P.loadingHtml('Loading timings…');
    let rows;
    try { rows = await P.api.listRows('prayer_times', { moduleId: mod.id }); }
    catch (err) { host.innerHTML = P.errorHtml(err.message, 'pf-pt-retry'); host.querySelector('#pf-pt-retry').addEventListener('click', () => renderTimings(host, mod, ctx)); return; }
    const by = Object.fromEntries(rows.map(r => [r.prayer, r]));
    const d = mod.details || {};
    const canWrite = ctx.has('imam_zakir');
    // Jumu'ah times collected during onboarding are the starting point
    const seed = { jumuah: { adhan_time: d.jummah_khutbah_time, iqamah_time: d.jummah_jamaat_time } };
    host.innerHTML =
      '<div class="card"><h3 class="card-title">⏰ Salah &amp; Jumu\'ah Timings</h3>' +
      '<p class="card-subtitle" style="margin-bottom:12px">Calculation method: ' + esc(P.formatFieldValue(P.MODULE_DEFS.mosque.fields.find(f => f.key === 'calc_method'), d.calc_method)) + '</p>' +
      '<form id="pt-form"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px">' +
      PRAYERS.map(([k, label]) => {
        const r = by[k] || seed[k] || {};
        const dis = canWrite ? '' : ' disabled';
        return '<div style="background:var(--bg-app);padding:10px;border-radius:8px;border:1px solid var(--border-subtle)"><div style="font-weight:700;margin-bottom:6px">' + esc(label) + '</div>' +
          '<div class="form-group" style="margin-bottom:6px"><label style="font-size:.75rem" for="pt-' + k + '-a">Adhan</label><input id="pt-' + k + '-a" class="form-control" type="time" style="min-height:36px" value="' + esc(hhmm(r.adhan_time)) + '"' + dis + ' /></div>' +
          '<div class="form-group" style="margin-bottom:0"><label style="font-size:.75rem;font-weight:700;color:var(--primary)" for="pt-' + k + '-i">Iqamah</label><input id="pt-' + k + '-i" class="form-control" type="time" style="min-height:36px;font-weight:700" value="' + esc(hhmm(r.iqamah_time)) + '"' + dis + ' /></div></div>';
      }).join('') + '</div>' +
      (canWrite ? '<button type="submit" class="btn btn-primary btn-sm" id="pt-save">💾 Save Timings</button>' : '') + '</form></div>';
    const form = host.querySelector('#pt-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!canWrite) return;
      const out = PRAYERS.map(([k]) => ({
        committee_id: ctx.committee.id, module_id: mod.id, prayer: k,
        adhan_time: form.querySelector('#pt-' + k + '-a').value || null,
        iqamah_time: form.querySelector('#pt-' + k + '-i').value || null
      }));
      try { await P.withLoading(form.querySelector('#pt-save'), 'Saving…', () => P.api.upsertRows('prayer_times', out, 'module_id,prayer')); P.toast('Timings saved.', 'success'); }
      catch (err) { P.toast(err.message, 'error'); }
    });
  }

  // ---- Staff & salaries ----------------------------------------------------------

  async function renderStaff(host, mod, ctx) {
    host.innerHTML = P.loadingHtml('Loading staff…');
    const month = window.getISTMonth();
    let paid = [], funds = [];
    try {
      if (ctx.has('accountant')) paid = await P.api.listRows('salary_payments', { moduleId: mod.id, eq: { month } }).catch(() => []);
    } catch (e) { /* the list below reports problems */ }
    const paidIds = new Set(paid.map(p => p.teacher_id));
    host.innerHTML = '<div id="pf-staff-crud"></div>';
    await P.renderCrud(host.querySelector('#pf-staff-crud'), {
      title: '👥 Staff & Salaries', table: 'teachers', committeeId: ctx.committee.id, moduleId: mod.id,
      canWrite: ctx.has(), order: 'full_name', addLabel: 'Add Staff', emptyText: 'No staff registered yet.',
      onChange: () => renderStaff(host, mod, ctx),
      intro: 'Salaries are paid from the General Fund and recorded in the ledger.',
      fields: [
        { key: 'full_name', label: 'Name', type: 'text', required: true, maxLength: 100 },
        { key: 'role_title', label: 'Role', type: 'text', required: true, maxLength: 80, placeholder: 'e.g. Imam & Khateeb, Muazzin, Ustad' },
        { key: 'phone', label: 'Mobile', type: 'phone' },
        { key: 'monthly_salary', label: 'Monthly Salary (₹)', type: 'number', required: true, min: 1, max: 10000000 }
      ],
      columns: [
        { label: 'Staff', html: r => '<strong>' + esc(r.full_name) + '</strong><div class="card-subtitle">' + esc(r.role_title || '') + ' · 📞 ' + dash(r.phone) + '</div>' },
        { label: 'Salary', html: r => '<strong>' + esc(money(r.monthly_salary)) + '</strong>' },
        { label: 'Salary (' + month + ')', html: r => ctx.has('accountant')
          ? (paidIds.has(r.id) ? '<span class="metric-card-badge badge-general">✅ Paid</span>' : '<span class="metric-card-badge badge-zakat">⚠️ Due</span>') : '—' }
      ],
      extraActions: ctx.has('accountant') ? [{
        label: '💵 Pay Salary', show: r => !paidIds.has(r.id),
        onClick: (row) => salaryModal(row, month, () => renderStaff(host, mod, ctx))
      }] : []
    });
  }

  function salaryModal(staff, month, done) {
    const m = P.openModal('Pay Salary',
      '<form id="sal-form" novalidate>' +
      '<div style="background:var(--primary-light);padding:12px;border-radius:12px;margin-bottom:14px"><strong style="color:var(--primary)">' + esc(staff.full_name) + '</strong>' +
      '<div class="card-subtitle">' + esc(staff.role_title || '') + ' · Monthly salary: ' + esc(money(staff.monthly_salary)) + '</div></div>' +
      '<div class="form-group"><label class="form-label" for="sal-month">Month *</label><input id="sal-month" class="form-control" type="month" value="' + esc(month) + '" required /></div>' +
      '<div class="form-group"><label class="form-label" for="sal-amt">Amount (₹) *</label><input id="sal-amt" class="form-control" type="number" min="1" step="0.01" value="' + esc(staff.monthly_salary) + '" required /></div>' +
      '<p class="card-subtitle" style="margin-bottom:12px">💡 Paid from the General Fund. The payment is refused if the fund does not have enough money.</p>' +
      '<div id="sal-err" class="pf-form-error" role="alert"></div>' +
      '<button type="submit" class="btn btn-primary btn-block" id="sal-save">💵 Confirm Salary Payment</button></form>');
    const q = s => m.el.querySelector(s);
    q('#sal-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const amount = Number(q('#sal-amt').value), mm = q('#sal-month').value;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mm)) return (q('#sal-err').textContent = 'Choose a valid month.');
      if (!Number.isFinite(amount) || amount <= 0) return (q('#sal-err').textContent = 'Enter an amount greater than zero.');
      try {
        const entry = await P.withLoading(q('#sal-save'), 'Saving…', () => P.api.paySalary(staff.id, mm, amount));
        m.close(); P.toast('Salary recorded (ledger entry #' + entry.sequence_no + ').', 'success'); done();
      } catch (err) { q('#sal-err').textContent = err.message; P.toast(err.message, 'error'); }
    });
  }

  // ---- registers: Nikah + Janazah ---------------------------------------------------

  async function renderRegisters(host, mod, ctx) {
    host.innerHTML = '<div id="pf-nikah"></div><div id="pf-janazah"></div>';
    const canWrite = ctx.has('imam_zakir');
    await Promise.all([
      P.renderCrud(host.querySelector('#pf-nikah'), {
        title: '📜 Nikah Register', table: 'nikah_records', committeeId: ctx.committee.id, moduleId: mod.id, canWrite,
        order: 'nikah_date', ascending: false, addLabel: 'Add Nikah', emptyText: 'No records registered.',
        defaults: () => ({ qazi: '' }),
        fields: [
          { key: 'groom', label: 'Groom', type: 'text', required: true, maxLength: 120 },
          { key: 'bride', label: 'Bride', type: 'text', required: true, maxLength: 120 },
          { key: 'wali_witnesses', label: 'Wali & Witnesses', type: 'text', maxLength: 200 },
          { key: 'mahr', label: 'Mahr', type: 'text', required: true, maxLength: 120, placeholder: "e.g. ₹51,000 Prompt (Mu'ajjal)" },
          { key: 'nikah_date', label: 'Nikah Date', type: 'date', required: true },
          { key: 'qazi', label: 'Qazi / Officiant', type: 'text', maxLength: 100 }
        ],
        columns: [
          { label: 'Groom & Bride', html: r => '<strong>' + esc(r.groom) + '</strong> &amp; <strong>' + esc(r.bride) + '</strong><div class="card-subtitle">' + dash(r.wali_witnesses) + '</div>' },
          { label: 'Date', html: r => dash(r.nikah_date) }, { label: 'Mahr', html: r => dash(r.mahr) }
        ]
      }),
      P.renderCrud(host.querySelector('#pf-janazah'), {
        title: '⚰️ Janazah Register', table: 'janazah_records', committeeId: ctx.committee.id, moduleId: mod.id, canWrite,
        order: 'demise_date', ascending: false, addLabel: 'Add Janazah', emptyText: 'No records registered.',
        fields: [
          { key: 'deceased', label: 'Name of Deceased', type: 'text', required: true, maxLength: 120 },
          { key: 'age', label: 'Age', type: 'number', min: 0, max: 150 },
          { key: 'demise_date', label: 'Date of Demise', type: 'date', required: true },
          { key: 'janazah_time', label: 'Janazah Time', type: 'text', required: true, maxLength: 80, placeholder: 'e.g. After Asr Prayer (4:45 PM)' },
          { key: 'burial_place', label: 'Burial Place', type: 'text', maxLength: 150 }
        ],
        columns: [
          { label: 'Deceased', html: r => '<strong>' + esc(r.deceased) + '</strong>' + (r.age !== null && r.age !== undefined ? ' (' + esc(r.age) + ' yrs)' : '') + '<div class="card-subtitle">' + dash(r.burial_place) + '</div>' },
          { label: 'Date', html: r => dash(r.demise_date) }, { label: 'Janazah', html: r => dash(r.janazah_time) }
        ]
      })
    ]);
  }

  // ---- shared register screens used by several module types ------------------------

  const assetsSection = {
    key: 'assets', label: 'Assets', icon: '📦',
    render: (host, mod, ctx) => P.renderCrud(host, {
      title: '📦 Assets', table: 'assets', committeeId: ctx.committee.id, moduleId: mod.id, canWrite: ctx.has('accountant'),
      order: 'name', addLabel: 'Add Asset', emptyText: 'No assets recorded yet.',
      defaults: () => ({ acquired_on: window.getISTDate() }),
      fields: [
        { key: 'name', label: 'Asset Name', type: 'text', required: true, maxLength: 120 },
        { key: 'location', label: 'Location', type: 'text', maxLength: 120 },
        { key: 'value', label: 'Value (₹)', type: 'number', required: true, min: 0, max: 1000000000 },
        { key: 'condition', label: 'Condition', type: 'select', required: true, options: [['Good / Operational', 'Good / Operational'], ['Needs Repair', 'Needs Repair'], ['Replaced', 'Replaced']] },
        { key: 'acquired_on', label: 'Acquired On', type: 'date' }
      ],
      columns: [
        { label: 'Asset', html: r => '<strong>' + esc(r.name) + '</strong><div class="card-subtitle">' + dash(r.location) + '</div>' },
        { label: 'Value', html: r => '<strong>' + esc(money(r.value)) + '</strong>' },
        { label: 'Condition', html: r => '<span class="metric-card-badge ' + (/good/i.test(r.condition || '') ? 'badge-general' : 'badge-zakat') + '">' + dash(r.condition) + '</span>' },
        { label: 'Acquired', html: r => dash(r.acquired_on) }
      ]
    })
  };

  const noticesSection = {
    key: 'notices', label: 'Notices', icon: '📢',
    render: (host, mod, ctx) => P.renderCrud(host, {
      title: '📢 Notices', table: 'notices', committeeId: ctx.committee.id, moduleId: mod.id, canWrite: ctx.has('imam_zakir'),
      order: 'published_on', ascending: false, addLabel: 'Add Notice', emptyText: 'No notices yet.',
      fields: [
        { key: 'title', label: 'Title', type: 'text', required: true, maxLength: 150 },
        { key: 'body', label: 'Message', type: 'textarea', required: true, maxLength: 1000 },
        { key: 'expires_on', label: 'Expires On (optional)', type: 'date' }
      ],
      columns: [
        { label: 'Notice', html: r => '<strong>' + esc(r.title) + '</strong><div class="card-subtitle" style="white-space:pre-wrap">' + dash(r.body) + '</div>' },
        { label: 'Published', html: r => dash(r.published_on) }
      ],
      extraActions: [{
        label: '💬 WhatsApp', className: 'btn-whatsapp',
        onClick: (row) => {
          const text = '*' + ctx.committee.name + ' — ' + mod.module_name + '*\n\n*' + row.title + '*\n' + (row.body || '') + '\n\n📅 ' + (row.published_on || '');
          window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
        }
      }]
    })
  };

  const eventsSection = {
    key: 'events', label: 'Events', icon: '🌙',
    render: (host, mod, ctx) => P.renderCrud(host, {
      title: '🌙 Urs, Majlis & Events', table: 'majlis_urs_events', committeeId: ctx.committee.id, moduleId: mod.id, canWrite: ctx.has('imam_zakir'),
      order: 'starts_on', ascending: false, addLabel: 'Add Event', emptyText: 'No events scheduled.',
      fields: [
        { key: 'event_type', label: 'Type', type: 'select', required: true, options: [['urs', 'Urs'], ['majlis', 'Majlis'], ['milad', 'Milad'], ['muharram', 'Muharram programme'], ['other', 'Other']] },
        { key: 'title', label: 'Title', type: 'text', required: true, maxLength: 150 },
        { key: 'starts_on', label: 'Date (Gregorian)', type: 'date' },
        { key: 'hijri_date', label: 'Hijri Date', type: 'text', maxLength: 60, placeholder: 'e.g. 6 Rajab 1448' },
        { key: 'notes', label: 'Notes', type: 'textarea', maxLength: 500 }
      ],
      columns: [
        { label: 'Event', html: r => '<strong>' + esc(r.title) + '</strong><div class="card-subtitle">' + esc(r.event_type) + ' · ' + dash(r.notes) + '</div>' },
        { label: 'Date', html: r => dash(r.starts_on) + (r.hijri_date ? '<div class="card-subtitle">' + esc(r.hijri_date) + '</div>' : '') }
      ]
    })
  };

  const langarSection = {
    key: 'langar', label: 'Langar & Niyaz', icon: '🍲',
    render: (host, mod, ctx) => P.renderCrud(host, {
      title: '🍲 Langar, Niyaz & Sabeel', table: 'langar_niyaz', committeeId: ctx.committee.id, moduleId: mod.id, canWrite: ctx.has('volunteer'),
      order: 'service_date', ascending: false, addLabel: 'Add Service', emptyText: 'No services recorded yet.',
      defaults: () => ({ service_date: window.getISTDate() }),
      fields: [
        { key: 'service_date', label: 'Date', type: 'date', required: true },
        { key: 'kind', label: 'Kind', type: 'select', required: true, options: [['langar', 'Langar'], ['niyaz', 'Niyaz'], ['sabeel', 'Sabeel']] },
        { key: 'meals_served', label: 'People / Meals Served', type: 'number', min: 0, max: 10000000 },
        { key: 'notes', label: 'Notes', type: 'textarea', maxLength: 500 }
      ],
      columns: [
        { label: 'Date', html: r => dash(r.service_date) }, { label: 'Kind', html: r => esc(r.kind) },
        { label: 'Served', html: r => dash(r.meals_served) }, { label: 'Notes', html: r => dash(r.notes) }
      ]
    })
  };

  const waqfAssetsSection = {
    key: 'waqf_assets', label: 'Waqf Properties', icon: '🏠',
    render: (host, mod, ctx) => P.renderCrud(host, {
      title: '🏠 Waqf Properties & Rent', table: 'waqf_assets', committeeId: ctx.committee.id, moduleId: mod.id, canWrite: ctx.has('accountant'),
      order: 'name', addLabel: 'Add Property', emptyText: 'No Waqf properties recorded yet.',
      fields: [
        { key: 'name', label: 'Property Name', type: 'text', required: true, maxLength: 150 },
        { key: 'asset_type', label: 'Type', type: 'select', required: true, options: [['property', 'Property'], ['shop', 'Shop'], ['land', 'Land'], ['other', 'Other']] },
        { key: 'location', label: 'Location', type: 'text', maxLength: 150 },
        { key: 'annual_rent', label: 'Annual Rent (₹)', type: 'number', min: 0, max: 1000000000 },
        { key: 'acquired_on', label: 'Acquired On', type: 'date' },
        { key: 'notes', label: 'Notes', type: 'textarea', maxLength: 500 }
      ],
      columns: [
        { label: 'Property', html: r => '<strong>' + esc(r.name) + '</strong><div class="card-subtitle">' + esc(r.asset_type) + ' · ' + dash(r.location) + '</div>' },
        { label: 'Annual Rent', html: r => r.annual_rent === null || r.annual_rent === undefined ? '—' : '<strong>' + esc(money(r.annual_rent)) + '</strong>' },
        { label: 'Acquired', html: r => dash(r.acquired_on) }
      ]
    })
  };

  const beneficiariesSection = {
    key: 'beneficiaries', label: 'Beneficiaries', icon: '🤝',
    render: (host, mod, ctx) => P.renderCrud(host, {
      title: '🤝 Beneficiaries', table: 'beneficiaries', committeeId: ctx.committee.id, moduleId: mod.id, canWrite: ctx.has('accountant'),
      intro: 'Private: visible only to admins, trustees and accountants.',
      order: 'full_name', addLabel: 'Add Beneficiary', emptyText: 'No beneficiaries recorded yet.',
      fields: [
        { key: 'full_name', label: 'Name', type: 'text', required: true, maxLength: 120 },
        { key: 'phone', label: 'Mobile', type: 'phone' },
        { key: 'category', label: 'Category', type: 'text', maxLength: 80, placeholder: 'e.g. Widow, Orphan, Patient' },
        { key: 'support_type', label: 'Support Given', type: 'text', maxLength: 120, placeholder: 'e.g. Monthly ration, medical aid' },
        { key: 'notes', label: 'Notes', type: 'textarea', maxLength: 500 }
      ],
      columns: [
        { label: 'Name', html: r => '<strong>' + esc(r.full_name) + '</strong><div class="card-subtitle">📞 ' + dash(r.phone) + '</div>' },
        { label: 'Category', html: r => dash(r.category) }, { label: 'Support', html: r => dash(r.support_type) }
      ]
    })
  };

  // ---- register per module type --------------------------------------------------------

  P.registerSections('mosque', [
    { key: 'timings', label: 'Salah Timings', icon: '⏰', render: renderTimings },
    { key: 'staff', label: 'Staff & Salaries', icon: '👥', render: renderStaff },
    { key: 'registers', label: 'Nikah & Janazah', icon: '📜', render: renderRegisters },
    assetsSection, noticesSection
  ]);
  P.registerSections('madarsa', [
    { key: 'staff', label: 'Teachers & Salaries', icon: '🧑‍🏫', render: renderStaff },
    noticesSection, assetsSection
  ]);
  P.registerSections('dargah', [eventsSection, langarSection, noticesSection, assetsSection]);
  P.registerSections('imambargah', [eventsSection, langarSection, noticesSection, assetsSection]);
  P.registerSections('waqf_charity', [waqfAssetsSection, beneficiariesSection, noticesSection, assetsSection]);
})();
