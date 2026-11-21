import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2];
const read = f => fs.readFileSync(path.join(repo, f), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x)); };
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ---------- fake Supabase backend (in memory) ----------
function makeBackend(opts) {
  const db = {
    users: { 'u1': { id: 'u1', phone: '+919876543210', full_name: 'Alice' } },
    memberships: opts.memberships || [], modules: opts.modules || [], calls: [], funds: opts.funds || [], ledger: opts.ledger || [], tables: opts.tables || {}
  };
  const session = opts.signedIn ? { user: { id: 'u1' } } : null;
  let current = session;
  const listeners = [];
  const builder = (table) => {
    const q = { table, filters: [], op: 'select', payload: null, single: false };
    const exec = async () => {
      db.calls.push({ table, op: q.op, filters: q.filters, payload: q.payload });
      if (opts.offline) throw new TypeError('Failed to fetch');
      const f = (rows) => rows.filter(r => q.filters.every(([k, kind, v]) => kind === 'eq' ? r[k] === v : v.includes(r[k])));
      if (table === 'profiles') { const rows = f(Object.values(db.users).map(u => ({ id: u.id, full_name: u.full_name, phone: u.phone }))); return { data: q.single ? rows[0] || null : rows, error: null }; }
      if (table === 'committee_memberships') {
        if (q.op === 'delete') { db.memberships = db.memberships.filter(m => m.id !== q.filters[0][2]); return { data: [{ id: 'x' }], error: null }; }
        return { data: f(db.memberships.map(m => ({ ...m }))), error: null };
      }
      if (table === 'organization_modules') {
        if (q.op === 'update') { const row = db.modules.find(m => m.id === q.filters[0][2]); Object.assign(row, q.payload); return { data: [row], error: null }; }
        return { data: f(db.modules), error: null };
      }
      if (table === 'funds') {
        if (q.op === 'insert') {
          if (db.funds.some(x => x.module_id === q.payload.module_id && x.name.toLowerCase() === q.payload.name.toLowerCase())) {
            return { data: null, error: { message: 'A fund named "' + q.payload.name + '" already exists in this module' } };
          }
          const row = { id: 'F' + (db.funds.length + 1), code: 'X', fund_type: 'custom', is_default: false, current_balance: 0, ...q.payload };
          db.funds.push(row); return { data: row, error: null };
        }
        return { data: f(db.funds || []), error: null };
      }
      if (table === 'ledger_entries') {
        db.ledger = db.ledger || [];
        if (q.op === 'insert') {
          const n = db.ledger.length + 1;
          const p = q.payload;
          const fund = db.funds.find(x => x.id === p.fund_id);
          if (p.entry_type === 'expense' && p.amount > fund.current_balance) return { data: null, error: { message: 'Insufficient balance in selected fund' } };
          const row = { id: 'L' + n, sequence_no: n, created_at: '2026-11-19T10:00:00Z', is_reversed: false,
            receipt_number: p.entry_type === 'donation' ? 'RCP-000' + n : null, verification_code: p.entry_type === 'donation' ? 'ABCD2345' : null,
            entry_hash: 'a'.repeat(64), ...p };
          if (p.entry_type === 'donation') fund.current_balance += p.amount;
          if (p.entry_type === 'expense') fund.current_balance -= p.amount;
          if (p.entry_type === 'reversal') {
            const o = db.ledger.find(x => x.id === p.reversed_entry_id); o.is_reversed = true;
            fund.current_balance += o.entry_type === 'donation' ? -o.amount : o.amount;
          }
          db.ledger.push(row); return { data: row, error: null };
        }
        return { data: f(db.ledger).slice().sort((a, b) => b.sequence_no - a.sequence_no), error: null };
      }
      db.tables = db.tables || {};
      const rowsOf = () => (db.tables[table] = db.tables[table] || []);
      const nextId = () => table.slice(0, 3) + (rowsOf().length + 1);
      if (q.op === 'insert') { const r = { id: nextId(), ...q.payload }; rowsOf().push(r); return { data: q.single ? r : [r], error: null }; }
      if (q.op === 'upsert') {
        const keys = q.onConflict.split(',');
        const out = (Array.isArray(q.payload) ? q.payload : [q.payload]).map(p => {
          const hit = rowsOf().find(x => keys.every(k => x[k] === p[k]));
          if (hit) { Object.assign(hit, p); return hit; }
          const r = { id: nextId(), ...p }; rowsOf().push(r); return r;
        });
        return { data: out, error: null };
      }
      if (q.op === 'update') { const row = rowsOf().find(x => q.filters.every(([k, , v]) => x[k] === v)); if (!row) return { data: [], error: null }; Object.assign(row, q.payload); return { data: [row], error: null }; }
      if (q.op === 'delete') { const before = rowsOf().length; db.tables[table] = rowsOf().filter(x => !q.filters.every(([k, , v]) => x[k] === v)); return { data: before === db.tables[table].length ? [] : [{ id: 'x' }], error: null }; }
      return { data: f(rowsOf()).slice(), error: null };
    };
    const api = {
      upsert(rows, o) { q.op = 'upsert'; q.payload = rows; q.onConflict = o.onConflict; return api; },
      insert(p) { q.op = 'insert'; q.payload = p; return api; }, limit() { return api; }, single() { q.single = true; return api; },
      select() { return api; }, order() { return api; },
      eq(k, v) { q.filters.push([k, 'eq', v]); return api; },
      in(k, v) { q.filters.push([k, 'in', v]); return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      delete() { q.op = 'delete'; return api; },
      maybeSingle() { q.single = true; return api; },
      then(res, rej) { return exec().then(res, rej); }
    };
    return api;
  };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: current }, error: null }),
      signUp: async (a) => { db.calls.push({ rpc: 'signUp', a }); current = { user: { id: 'u1' } }; return { data: { session: current }, error: null }; },
      signInWithPassword: async (a) => {
        db.calls.push({ rpc: 'signIn', a });
        if (a.password === 'wrongpass1') return { data: {}, error: { message: 'Invalid login credentials' } };
        current = { user: { id: 'u1' } }; return { data: { session: current }, error: null };
      },
      onAuthStateChange: (cb) => { listeners.push(cb); return { data: { subscription: {} } }; },
      signOut: async () => { current = null; listeners.forEach(l => l('SIGNED_OUT', null)); return { error: null }; }
    },
    from: builder,
    rpc: async (name, args) => {
      db.calls.push({ rpc: name, args });
      if (opts.offline) throw new TypeError('Failed to fetch');
      if (name === 'create_committee_with_modules') {
        const cid = 'c' + (db.memberships.length + 1);
        db.memberships.push({ id: 'm' + cid, user_id: 'u1', roles: ['admin'], allowed_modules: null, status: 'active', committee: { id: cid, name: args.p_name, city: args.p_city, state: args.p_state, country: 'India' } });
        args.p_modules.forEach((m, i) => db.modules.push({ id: cid + '-mod' + i, committee_id: cid, ...m, is_active: true, created_at: String(i) }));
        return { data: cid, error: null };
      }
      if (name === 'collect_student_fee') {
        db.tables.students = db.tables.students || []; db.tables.fee_payments = db.tables.fee_payments || [];
        const st = db.tables.students.find(s => s.id === args.p_student_id);
        if (db.tables.fee_payments.some(p => p.student_id === st.id && p.month === args.p_month)) return { data: null, error: { message: 'The fee for ' + args.p_month + ' is already recorded for ' + st.full_name } };
        const n = db.ledger.length + 1; const fund = db.funds.find(x => x.module_id === st.module_id);
        const row = { id: 'L' + n, sequence_no: n, created_at: new Date().toISOString(), entry_type: 'donation', amount: args.p_amount, fund_id: fund.id, payment_mode: args.p_payment_mode, category: 'student_fee', receipt_number: 'RCP-000' + n, verification_code: 'ABCD2345', entry_hash: 'b'.repeat(64), donor_or_payee_name: 'Guardian of ' + st.full_name, donor_phone: null, is_reversed: false };
        db.ledger.push(row); fund.current_balance += args.p_amount; db.tables.fee_payments.push({ id: 'fp' + n, student_id: st.id, month: args.p_month, module_id: st.module_id });
        return { data: row, error: null };
      }
      if (name === 'pay_staff_salary') {
        db.tables.teachers = db.tables.teachers || []; db.tables.salary_payments = db.tables.salary_payments || [];
        const tc = db.tables.teachers.find(x => x.id === args.p_teacher_id); const fund = db.funds.find(x => x.module_id === tc.module_id && x.code === 'GENERAL');
        if (args.p_amount > fund.current_balance) return { data: null, error: { message: 'Insufficient balance in selected fund' } };
        const n = db.ledger.length + 1; fund.current_balance -= args.p_amount;
        db.ledger.push({ id: 'L' + n, sequence_no: n, created_at: new Date().toISOString(), entry_type: 'expense', amount: args.p_amount, fund_id: fund.id, category: 'exp_staff_salary', entry_hash: 'c'.repeat(64), is_reversed: false });
        db.tables.salary_payments.push({ id: 'sp' + n, teacher_id: tc.id, month: args.p_month, module_id: tc.module_id });
        return { data: { id: 'L' + n, sequence_no: n }, error: null };
      }
      if (name === 'verify_module_ledger') return { data: { valid: true, count: (db.ledger || []).length, last_hash: 'abc123def456abc123' }, error: null };
      if (name === 'add_modules') {
        args.p_modules.forEach((m, i) => db.modules.push({ id: args.p_committee_id + '-new' + i, committee_id: args.p_committee_id, ...m, is_active: true, created_at: 'z' + i }));
        return { data: args.p_modules.length, error: null };
      }
      return { data: null, error: null };
    }
  };
  return { client, db };
}

async function boot(opts) {
  const be = makeBackend(opts);
  const dom = new JSDOM('<!doctype html><html><body><div id="app-root"></div></body></html>', {
    url: 'https://idarah.test/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  w.scrollTo = () => {};
  w.confirm = () => true;
  if (!opts.noConfig) w.IDARAH_SUPABASE = { url: 'https://x.supabase.co', anonKey: 'anon' };
  w.supabase = { createClient: () => be.client };
  for (const f of ['config.js', ...['hi', 'ur', 'bn', 'gu', 'ks', 'ml', 'ta', 'te', 'kn', 'mr', 'as', 'or', 'pa'].map(l => 'locales/' + l + '.js'), 'i18n.js', 'platform-modules.js', 'platform-core.js', 'platform-onboarding.js', 'platform-ui.js', 'platform-finance.js', 'platform-madarsa.js', 'platform-mosque.js', 'platform-reports.js', 'platform-app.js']) w.eval(read(f));
  await tick(60);
  return { w, d: w.document, be };
}
const txt = (d, sel) => Array.from(d.querySelectorAll(sel)).map(e => e.textContent.replace(/\s+/g, ' ').trim());
const setVal = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
const check = (w, el, on = true) => { el.checked = on; el.dispatchEvent(new w.Event('change', { bubbles: true })); };

console.log('== not configured ==');
{ const { d } = await boot({ noConfig: true }); ok('shows Setup needed screen', /Setup needed/.test(d.body.textContent)); }

console.log('\n== auth screens ==');
{
  const { w, d, be } = await boot({});
  ok('login screen renders with locked +91', /\+91/.test(d.body.textContent) && !!d.querySelector('#login-phone'));
  const ph = d.querySelector('#login-phone');
  setVal(w, ph, '98a76-54321 0999'); ok('phone input strips non-digits and caps at 10', ph.value === '9876543210', ph.value);
  setVal(w, ph, '1234567890'); setVal(w, d.querySelector('#login-pass'), 'whatever1');
  d.querySelector('#login-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  ok('rejects phone not starting 6-9', /valid 10-digit/.test(d.querySelector('#auth-error').textContent));
  setVal(w, ph, '9876543210'); setVal(w, d.querySelector('#login-pass'), 'wrongpass1');
  d.querySelector('#login-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(80);
  ok('wrong password gives friendly error', /Wrong mobile number or password/.test(d.querySelector('#auth-error').textContent), d.querySelector('#auth-error')?.textContent);
  d.querySelector('#tab-signup').click(); await tick();
  setVal(w, d.querySelector('#su-name'), 'Alice'); setVal(w, d.querySelector('#su-phone'), '9876543210');
  setVal(w, d.querySelector('#su-pass'), 'short'); setVal(w, d.querySelector('#su-pass2'), 'short');
  d.querySelector('#signup-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  ok('short password rejected on signup', /at least 8/.test(d.querySelector('#auth-error').textContent));
  setVal(w, d.querySelector('#su-pass'), 'longenough1'); setVal(w, d.querySelector('#su-pass2'), 'different11');
  d.querySelector('#signup-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  ok('password mismatch rejected', /do not match/.test(d.querySelector('#auth-error').textContent));
  setVal(w, d.querySelector('#su-email'), 'bad-email');
  setVal(w, d.querySelector('#su-pass2'), 'longenough1');
  d.querySelector('#signup-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  ok('bad optional email rejected', /valid email/.test(d.querySelector('#auth-error').textContent));
  setVal(w, d.querySelector('#su-email'), '');
  d.querySelector('#signup-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(100);
  const su = be.db.calls.find(c => c.rpc === 'signUp');
  ok('signUp uses derived login address (no SMS provider needed)', su && su.a.email === '919876543210@phone.idarah.example.com' && !su.a.phone, JSON.stringify(su));
  const si = be.db.calls.find(c => c.rpc === 'signIn');
  ok('signIn uses the same derived address', si && si.a.email === '919876543210@phone.idarah.example.com', JSON.stringify(si));
  ok('after signup with no committee -> wizard step 1', /Step 1 of/.test(d.body.textContent));
}

console.log('\n== onboarding wizard (new committee) ==');
{
  const { w, d, be } = await boot({ signedIn: true });
  ok('signed-in user without committee lands in wizard', /Committee & Modules/.test(d.body.textContent));
  ok('5 module cards shown', d.querySelectorAll('.pf-module-card').length === 5);
  d.querySelector('#pf-next').click(); await tick();
  ok('cannot proceed without committee name', /committee \/ trust name/i.test(d.querySelector('#pf-wizard-error').textContent));
  setVal(w, d.querySelector('#pf-c-name'), 'Anjuman Committee'); setVal(w, d.querySelector('#pf-c-city'), 'Kolkata'); setVal(w, d.querySelector('#pf-c-state'), 'West Bengal');
  d.querySelector('#pf-next').click(); await tick();
  ok('cannot proceed with zero modules ticked', /at least one module/i.test(d.querySelector('#pf-wizard-error').textContent));
  const cbs = d.querySelectorAll('.pf-module-card input');
  check(w, cbs[0]); check(w, cbs[1]); check(w, cbs[4]);   // mosque, madarsa, waqf
  ok('header shows total steps = 1 + ticked', /Step 1 of 4/.test(d.querySelector('.pf-step-label').textContent), d.querySelector('.pf-step-label').textContent);
  d.querySelector('#pf-next').click(); await tick();
  ok('Step 2 of 4: Mosque Details', /Step 2 of 4: Mosque Details/.test(d.querySelector('.pf-step-label').textContent), d.querySelector('.pf-step-label').textContent);
  ok('mosque form has its 6 fields', d.querySelectorAll('#pf-module-form [data-key]').length === 6, String(d.querySelectorAll('#pf-module-form [data-key]').length));
  d.querySelector('#pf-next').click(); await tick();
  ok('required fields flagged on empty mosque form', d.querySelectorAll('.pf-field-error').length >= 5);
  setVal(w, d.querySelector('[data-key="module_name"]'), 'Jamia Masjid');
  setVal(w, d.querySelector('[data-key="locality"]'), 'Park Circus');
  setVal(w, d.querySelector('[data-key="calc_method"]'), 'hanafi');
  setVal(w, d.querySelector('[data-key="jummah_khutbah_time"]'), '12:30');
  setVal(w, d.querySelector('[data-key="jummah_jamaat_time"]'), '13:15');
  setVal(w, d.querySelector('[data-key="capacity"]'), '500');
  d.querySelector('#pf-next').click(); await tick();
  ok('Step 3 of 4: Madarsa Details', /Step 3 of 4: Madarsa Details/.test(d.querySelector('.pf-step-label').textContent));
  ok('fee amount hidden until "Monthly Fee" chosen', !d.querySelector('[data-key="default_monthly_fee"]'));
  setVal(w, d.querySelector('[data-key="fee_structure"]'), 'monthly_fee');
  ok('fee amount field appears for Monthly Fee', !!d.querySelector('[data-key="default_monthly_fee"]'));
  setVal(w, d.querySelector('[data-key="module_name"]'), 'Madarsa Faiz');
  setVal(w, d.querySelector('[data-key="madarsa_type"]'), 'maktab_morning');
  setVal(w, d.querySelector('[data-key="shift_timings"]'), '7-9 AM');
  setVal(w, d.querySelector('[data-key="medium"]'), 'urdu');
  d.querySelector('#pf-next').click(); await tick();
  ok('monthly fee amount is required once shown', /required/.test(d.querySelector('.pf-field-error')?.textContent || ''));
  setVal(w, d.querySelector('[data-key="default_monthly_fee"]'), '300');
  d.querySelector('#pf-back').click(); await tick();
  ok('Back keeps previous values', d.querySelector('[data-key="module_name"]').value === 'Jamia Masjid');
  d.querySelector('#pf-next').click(); await tick();
  ok('values of madarsa step preserved', d.querySelector('[data-key="module_name"]').value === 'Madarsa Faiz');
  d.querySelector('#pf-next').click(); await tick();
  ok('Step 4 of 4: Charitable / Waqf', /Step 4 of 4: Charitable Organization \/ Waqf Details/.test(d.querySelector('.pf-step-label').textContent), d.querySelector('.pf-step-label').textContent);
  setVal(w, d.querySelector('[data-key="module_name"]'), 'Mahalla Trust');
  setVal(w, d.querySelector('[data-key="registration_no"]'), 'WB/WAQF/123');
  setVal(w, d.querySelector('[data-key="primary_focus"]'), 'zakat_sadaqah');
  check(w, d.querySelector('input[type=radio][data-key="zakat_tracking"][value="yes"]'));
  setVal(w, d.querySelector('[data-key="receipt_prefix"]'), 'w!');
  d.querySelector('#pf-next').click(); await tick();
  ok('receipt prefix pattern enforced', /capital letters/.test(d.querySelector('.pf-field-error')?.textContent || ''));
  setVal(w, d.querySelector('[data-key="receipt_prefix"]'), 'wqf');
  d.querySelector('#pf-next').click(); await tick(150);
  const rpc = be.db.calls.find(c => c.rpc === 'create_committee_with_modules');
  ok('ONE atomic RPC call creates committee + all modules', !!rpc && rpc.args.p_modules.length === 3, JSON.stringify(rpc && rpc.args).slice(0, 300));
  ok('payload types in order mosque, madarsa, waqf_charity', rpc && rpc.args.p_modules.map(m => m.module_type).join() === 'mosque,madarsa,waqf_charity');
  ok('module_name split from details; booleans + numbers typed', rpc && rpc.args.p_modules[2].module_name === 'Mahalla Trust' && rpc.args.p_modules[2].details.zakat_tracking === true && rpc.args.p_modules[0].details.capacity === 500 && rpc.args.p_modules[2].details.receipt_prefix === 'WQF');
  ok('then shows the familiar workspace: green header, committee bar and tab bar', !!d.querySelector('.app-header') && !!d.querySelector('.mosque-bar') && !!d.querySelector('.nav-tabs-bar'));
  const side = txt(d, '.nav-tabs-container a');
  ok('sidebar lists ONLY the 3 onboarded modules', side.some(s => /Jamia Masjid/.test(s)) && side.some(s => /Madarsa Faiz/.test(s)) && side.some(s => /Mahalla Trust/.test(s)) && !side.some(s => /Dargah|Imambargah/.test(s)), side.join(' | '));
  ok('creator (admin) sees Dashboard, Finance, Reports and Settings tabs', ['Dashboard', 'Finance', 'Reports', 'Settings'].every(n => side.some(s => s.includes(n))), side.join(' | '));
}

console.log('\n== module gating & add module ==');
{
  const mem = [{ id: 'm1', user_id: 'u1', roles: ['admin'], allowed_modules: null, status: 'active', committee: { id: 'cA', name: 'Committee A', city: 'Kolkata', state: 'West Bengal', country: 'India' } },
               { id: 'm2', user_id: 'u1', roles: ['teacher'], allowed_modules: null, status: 'active', committee: { id: 'cB', name: 'Committee B', city: 'Pune', state: 'Maharashtra', country: 'India' } }];
  const mods = [{ id: 'a1', committee_id: 'cA', module_type: 'mosque', module_name: 'Mosque A1', details: { locality: 'X' }, is_active: true },
                { id: 'a2', committee_id: 'cA', module_type: 'mosque', module_name: 'Mosque A2', details: {}, is_active: true },
                { id: 'b1', committee_id: 'cB', module_type: 'dargah', module_name: 'Dargah B', details: { langar_active: true, urs_calendar: 'hijri' }, is_active: true }];
  const { w, d, be } = await boot({ signedIn: true, memberships: mem, modules: mods });
  let side = txt(d, '.nav-tabs-container a');
  ok('active committee A: two mosques of the same type listed', side.filter(s => /Mosque A/.test(s)).length === 2);
  ok('no other-committee module in sidebar', !side.some(s => /Dargah B/.test(s)));
  ok('un-onboarded types (madarsa, imambargah...) not in sidebar', !side.some(s => /Madarsa|Imambargah|Waqf/.test(s)));
  w.location.hash = '#module/b1'; await tick();
  ok("route to other committee's module is refused (falls back to Overview)", /Modules \(2\)/.test(d.querySelector('#pf-main').textContent));
  w.location.hash = '#module/a1'; await tick();
  ok('module page renders for onboarded module', /Mosque A1/.test(d.querySelector('#pf-main').textContent));
  w.location.hash = '#add-module'; await tick();
  ok('add-module shows all 5 types with "already onboarded" note for mosque', d.querySelectorAll('.pf-module-card').length === 5 && /Already onboarded: 2/.test(d.querySelector('#pf-main').textContent));
  check(w, d.querySelectorAll('.pf-module-card input')[3]);   // imambargah
  d.querySelector('#pf-next').click(); await tick();
  ok('add flow: Step 2 of 2: Imambargah Details', /Step 2 of 2: Imambargah Details/.test(d.querySelector('.pf-step-label').textContent), d.querySelector('.pf-step-label').textContent);
  setVal(w, d.querySelector('[data-key="module_name"]'), 'Imambargah A');
  setVal(w, d.querySelector('[data-key="locality"]'), 'Old City');
  setVal(w, d.querySelector('[data-key="majlis_schedule"]'), 'both');
  setVal(w, d.querySelector('[data-key="capacity"]'), '900');
  check(w, d.querySelector('input[type=radio][data-key="kitchen_active"][value="no"]'));
  d.querySelector('#pf-next').click(); await tick(150);
  const add = be.db.calls.find(c => c.rpc === 'add_modules');
  ok('add_modules called with SAME committee_id', add && add.args.p_committee_id === 'cA', JSON.stringify(add));
  side = txt(d, '.nav-tabs-container a');
  ok('new module appears in sidebar immediately', side.some(s => /Imambargah A/.test(s)));
  // switch committee
  const sw = d.querySelector('#pf-switcher');
  setVal(w, sw, 'cB'); await tick(60);
  side = txt(d, '.nav-tabs-container a');
  ok('switching to committee B shows only B modules', side.some(s => /Dargah B/.test(s)) && !side.some(s => /Mosque A|Imambargah A/.test(s)), side.join(' | '));
  ok('teacher in B has no Finance / Reports / Settings tabs', !side.some(s => /Finance|Reports|Settings/.test(s)), side.join(' | '));
  w.location.hash = '#team'; await tick(); ok('teacher cannot open #team route', /Modules \(1\)/.test(d.querySelector('#pf-main').textContent));
  w.location.hash = '#add-module'; await tick(); ok('teacher cannot open #add-module route', /Modules \(1\)/.test(d.querySelector('#pf-main').textContent));
  w.location.hash = '#module/b1/details'; await tick();
  ok('module page shows formatted values (Yes / Hijri)', /Yes/.test(d.querySelector('#pf-main').textContent) && /Hijri/.test(d.querySelector('#pf-main').textContent));
  ok('teacher sees no Edit button', !d.querySelector('#pf-edit-btn'));
  // escape check
}

console.log('\n== finance screens ==');
{
  const mk = roles => [{ id: 'm1', user_id: 'u1', roles, allowed_modules: null, status: 'active', committee: { id: 'cA', name: 'Committee A', city: 'K', state: 'WB', country: 'India' } }];
  const mods = [{ id: 'a1', committee_id: 'cA', module_type: 'madarsa', module_name: 'Madarsa A', details: {}, is_active: true }];
  const funds = [{ id: 'fg', committee_id: 'cA', module_id: 'a1', name: 'General Fund', code: 'GENERAL', fund_type: 'general', is_zakat_restricted: false, is_default: true, current_balance: 0, description: null },
                 { id: 'fz', committee_id: 'cA', module_id: 'a1', name: 'Zakat', code: 'ZAKAT', fund_type: 'zakat', is_zakat_restricted: true, is_default: true, current_balance: 0, description: null }];
  const { w, d, be } = await boot({ signedIn: true, memberships: mk(['accountant']), modules: mods, funds });
  w.location.hash = '#finance/a1'; await tick(100);
  ok('accountant sees Finance tab', /Finance/.test(d.querySelector('.nav-tabs-container').textContent));
  ok('fund cards show both funds with Zakat Restricted badge', d.querySelectorAll('.metric-card').length === 2 && /Zakat Restricted/.test(d.querySelector('#pf-main').textContent));

  // ---- create custom fund
  d.querySelector('#fin-newfund').click(); await tick();
  let fm = d.querySelector('.modal-overlay');
  ok('Create New Fund modal has name, description and the two rule types', !!fm.querySelector('#n-name') && !!fm.querySelector('#n-desc') && fm.querySelectorAll('input[name="n-rule"]').length === 2 && /7 Zakat categories/.test(fm.textContent));
  fm.querySelector('#fin-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  ok('fund name required', /fund name/i.test(fm.querySelector('#fin-err').textContent));
  setVal(w, fm.querySelector('#n-name'), 'Ramadan Iftar Fund'); setVal(w, fm.querySelector('#n-desc'), 'Iftar for the community');
  fm.querySelector('#fin-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  const nf = be.db.funds.find(x => x.name === 'Ramadan Iftar Fund');
  ok('custom fund saved (general) with module + committee', nf && nf.module_id === 'a1' && nf.committee_id === 'cA' && nf.is_zakat_restricted === false, JSON.stringify(nf));
  ok('client does not send balance / default flag / code', nf && !('current_balance' in be.db.calls.find(c => c.table === 'funds' && c.op === 'insert').payload) && !('is_default' in be.db.calls.find(c => c.table === 'funds' && c.op === 'insert').payload));
  ok('new fund card appears with Custom badge and description', /Ramadan Iftar Fund/.test(d.querySelector('#pf-main').textContent) && /Custom/.test(d.querySelector('#pf-main').textContent) && /Iftar for the community/.test(d.querySelector('#pf-main').textContent));
  d.querySelector('#fin-newfund').click(); await tick();
  fm = d.querySelector('.modal-overlay');
  setVal(w, fm.querySelector('#n-name'), 'ramadan iftar fund');
  fm.querySelector('#fin-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  ok('duplicate fund name shows a friendly error', /already exists/.test(fm.querySelector('#fin-err').textContent), fm.querySelector('#fin-err')?.textContent);
  setVal(w, fm.querySelector('#n-name'), 'Special Zakat Drive'); check(w, fm.querySelector('input[name="n-rule"][value="zakat"]'));
  fm.querySelector('#fin-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  ok('Zakat-restricted custom fund saved', be.db.funds.some(x => x.name === 'Special Zakat Drive' && x.is_zakat_restricted === true));
  ok('modal closed after success', !d.querySelector('.modal-overlay'));

  // ---- donation
  d.querySelector('#fin-donation').click(); await tick();
  const dm = d.querySelector('.modal-overlay');
  ok('donation modal opens', !!dm);
  setVal(w, dm.querySelector('#d-amt'), '0'); dm.querySelector('#fin-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  ok('zero amount rejected before sending', /greater than zero/.test(dm.querySelector('#fin-err').textContent));
  setVal(w, dm.querySelector('#d-amt'), '1500'); setVal(w, dm.querySelector('#d-name'), 'Farhan'); setVal(w, dm.querySelector('#d-phone'), '98x76');
  dm.querySelector('#fin-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  ok('bad donor phone rejected', /valid 10-digit/.test(dm.querySelector('#fin-err').textContent));
  setVal(w, dm.querySelector('#d-phone'), '9876543210'); setVal(w, dm.querySelector('#d-method'), 'upi');
  dm.querySelector('#fin-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  const ins = be.db.ledger[0];
  const sent = be.db.calls.find(c => c.table === 'ledger_entries' && c.op === 'insert').payload;
  ok('donation payload uses the new column names', ins && sent.entry_type === 'donation' && sent.amount === 1500 && sent.committee_id === 'cA' && sent.module_id === 'a1' && sent.fund_id === 'fg' && sent.payment_mode === 'upi' && sent.donor_or_payee_name === 'Farhan', JSON.stringify(sent));
  ok('donor phone sent in +91 format', sent.donor_phone === '+919876543210');
  ok('client does NOT send sequence_no / hashes / receipt / created_by (database assigns them)', !['sequence_no', 'entry_hash', 'prev_hash', 'receipt_number', 'verification_code', 'created_by', 'created_at', 'is_reversed'].some(k => k in sent));
  ok('official receipt shown with number and code', /RCP-0001/.test(d.body.textContent) && /ABCD2345/.test(d.body.textContent));
  const wa = d.querySelector('a[href^="https://wa.me/"]');
  ok('WhatsApp link is wa.me, addressed to the donor, prefilled with receipt data', wa && wa.href.startsWith('https://wa.me/919876543210?text=') && /RCP-0001/.test(decodeURIComponent(wa.href)) && /ABCD2345/.test(decodeURIComponent(wa.href)) && /Farhan/.test(decodeURIComponent(wa.href)) && /Madarsa A/.test(decodeURIComponent(wa.href)), wa && wa.href);
  ok('receipt has a Print button', !!d.querySelector('#fin-print'));
  d.querySelector('.modal-overlay .modal-close-btn').click(); await tick(100);
  ok('fund balance updated to ₹1,500', /₹1,500/.test(d.querySelector('#pf-main').textContent));

  // ---- expense
  d.querySelector('#fin-expense').click(); await tick();
  const em = d.querySelector('.modal-overlay');
  setVal(w, em.querySelector('#x-fund'), 'fz');
  const zcats = Array.from(em.querySelectorAll('#x-cat option')).map(o => o.value);
  ok('Zakat fund offers exactly the 7 Zakat categories', zcats.join() === 'fuqara_poor,masakin_needy,amilin_zakat_admin,muallafat_new_muslims,riqab_freeing_captives,gharimin_debtors,ibn_sabil_wayfarers', zcats.join());
  ok('Zakat notice visible; available balance shown', !em.querySelector('#x-zakat').hidden && /Available in this fund: ₹0/.test(em.querySelector('#x-bal').textContent), em.querySelector('#x-bal').textContent);
  setVal(w, em.querySelector('#x-fund'), 'fg');
  ok('general fund shows general categories and the available balance', em.querySelectorAll('#x-cat option').length === 10 && em.querySelector('#x-zakat').hidden && /₹1,500/.test(em.querySelector('#x-bal').textContent));
  setVal(w, em.querySelector('#x-amt'), '99999');
  em.querySelector('#fin-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  ok('overdraft caught client-side with available amount', /Not enough money.*1,500/.test(em.querySelector('#fin-err').textContent), em.querySelector('#fin-err').textContent);
  setVal(w, em.querySelector('#x-amt'), '400'); setVal(w, em.querySelector('#x-payee'), 'CESC');
  em.querySelector('#fin-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  ok('expense saved with payee and category', be.db.ledger.length === 2 && be.db.ledger[1].entry_type === 'expense' && be.db.ledger[1].category === 'exp_electric_water' && be.db.ledger[1].donor_or_payee_name === 'CESC');
  ok('ledger table shows both blocks', d.querySelectorAll('#pf-main tbody tr').length === 2);

  // ---- reversal
  const revBtns = d.querySelectorAll('.fin-reverse');
  ok('every active entry has a Reverse button', revBtns.length === 2);
  d.querySelectorAll('.fin-reverse')[0].click(); await tick();      // newest first = the expense
  const rm = d.querySelector('.modal-overlay');
  rm.querySelector('#fin-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  ok('reversal requires a reason', /reason/i.test(rm.querySelector('#fin-err').textContent));
  setVal(w, rm.querySelector('#r-reason'), 'entered twice');
  rm.querySelector('#fin-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  const rev = be.db.ledger[2];
  ok('reversal sends target id + reason (new column names)', rev && rev.entry_type === 'reversal' && rev.reversed_entry_id === 'L2' && rev.reversal_reason === 'entered twice', JSON.stringify(rev));
  const rowReversed = d.querySelector('tr.row-reversed');
  ok('reversed entry stays visible with "Reversed" badge, strike-through class and the reason', rowReversed && /Reversed/.test(rowReversed.textContent) && /entered twice/.test(rowReversed.textContent) && /entered twice/.test(rowReversed.getAttribute('title')), rowReversed && rowReversed.outerHTML.slice(0, 200));
  ok('reversed entry and reversal row have no Reverse button', d.querySelectorAll('.fin-reverse').length === 1);
  ok('reversal row explains what it reverses', /Reverses #2/.test(d.querySelector('tr.row-reversal').textContent), d.querySelector('tr.row-reversal')?.textContent);
  d.querySelector('#fin-verify').click(); await tick(100);
  ok('verify shows green "Ledger Verified (N entries intact)"', /Ledger Verified \(3 entries intact\)/.test(d.querySelector('#fin-banner').textContent) && !!d.querySelector('#fin-banner .intact'), d.querySelector('#fin-banner').textContent);
}
{
  const mods = [{ id: 'a1', committee_id: 'cA', module_type: 'madarsa', module_name: 'Madarsa A', details: {}, is_active: true }];
  for (const role of ['teacher', 'imam_zakir', 'volunteer', 'parent']) {
    const mem = [{ id: 'm1', user_id: 'u1', roles: [role], allowed_modules: null, status: 'active', committee: { id: 'cA', name: 'Committee A', city: 'K', state: 'WB', country: 'India' } }];
    const { w, d } = await boot({ signedIn: true, memberships: mem, modules: mods });
    w.location.hash = '#finance/a1'; await tick(80);
    ok(role + ': no Finance / Reports tab; typing the finance URL shows the dashboard instead', !/Finance|Reports/.test(d.querySelector('.nav-tabs-container').textContent) && !d.querySelector('#fin-donation') && !d.querySelector('#fin-newfund') && /Madarsa A/.test(d.querySelector('#pf-main').textContent));
  }
  for (const role of ['admin', 'mutawalli_trustee']) {
    const mem = [{ id: 'm1', user_id: 'u1', roles: [role], allowed_modules: null, status: 'active', committee: { id: 'cA', name: 'Committee A', city: 'K', state: 'WB', country: 'India' } }];
    const { w, d } = await boot({ signedIn: true, memberships: mem, modules: mods, funds: [] });
    w.location.hash = '#finance/a1'; await tick(80);
    ok(role + ' sees Finance tab and the create / record buttons', /Finance/.test(d.querySelector('.nav-tabs-container').textContent) && !!d.querySelector('#fin-newfund') && !!d.querySelector('#fin-donation'));
  }
}

console.log('\n== familiar layout, dashboard, madarsa, mosque, reports, settings ==');
{
  const mem = roles => [{ id: 'm1', user_id: 'u1', roles, allowed_modules: null, status: 'active', committee: { id: 'cA', name: 'Anjuman Committee', city: 'Kolkata', state: 'West Bengal', country: 'India' } }];
  const mods = [
    { id: 'a1', committee_id: 'cA', module_type: 'madarsa', module_name: 'Madarsa Faiz', details: { default_monthly_fee: 300, medium: 'urdu' }, is_active: true },
    { id: 'a2', committee_id: 'cA', module_type: 'mosque', module_name: 'Jamia Masjid', details: { jummah_khutbah_time: '12:30', jummah_jamaat_time: '13:15', calc_method: 'hanafi' }, is_active: true }];
  const fnd = (id, mod, name, code, z, bal) => ({ id, committee_id: 'cA', module_id: mod, name, code, is_zakat_restricted: z, is_default: true, current_balance: bal });
  const funds = [fnd('f1', 'a1', "Ta'lim & Student Welfare Fund", 'TALIM_WELFARE', false, 1000), fnd('f2', 'a1', 'General Fund', 'GENERAL', false, 200), fnd('f3', 'a2', 'General Fund', 'GENERAL', false, 500)];
  const now = new Date().toISOString();
  const ledger = [
    { id: 'L1', committee_id: 'cA', module_id: 'a1', sequence_no: 1, created_at: now, entry_type: 'donation', amount: 1000, fund_id: 'f1', category: 'student_fee', entry_hash: 'a'.repeat(64), is_reversed: false, receipt_number: 'RCP-0001' },
    { id: 'L2', committee_id: 'cA', module_id: 'a1', sequence_no: 2, created_at: now, entry_type: 'expense', amount: 300, fund_id: 'f1', category: 'exp_misc', notes: 'chalk', entry_hash: 'b'.repeat(64), is_reversed: false }];
  const { w, d, be } = await boot({ signedIn: true, memberships: mem(['admin']), modules: mods, funds, ledger, tables: { notices: [{ id: 'n1', committee_id: 'cA', module_id: 'a2', title: 'Jumuah Khutbah Notice', body: 'Be early', published_on: '2026-11-18' }] } });

  // ---- layout
  const navText = () => Array.from(d.querySelectorAll('.nav-tabs-container a')).map(a => a.textContent.trim());
  ok('old-style tab bar order: Dashboard, Finance, <modules>, Reports, Settings', navText().join('|').replace(/\s+/g, ' ').match(/Dashboard.*Finance.*Madarsa Faiz.*Jamia Masjid.*Reports.*Settings/), navText().join('|'));
  ok('committee bar shows location, user and role chips', /Kolkata, West Bengal/.test(d.querySelector('.mosque-bar').textContent) && /Admin/.test(d.querySelector('.mosque-bar').textContent) && !!d.querySelector('#pf-switcher'));
  await tick(100);
  const dash = d.querySelector('#pf-main').textContent;
  ok('dashboard: Total Treasury Balance = sum of all funds (₹1,700)', /Total Treasury Balance/.test(dash) && /₹1,700/.test(dash), dash.slice(0, 200));
  ok('dashboard: fund balances grouped per module', /Fund Balances/.test(dash) && /Ta'lim/.test(dash));
  ok('dashboard: madarsa card (students, pending fees) + mosque salah card + latest notices', /Enrolled Students/.test(dash) && /Pending Fees for/.test(dash) && /Salah Timings/.test(dash) && /Jumuah Khutbah Notice/.test(dash));

  // ---- madarsa module
  w.location.hash = '#module/a1'; await tick(120);
  const btns = () => Array.from(d.querySelectorAll('#pf-main .card-header a.btn')).map(a => a.textContent.replace(/\s+/g, ' ').trim());
  ok('madarsa page offers Students & Fees, Attendance & Quran, Teachers & Salaries, Notices, Assets, Details', ['Students & Fees', 'Attendance & Quran', 'Teachers & Salaries', 'Notices', 'Assets', 'Details'].every(n => btns().some(b => b.includes(n))), btns().join('|'));
  d.querySelector('#pf-crud-add').click(); await tick();
  let fm = d.querySelector('.modal-overlay');
  ok('add-student form is prefilled with the madarsa default fee', fm.querySelector('[data-key="monthly_fee"]').value === '300');
  setVal(w, fm.querySelector('[data-key="full_name"]'), 'Muhammad Zaid'); setVal(w, fm.querySelector('[data-key="guardian_name"]'), 'Tariq Ahmad');
  setVal(w, fm.querySelector('[data-key="guardian_phone"]'), '12345'); setVal(w, fm.querySelector('[data-key="class_name"]'), 'Hifz A');
  fm.querySelector('#pf-crud-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  ok('invalid guardian mobile is flagged', /valid 10-digit/.test(fm.textContent));
  fm = d.querySelector('.modal-overlay'); setVal(w, fm.querySelector('[data-key="guardian_phone"]'), '9876500001');
  fm.querySelector('#pf-crud-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  const st = be.db.tables.students && be.db.tables.students[0];
  ok('student saved with committee + module and typed fee', st && st.committee_id === 'cA' && st.module_id === 'a1' && st.monthly_fee === 300 && st.guardian_phone === '9876500001', JSON.stringify(st));
  ok('student listed with Fee Due badge and pending-dues banner', /Muhammad Zaid/.test(d.querySelector('#pf-sec').textContent) && /Due/.test(d.querySelector('#pf-sec').textContent) && /Pending dues for/.test(d.querySelector('#pf-sec').textContent));
  const feeBtn = Array.from(d.querySelectorAll('#pf-sec .pf-xa')).find(b => /Collect Fee/.test(b.textContent));
  ok('admin sees Collect Fee', !!feeBtn);
  feeBtn.click(); await tick();
  fm = d.querySelector('.modal-overlay');
  ok('fee form prefilled with the student fee and current month', fm.querySelector('#fee-amt').value === '300' && /^\d{4}-\d{2}$/.test(fm.querySelector('#fee-month').value));
  fm.querySelector('#fee-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(200);
  const feeCall = be.db.calls.find(c => c.rpc === 'collect_student_fee');
  ok('fee collected through ONE atomic database call (student, month, amount, mode)', feeCall && feeCall.args.p_student_id === st.id && feeCall.args.p_amount === 300 && feeCall.args.p_payment_mode === 'cash', JSON.stringify(feeCall));
  ok('official receipt opens after collecting the fee', /Official Receipt/.test(d.body.textContent) && /RCP-000/.test(d.body.textContent));
  d.querySelector('.modal-overlay .modal-close-btn').click(); await tick(100);
  ok('student now shows Paid and the Collect Fee button is gone', /Paid/.test(d.querySelector('#pf-sec').textContent) && !Array.from(d.querySelectorAll('#pf-sec .pf-xa')).some(b => /Collect Fee/.test(b.textContent)));

  // ---- attendance + Quran progress
  w.location.hash = '#module/a1/attendance'; await tick(150);
  const row = d.querySelector('#att-body tr');
  ok('attendance table lists the student with Present / Absent and Sabaq / Sabqi / Manzil boxes', !!row && !!row.querySelector('input[value="present"]') && !!row.querySelector('.sabaq-in') && !!row.querySelector('.sabqi-in') && !!row.querySelector('.manzil-in'));
  check(w, row.querySelector('input[value="present"]')); row.querySelector('.sabaq-in').value = 'Baqarah 1-25'; row.querySelector('.manzil-in').value = 'Para 30';
  d.querySelector('#att-save').click(); await tick(150);
  const attRow = be.db.tables.attendance && be.db.tables.attendance[0]; const hifzRow = be.db.tables.hifz_logs && be.db.tables.hifz_logs[0];
  ok('attendance saved (upsert per student per day)', attRow && attRow.status === 'present' && attRow.student_id === st.id && attRow.committee_id === 'cA' && attRow.module_id === 'a1', JSON.stringify(attRow));
  ok('Quran progress saved with the same date', hifzRow && hifzRow.sabaq === 'Baqarah 1-25' && hifzRow.manzil === 'Para 30' && hifzRow.log_date === attRow.attendance_date, JSON.stringify(hifzRow));
  d.querySelector('#att-save').click(); await tick(150);
  ok('saving again updates the same rows instead of duplicating them', be.db.tables.attendance.length === 1 && be.db.tables.hifz_logs.length === 1);

  // ---- staff & salaries
  w.location.hash = '#module/a1/staff'; await tick(150);
  d.querySelector('#pf-crud-add').click(); await tick();
  fm = d.querySelector('.modal-overlay');
  setVal(w, fm.querySelector('[data-key="full_name"]'), 'Qari Bilal'); setVal(w, fm.querySelector('[data-key="role_title"]'), 'Head Ustad'); setVal(w, fm.querySelector('[data-key="monthly_salary"]'), '15000');
  fm.querySelector('#pf-crud-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  ok('staff member saved', be.db.tables.teachers && be.db.tables.teachers[0].full_name === 'Qari Bilal' && be.db.tables.teachers[0].monthly_salary === 15000);
  Array.from(d.querySelectorAll('#pf-sec .pf-xa')).find(b => /Pay Salary/.test(b.textContent)).click(); await tick();
  fm = d.querySelector('.modal-overlay');
  fm.querySelector('#sal-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  ok('salary larger than the fund is refused with the database message shown', /Insufficient balance/.test(fm.querySelector('#sal-err').textContent), fm.querySelector('#sal-err')?.textContent);
  setVal(w, fm.querySelector('#sal-amt'), '150'); fm.querySelector('#sal-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(200);
  ok('salary paid through the atomic call and shows Paid', be.db.calls.some(c => c.rpc === 'pay_staff_salary' && c.args.p_amount === 150) && /Paid/.test(d.querySelector('#pf-sec').textContent));

  // ---- mosque: timings, notices, registers
  w.location.hash = '#module/a2'; await tick(150);
  ok('mosque default screen is Salah Timings with 6 prayers; Jumu\'ah prefilled from onboarding', d.querySelectorAll('#pt-form input[type=time]').length === 12 && d.querySelector('#pt-jumuah-i').value === '13:15' && d.querySelector('#pt-jumuah-a').value === '12:30');
  setVal(w, d.querySelector('#pt-fajr-i'), '05:30'); d.querySelector('#pt-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  ok('timings saved as 6 upserts keyed by module + prayer', be.db.tables.prayer_times.length === 6 && be.db.tables.prayer_times.find(p => p.prayer === 'fajr').iqamah_time === '05:30');
  w.location.hash = '#module/a2/notices'; await tick(150);
  ok('notice list with WhatsApp share', /Jumuah Khutbah Notice/.test(d.querySelector('#pf-sec').textContent) && /WhatsApp/.test(d.querySelector('#pf-sec').textContent));
  d.querySelector('#pf-crud-add').click(); await tick();
  fm = d.querySelector('.modal-overlay'); setVal(w, fm.querySelector('[data-key="title"]'), 'Eid Prayer'); setVal(w, fm.querySelector('[data-key="body"]'), 'Eid at 8 AM');
  fm.querySelector('#pf-crud-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  ok('notice saved', be.db.tables.notices.some(n => n.title === 'Eid Prayer' && n.module_id === 'a2'));
  w.location.hash = '#module/a2/registers'; await tick(150);
  ok('Nikah and Janazah registers shown', /Nikah Register/.test(d.querySelector('#pf-sec').textContent) && /Janazah Register/.test(d.querySelector('#pf-sec').textContent));
  d.querySelector('#pf-nikah #pf-crud-add').click(); await tick();
  fm = d.querySelector('.modal-overlay');
  setVal(w, fm.querySelector('[data-key="groom"]'), 'Farhan Ali'); setVal(w, fm.querySelector('[data-key="bride"]'), 'Ayesha'); setVal(w, fm.querySelector('[data-key="mahr"]'), '51000'); setVal(w, fm.querySelector('[data-key="nikah_date"]'), '2026-11-05');
  fm.querySelector('#pf-crud-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick(150);
  ok('nikah record saved', be.db.tables.nikah_records && be.db.tables.nikah_records[0].groom === 'Farhan Ali' && be.db.tables.nikah_records[0].nikah_date === '2026-11-05');

  // ---- reports
  w.location.hash = '#reports'; await tick(200);
  const rep = d.querySelector('#pf-main').textContent;
  ok('monthly report shows committee, IST month and signature boxes', /Monthly Financial Report/.test(rep) && /Anjuman Committee/.test(rep) && /Mutawalli \/ President/.test(rep) && /Auditor \/ Stamp/.test(rep));
  ok('report totals: inflow includes ₹1,000 donation, outflow ₹300 expense', /Inflow/.test(rep) && /\+₹1,/.test(rep) && /-₹3/.test(rep), rep.slice(0, 300));
  ok('report can be restricted to one module or all modules', !!d.querySelector('#rep-mod') && !!d.querySelector('#rep-month') && !!d.querySelector('#rep-print'));

  // ---- settings
  w.location.hash = '#settings'; await tick(150);
  ok('settings: Team & Roles, Modules & Details, Onboard Another Module', /Team/.test(d.querySelector('#pf-main').textContent) && /Modules/.test(d.querySelector('#pf-main').textContent) && /Onboard Another Module/.test(d.querySelector('#pf-main').textContent));
  w.location.hash = '#settings/modules'; await tick(100);
  ok('settings > modules lists every module with its details', /Madarsa Faiz/.test(d.querySelector('#pf-set').textContent) && /Jamia Masjid/.test(d.querySelector('#pf-set').textContent) && /Hanafi/.test(d.querySelector('#pf-set').textContent));
}
{
  // ---- role-aware buttons (the database enforces; these only hide what cannot be used)
  const mk = roles => [{ id: 'm1', user_id: 'u1', roles, allowed_modules: null, status: 'active', committee: { id: 'cA', name: 'C', city: 'K', state: 'WB', country: 'India' } }];
  const mods = [{ id: 'a1', committee_id: 'cA', module_type: 'madarsa', module_name: 'Madarsa Faiz', details: {}, is_active: true }, { id: 'a2', committee_id: 'cA', module_type: 'mosque', module_name: 'Jamia Masjid', details: {}, is_active: true }];
  const tables = { students: [{ id: 'stu1', committee_id: 'cA', module_id: 'a1', full_name: 'Zaid', guardian_name: 'T', guardian_phone: '9876500001', class_name: 'A', monthly_fee: 300 }] };
  const funds = [{ id: 'f1', committee_id: 'cA', module_id: 'a1', name: 'General Fund', code: 'GENERAL', is_zakat_restricted: false, is_default: true, current_balance: 0 }];
  let r1 = await boot({ signedIn: true, memberships: mk(['teacher']), modules: mods, funds, tables: JSON.parse(JSON.stringify(tables)) });
  r1.w.location.hash = '#module/a1'; await tick(150);
  ok('teacher can add / edit students but cannot collect fees', !!r1.d.querySelector('#pf-crud-add') && !!r1.d.querySelector('.pf-edit') && !Array.from(r1.d.querySelectorAll('.pf-xa')).some(b => /Collect Fee/.test(b.textContent)));
  r1.w.location.hash = '#module/a2/timings'; await tick(100);
  ok('teacher sees Salah timings read-only', r1.d.querySelector('#pt-fajr-i').disabled && !r1.d.querySelector('#pt-save'));
  let r2 = await boot({ signedIn: true, memberships: mk(['accountant']), modules: mods, funds, tables: JSON.parse(JSON.stringify(tables)) });
  r2.w.location.hash = '#module/a1'; await tick(150);
  ok('accountant can collect fees but not add students', !!Array.from(r2.d.querySelectorAll('.pf-xa')).some(b => /Collect Fee/.test(b.textContent)) && !r2.d.querySelector('#pf-crud-add'));
  let r3 = await boot({ signedIn: true, memberships: mk(['imam_zakir']), modules: mods, funds, tables: JSON.parse(JSON.stringify(tables)) });
  r3.w.location.hash = '#module/a2/timings'; await tick(100);
  ok('imam can edit Salah timings', !!r3.d.querySelector('#pt-save') && !r3.d.querySelector('#pt-fajr-i').disabled);
  r3.w.location.hash = '#module/a2/staff'; await tick(150);
  ok('imam cannot manage staff', !r3.d.querySelector('#pf-crud-add'));
  let r4 = await boot({ signedIn: true, memberships: mk(['parent']), modules: mods, funds, tables: JSON.parse(JSON.stringify(tables)) });
  r4.w.location.hash = '#module/a1'; await tick(150);
  ok('parent sees the list but has no add / edit / fee buttons', !r4.d.querySelector('#pf-crud-add') && !r4.d.querySelector('.pf-edit') && !r4.d.querySelector('.pf-xa') && /Zaid/.test(r4.d.querySelector('#pf-sec').textContent));
  ok('parent has no Finance / Reports / Settings tabs', !/Finance|Reports|Settings/.test(r4.d.querySelector('.nav-tabs-container').textContent));
}
console.log('\n== language switcher ==');
{
  const { w, d } = await boot({});
  const sel = d.querySelector('select.pf-lang');
  ok('login screen has a language dropdown with 14 languages', !!sel && sel.options.length === 14 && Array.from(sel.options).map(o => o.value).join() === 'en,hi,ur,bn,gu,ks,ml,ta,te,kn,mr,as,or,pa');
  ok('starts in English, left-to-right', d.documentElement.getAttribute('lang') === 'en' && d.documentElement.getAttribute('dir') === 'ltr' && /Welcome to Idarah/.test(d.body.textContent));
  setVal(w, sel, 'hi'); await tick();
  ok('Hindi: text changes, still left-to-right', /इदारा में आपका स्वागत है/.test(d.body.textContent) && d.documentElement.getAttribute('dir') === 'ltr');
  setVal(w, d.querySelector('select.pf-lang'), 'bn'); await tick();
  ok('Bengali: text changes', /ইদারায় স্বাগতম/.test(d.body.textContent));
  setVal(w, d.querySelector('select.pf-lang'), 'ur'); await tick();
  ok('Urdu: text changes and page turns right-to-left', /ادارہ میں خوش آمدید/.test(d.body.textContent) && d.documentElement.getAttribute('dir') === 'rtl');
  ok('Urdu: placeholder is translated too', /10 ہندسوں/.test(d.querySelector('#login-phone').getAttribute('placeholder')));
  d.querySelector('#tab-signup').click(); await tick();
  ok('language stays after moving to Sign Up', /اکاؤنٹ بنائیں/.test(d.body.textContent) && d.querySelector('select.pf-lang').value === 'ur');
  setVal(w, d.querySelector('select.pf-lang'), 'ks'); await tick();
  ok('Kashmiri: page turns right-to-left with lang="ks"', d.documentElement.getAttribute('dir') === 'rtl' && d.documentElement.getAttribute('lang') === 'ks');
  setVal(w, d.querySelector('select.pf-lang'), 'gu'); await tick();
  ok('Gujarati: text changes, left-to-right', /[઀-૿]/.test(d.body.textContent) && d.documentElement.getAttribute('dir') === 'ltr');
  for (const l of ['ml', 'ta', 'te', 'kn', 'mr', 'as', 'or', 'pa']) {
    setVal(w, d.querySelector('select.pf-lang'), l); await tick();
    ok(l + ': works with no missing-text errors (falls back to English), left-to-right', /Welcome to Idarah/.test(d.body.textContent) && d.documentElement.getAttribute('lang') === l && d.documentElement.getAttribute('dir') === 'ltr');
  }
  setVal(w, d.querySelector('select.pf-lang'), 'en'); await tick();
  ok('back to English restores the original text', /Create Account/.test(d.body.textContent) && d.documentElement.getAttribute('dir') === 'ltr');
  ok('choice is remembered on the phone', w.localStorage.getItem('idarah_lang') === 'en');
}
{
  const mk = [{ id: 'm1', user_id: 'u1', roles: ['admin'], allowed_modules: null, status: 'active', committee: { id: 'cA', name: 'Test', city: 'Pune', state: 'MH', country: 'India' } }];
  const { w, d } = await boot({ signedIn: true, memberships: mk, modules: [{ id: 'a1', committee_id: 'cA', module_type: 'mosque', module_name: 'Mosque', details: {}, is_active: true }] });
  const sel = d.querySelector('.header-controls select.pf-lang');
  ok('dropdown sits in the header right before the Log out button', !!sel && sel.nextElementSibling === d.querySelector('#pf-logout'));
  setVal(w, sel, 'hi'); await tick();
  ok('Hindi on the main screen: Log out and tabs change', /लॉग आउट/.test(d.querySelector('#pf-logout').textContent) && /डैशबोर्ड/.test(d.querySelector('.nav-tabs-container').textContent));

  ok('language names in the dropdown never get translated', Array.from(d.querySelectorAll('select.pf-lang option')).map(o => o.textContent).join() === 'English,हिन्दी (Hindi),اردو (Urdu),বাংলা (Bengali),ગુજરાતી (Gujarati),کٲشُر (Kashmiri),മലയാളം (Malayalam),தமிழ் (Tamil),తెలుగు (Telugu),ಕನ್ನಡ (Kannada),मराठी (Marathi),অসমীয়া (Assamese),ଓଡ଼ିଆ (Odia),ਪੰਜਾਬੀ (Punjabi)');
  setVal(w, d.querySelector('select.pf-lang'), 'ur'); await tick();
  const sample = d.createElement('div'); sample.innerHTML = '<p>Step 2 of 3: Dargah</p><p>Donation recorded: RCP-0001</p><p>Not enough money in General Fund. Available: ₹10.</p><p>Some user typed note</p>'; d.body.appendChild(sample); await tick();
  const ps = Array.from(sample.querySelectorAll('p')).map(p => p.textContent);
  ok('patterns keep the changing part (Step 2 of 3)', ps[0] === 'مرحلہ 2 / 3: درگاہ', ps[0]);
  ok('patterns keep the receipt number', ps[1] === 'عطیہ درج ہو گیا: RCP-0001', ps[1]);
  ok('text typed by users that is not in the list is left alone', ps[3] === 'Some user typed note');
}


console.log('\n== XSS & offline ==');
{
  const mem = [{ id: 'm1', user_id: 'u1', roles: ['admin'], allowed_modules: null, status: 'active', committee: { id: 'cA', name: '<img src=x onerror=alert(1)>', city: 'K', state: 'S', country: 'India' } }];
  const mods = [{ id: 'a1', committee_id: 'cA', module_type: 'mosque', module_name: '<script>window.__pwn=1</script>', details: { locality: '"><b>x</b>' }, is_active: true }];
  const { w, d } = await boot({ signedIn: true, memberships: mem, modules: mods });
  w.location.hash = '#module/a1'; await tick();
  ok('hostile committee / module names are escaped, not executed', !d.querySelector('#app-root img') && !d.querySelector('#pf-main script') && !w.__pwn && !d.querySelector('#pf-main b'));
}
{
  const { w, d, be } = await boot({ signedIn: true });
  be.db.opts = null;
}
{
  const o = { signedIn: true, memberships: [], modules: [] };
  const { w, d, be } = await boot(o);
  // go offline then try to create
  const be2 = be; // flip flag by re-creating client behaviour
  setVal(w, d.querySelector('#pf-c-name'), 'Offline Trust'); setVal(w, d.querySelector('#pf-c-city'), 'X'); setVal(w, d.querySelector('#pf-c-state'), 'Assam');
  check(w, d.querySelectorAll('.pf-module-card input')[2]);
  d.querySelector('#pf-next').click(); await tick();
  setVal(w, d.querySelector('[data-key="module_name"]'), 'Dargah X'); setVal(w, d.querySelector('[data-key="locality"]'), 'Town');
  setVal(w, d.querySelector('[data-key="urs_calendar"]'), 'hijri'); setVal(w, d.querySelector('[data-key="urs_date"]'), '6 Rajab');
  check(w, d.querySelector('input[type=radio][data-key="langar_active"][value="yes"]')); check(w, d.querySelector('input[type=radio][data-key="lodging_available"][value="no"]'));
  // make the backend fail like a dropped connection
  w.supabase.createClient = null;
  const real = be.client.rpc; be.client.rpc = async () => { throw new TypeError('Failed to fetch'); };
  d.querySelector('#pf-next').click(); await tick(150);
  ok('network failure shows friendly "No internet" message, not a raw error', /No internet connection/.test(d.querySelector('#pf-wizard-error').textContent), d.querySelector('#pf-wizard-error')?.textContent);
  ok('wizard stays open so nothing typed is lost', !!d.querySelector('#pf-module-form') && d.querySelector('[data-key="module_name"]').value === 'Dargah X');
  ok('submit button re-enabled after failure', d.querySelector('#pf-next') && !d.querySelector('#pf-next').disabled);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
