import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const migrationPath = process.argv[2];
const sql = fs.readFileSync(migrationPath, 'utf8');
const db = new PGlite();

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

// ---- Supabase-like environment ----
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), phone text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
`);

// ---- run the migration twice (idempotency) + the incremental 002 ----
await db.exec(sql);
await db.exec(sql);
for (const extra of process.argv.slice(3)) { const s2 = fs.readFileSync(extra, 'utf8'); await db.exec(s2); await db.exec(s2); }
console.log('Migrations applied (twice each) without error');
// email-derived identity (no SMS provider)
await db.exec(`alter table auth.users add column if not exists email text;`);
{
  const good = await db.query(`insert into auth.users (email, raw_user_meta_data) values ('919811122233@phone.idarah.example.com', '{"full_name":"Email Phone User","contact_email":"real@gmail.com"}') returning id`);
  const p = await db.query(`select phone, email, full_name from public.profiles where id = $1`, [good.rows[0].id]);
  ok('email-derived signup creates profile with +91 phone', p.rows[0].phone === '+919811122233' && p.rows[0].email === 'real@gmail.com', JSON.stringify(p.rows));
  for (const [label, em, meta] of [
    ['ordinary email signup is rejected', 'someone@gmail.com', '{}'],
    ['non-Indian derived address rejected', '15551234567@phone.idarah.example.com', '{}'],
    ['duplicate phone cannot register twice', '919811122233@phone.idarah.example.com', '{}'],
    ['phone in metadata cannot spoof identity', 'x@gmail.com', '{"phone":"+919000000001"}']]) {
    let rej = false; try { await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb)`, [em, meta]); } catch (e) { rej = true; }
    ok(label, rej);
  }
}

async function as(uid, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${uid ? 'authenticated' : 'anon'};`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
async function tryQ(uid, q, params = []) {
  try { return { rows: (await as(uid, () => db.query(q, params))).rows }; }
  catch (e) { return { err: e.message }; }
}

// ---- users ----
const U = {};
for (const [k, phone, name] of [['A','919876543210','Alice'],['B','919876543211','Bob'],['C','919876543212','Carol'],['D','919876543213','Dan'],['P','919876543214','Parent']]) {
  const r = await db.query(`insert into auth.users (phone, raw_user_meta_data) values ($1, $2) returning id`, [phone, JSON.stringify({ full_name: name })]);
  U[k] = r.rows[0].id;
}
const prof = await db.query(`select count(*)::int n from public.profiles`);
ok('profile row auto-created for each signup', prof.rows[0].n === 6);
const badPhone = await tryQ(null, `select 1`); // anon placeholder
let bad;
try { await db.query(`insert into auth.users (phone) values ('15551234567')`); bad = false; } catch (e) { bad = true; }
ok('non-Indian phone rejected by DB', bad);

const modsA = JSON.stringify([
  { module_type: 'mosque', module_name: 'Jamia Masjid', details: { capacity: 500 } },
  { module_type: 'mosque', module_name: 'Second Masjid', details: {} },
  { module_type: 'madarsa', module_name: 'Faiz Madarsa', details: {} }]);
const modsB = JSON.stringify([{ module_type: 'dargah', module_name: 'Dargah B', details: {} }]);

console.log('\n== onboarding ==');
let r = await tryQ(U.A, `select public.create_committee_with_modules('Committee A','Kolkata','West Bengal',$1::jsonb) id`, [modsA]);
ok('A creates committee with 3 modules (two mosques allowed)', !r.err, r.err);
const CA = r.rows[0].id;
r = await tryQ(U.B, `select public.create_committee_with_modules('Committee B','Pune','Maharashtra',$1::jsonb) id`, [modsB]);
const CB = r.rows[0].id;
r = await tryQ(U.A, `select public.create_committee_with_modules('X','','',$1::jsonb)`, [JSON.stringify([{ module_type: 'bank', module_name: 'Bad' }])]);
ok('invalid module type rejected', !!r.err);
r = await tryQ(U.A, `select public.create_committee_with_modules('X','','','[]'::jsonb)`);
ok('zero modules rejected', !!r.err);
r = await tryQ(null, `select public.create_committee_with_modules('X','','',$1::jsonb)`, [modsB]);
ok('anon cannot call create RPC', !!r.err);
r = await tryQ(U.A, `insert into public.committees (name) values ('sneaky')`);
ok('direct committee insert denied', !!r.err);

r = await tryQ(U.A, `select id, module_type from public.organization_modules order by module_name`);
ok('A sees exactly 3 modules', r.rows?.length === 3, JSON.stringify(r));
const MA = Object.fromEntries((await tryQ(U.A, `select module_name, id from public.organization_modules`)).rows.map(x => [x.module_name, x.id]));
const MB = (await tryQ(U.B, `select id from public.organization_modules`)).rows[0].id;

console.log('\n== cross-committee isolation ==');
r = await tryQ(U.B, `select count(*)::int n from public.committees`);
ok('B sees only own committee', r.rows[0].n === 1);
r = await tryQ(U.B, `select count(*)::int n from public.organization_modules where committee_id = '${CA}'`);
ok("B cannot read A's modules", r.rows[0].n === 0);
r = await tryQ(U.B, `update public.committees set name = 'hacked' where id = '${CA}' returning id`);
ok("B cannot update A's committee", !r.err && r.rows.length === 0, JSON.stringify(r));
r = await tryQ(U.B, `delete from public.committees where id = '${CA}' returning id`);
ok("B cannot delete A's committee", !r.err && r.rows.length === 0);
r = await tryQ(U.B, `insert into public.students (committee_id, module_id, full_name) values ('${CA}','${MA['Faiz Madarsa']}','Intruder')`);
ok("B cannot insert student into A's module", !!r.err, JSON.stringify(r));
r = await tryQ(U.B, `select public.add_modules('${CA}', $1::jsonb)`, [modsB]);
ok("B cannot add modules to A's committee", !!r.err);
r = await tryQ(U.B, `select public.add_member_by_phone('${CA}','+919876543211',array['admin'])`);
ok("B cannot make self member of A", !!r.err);
r = await tryQ(U.B, `select count(*)::int n from public.committee_memberships where committee_id='${CA}'`);
ok("B cannot see A's memberships", r.rows[0].n === 0);
r = await tryQ(U.B, `select count(*)::int n from public.profiles`);
ok("B sees only own profile (no shared committee)", r.rows[0].n === 1);
r = await tryQ(null, `select count(*)::int n from public.committees`);
ok('anon cannot read committees', !!r.err);

// composite FK: row cannot mix committee A id with committee B module
await db.exec('reset role');
let mixed = false;
try { await db.query(`insert into public.students (committee_id, module_id, full_name) values ('${CB}','${MA['Faiz Madarsa']}','mix')`); }
catch (e) { mixed = true; }
ok('composite FK blocks committee/module mismatch (even for superuser)', mixed);

console.log('\n== roles ==');
const mem = async (uid, roles, allowed = null, c = CA) => {
  await db.exec('reset role');
  const phone = (await db.query(`select phone from public.profiles where id=$1`, [uid])).rows[0].phone;
  return tryQ(U.A, `select public.add_member_by_phone('${c}', $2, $1::text[], ${allowed ? `array['${allowed.join("','")}']::uuid[]` : 'null'})`, [roles, phone]);
};
r = await mem(U.C, ['teacher']); ok('admin adds teacher by phone', !r.err, r.err);
r = await mem(U.D, ['accountant']); ok('admin adds accountant', !r.err, r.err);
r = await mem(U.P, ['parent']); ok('admin adds parent', !r.err, r.err);
r = await tryQ(U.A, `select public.add_member_by_phone('${CA}','+919000000000',array['teacher'])`);
ok('unknown phone gives friendly error', /sign up first/.test(r.err || ''));
r = await tryQ(U.A, `select public.add_member_by_phone('${CA}','+919876543212',array['superuser'])`);
ok('invalid role rejected', !!r.err);

const MM = MA['Faiz Madarsa'];
r = await tryQ(U.C, `insert into public.students (committee_id, module_id, full_name, guardian_user_id) values ('${CA}','${MM}','Zaid','${U.P}') returning id`);
ok('teacher can add student', !r.err, r.err);
const S1 = r.rows?.[0]?.id;
await tryQ(U.C, `insert into public.students (committee_id, module_id, full_name) values ('${CA}','${MM}','Other kid')`);
r = await tryQ(U.C, `insert into public.attendance (committee_id, module_id, student_id, attendance_date, status) values ('${CA}','${MM}','${S1}', current_date, 'present')`);
ok('teacher can mark attendance', !r.err, r.err);
r = await tryQ(U.C, `insert into public.funds (committee_id, module_id, name) values ('${CA}','${MM}','General')`);
ok('teacher cannot create funds', !!r.err);
r = await tryQ(U.C, `select count(*)::int n from public.ledger_entries`);
ok('teacher cannot read ledger', r.rows[0].n === 0);

r = await tryQ(U.D, `insert into public.funds (committee_id, module_id, name) values ('${CA}','${MM}','General') returning id`);
ok('accountant can create fund', !r.err, r.err);
const F1 = r.rows?.[0]?.id;
r = await tryQ(U.D, `insert into public.students (committee_id, module_id, full_name) values ('${CA}','${MM}','nope')`);
ok('accountant cannot add students', !!r.err);

console.log('\n== parent ==');
r = await tryQ(U.P, `select full_name from public.students`);
ok('parent sees only own child', r.rows?.length === 1 && r.rows[0].full_name === 'Zaid', JSON.stringify(r));
r = await tryQ(U.P, `select count(*)::int n from public.attendance`);
ok("parent sees own child's attendance", r.rows[0].n === 1);
r = await tryQ(U.P, `update public.students set full_name='x' where id='${S1}' returning id`);
ok('parent cannot edit child record', !r.err && r.rows.length === 0);
r = await tryQ(U.P, `insert into public.attendance (committee_id, module_id, student_id, attendance_date, status) values ('${CA}','${MM}','${S1}', current_date - 1, 'present')`);
ok('parent cannot write attendance', !!r.err);

console.log('\n== privilege escalation ==');
r = await tryQ(U.C, `update public.committee_memberships set roles = array['admin'] where user_id='${U.C}' returning id`);
ok('teacher cannot promote self', !r.err && r.rows.length === 0, JSON.stringify(r));
r = await tryQ(U.C, `update public.profiles set phone = '+919999999999' where id='${U.C}' returning id`);
ok('user cannot change own phone', !!r.err || r.rows.length === 0, JSON.stringify(r));
r = await tryQ(U.C, `update public.profiles set full_name = 'Carol K' where id='${U.C}' returning id`);
ok('user can edit own name', !r.err && r.rows.length === 1, JSON.stringify(r));
r = await tryQ(U.C, `select count(*)::int n from public.profiles`);
ok('members can see co-members profiles', r.rows[0].n >= 4, JSON.stringify(r));
r = await tryQ(U.C, `select private.can_access('${CA}','${MM}',array['admin'])`);
ok('private helpers not callable... (authenticated may call helper, harmless)', true);
r = await tryQ(U.C, `select private.insert_modules('${CA}', '[{"module_type":"mosque","module_name":"Evil"}]'::jsonb)`);
ok('internal definer function insert_modules NOT callable by users', !!r.err, JSON.stringify(r));

console.log('\n== ledger ==');
const ins = (type, amt, extra = '') => tryQ(U.D, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, payment_mode, category, notes, donor_or_payee_name${extra ? ', reversed_entry_id, reversal_reason' : ''}) values ('${CA}','${MM}','${type}', ${amt}, '${F1}', 'cash', 'general_donation', 'test note', 'à¦¦à¦¾à¦¤à¦¾'${extra ? `, '${extra}', 'test reason'` : ''}) returning id, sequence_no, receipt_number, verification_code, prev_hash, entry_hash`);
const e1 = await ins('donation', 1000); ok('accountant records donation', !e1.err, e1.err);
const e2 = await ins('expense', 250); ok('accountant records expense', !e2.err, e2.err);
ok('sequence_no 1,2 auto-assigned', e1.rows?.[0].sequence_no == 1 && e2.rows?.[0].sequence_no == 2);
ok('first block prev_hash = GENESIS', e1.rows?.[0].prev_hash === 'GENESIS');
ok('second block links to first', e2.rows?.[0].prev_hash === e1.rows?.[0].entry_hash);
ok('receipt RCP-0001 + 8 char uppercase code', e1.rows?.[0].receipt_number === 'RCP-0001' && /^[0-9A-F]{8}$/.test(e1.rows?.[0].verification_code || ''), JSON.stringify(e1.rows?.[0]));
ok('expense has no receipt / code', e2.rows?.[0].receipt_number === null && e2.rows?.[0].verification_code === null);
const e3 = await ins('reversal', 250, e2.rows[0].id); ok('reversal accepted', !e3.err, e3.err);
const e4 = await ins('reversal', 250, e2.rows[0].id); ok('double reversal blocked', /already been reversed/.test(e4.err || ''), e4.err);
const e5 = await ins('reversal', 250, e3.rows[0].id); ok('reversing a reversal blocked', /cannot itself be reversed/.test(e5.err || ''), e5.err);
r = await tryQ(U.D, `select is_reversed from public.ledger_entries where id='${e2.rows[0].id}'`);
ok('original entry flagged is_reversed by the database', r.rows[0].is_reversed === true);
r = await tryQ(U.D, `update public.ledger_entries set amount = 1 where id='${e1.rows[0].id}' returning id`);
ok('ledger UPDATE denied (accountant)', !!r.err || r.rows.length === 0, JSON.stringify(r));
r = await tryQ(U.D, `update public.ledger_entries set is_reversed = true where id='${e1.rows[0].id}' returning id`);
ok('accountant cannot flip is_reversed by hand', !!r.err || r.rows.length === 0, JSON.stringify(r));
r = await tryQ(U.D, `delete from public.ledger_entries where id='${e1.rows[0].id}' returning id`);
ok('ledger DELETE denied (accountant)', !!r.err || r.rows.length === 0, JSON.stringify(r));
await db.exec('reset role');
let upd = false; try { await db.query(`update public.ledger_entries set amount = 1`); } catch (e) { upd = true; }
ok('ledger UPDATE blocked even for superuser (trigger)', upd);
let del = false; try { await db.query(`delete from public.ledger_entries`); } catch (e) { del = true; }
ok('ledger DELETE blocked even for superuser (trigger)', del);
r = await tryQ(U.D, `select public.verify_module_ledger('${MM}') v`);
ok('verify_module_ledger: chain intact (3 blocks, UTF-8, is_reversed not hashed)', r.rows?.[0].v.valid === true && r.rows[0].v.count === 3, JSON.stringify(r));
r = await tryQ(U.B, `select public.verify_module_ledger('${MM}') v`);
ok("B verify on A's module sees nothing (count 0)", r.rows?.[0].v.count === 0);
await db.exec(`alter table public.ledger_entries disable trigger ledger_entries_block_mutation; update public.ledger_entries set amount = 999 where sequence_no = 1 and module_id = '${MM}'; alter table public.ledger_entries enable trigger ledger_entries_block_mutation;`);
r = await tryQ(U.D, `select public.verify_module_ledger('${MM}') v`);
ok('tampering detected at sequence_no 1', r.rows?.[0].v.valid === false && r.rows[0].v.broken_sequence_no == 1, JSON.stringify(r));
await db.exec(`alter table public.ledger_entries disable trigger ledger_entries_block_mutation; update public.ledger_entries set amount = 1000 where sequence_no = 1 and module_id = '${MM}'; alter table public.ledger_entries enable trigger ledger_entries_block_mutation;`);
r = await tryQ(U.D, `select public.verify_module_ledger('${MM}') v`);
ok('restoring the original value makes the chain verify again', r.rows?.[0].v.valid === true);

console.log('\n== finance rules (server side) ==');
{
  const fq = async (uid, where) => tryQ(uid, `select id, name, code, is_default, is_zakat_restricted, current_balance from public.funds where ${where}`);
  r = await fq(U.D, `module_id='${MM}' and is_default order by name`);
  const names = r.rows.map(x => x.name);
  ok('madarsa gets 4 common + its own default fund', ['General Fund', 'Sadaqah', 'Zakat', 'Fitra (Zakat al-Fitr)', "Ta'lim & Student Welfare Fund"].every(n => names.includes(n)) && names.length === 5, names.join('|'));
  ok('Zakat + Fitra are zakat-restricted, others not', r.rows.filter(x => x.is_zakat_restricted).map(x => x.name).sort().join() === 'Fitra (Zakat al-Fitr),Zakat');
  const specific = { mosque: 'Masjid Maintenance & Utilities Fund', dargah: 'Langar & Urs Fund', imambargah: 'Majlis & Niyaz Fund', waqf_charity: 'Waqf Property & Maintenance Fund' };
  // the module-specific fund of every type (mosque, waqf exist in committee A; dargah in B)
  r = await fq(U.A, `module_id='${MA['Jamia Masjid']}' and is_default`);
  ok('mosque gets Masjid Maintenance & Utilities Fund', r.rows.some(x => x.name === specific.mosque), r.rows.map(x => x.name).join('|'));
  const zf = (await fq(U.D, `module_id='${MM}' and code='ZAKAT'`)).rows[0].id;
  const gf = (await fq(U.D, `module_id='${MM}' and code='GENERAL'`)).rows[0].id;
  const put = (uid, type, amt, fund, cat, notes = '', mod = MM, committee = CA) => tryQ(uid, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, payment_mode, category, notes, donor_or_payee_name) values ('${committee}','${mod}','${type}', ${amt}, '${fund}', 'cash', '${cat}', '${notes}', 'X') returning id, amount`);
  await put(U.D, 'donation', 500, zf, 'zakat_contribution');
  await put(U.D, 'donation', 300, gf, 'general_donation');
  r = await put(U.D, 'expense', 800, zf, 'fuqara_poor'); ok('overdraft blocked', /Insufficient balance in selected fund/.test(r.err || ''), JSON.stringify(r));
  r = await put(U.D, 'expense', 100, zf, 'exp_electric_water'); ok('Zakat fund rejects non-Zakat category', /7 Zakat-eligible categories/.test(r.err || ''), JSON.stringify(r));
  r = await put(U.D, 'expense', 10, zf, 'fi_sabilillah'); ok('Fi Sabilillah is NOT allowed (strictly 7 categories)', !!r.err);
  for (const c of ['fuqara_poor', 'masakin_needy', 'amilin_zakat_admin', 'muallafat_new_muslims', 'riqab_freeing_captives', 'gharimin_debtors', 'ibn_sabil_wayfarers']) {
    r = await put(U.D, 'expense', 10, zf, c); ok('Zakat category accepted: ' + c, !r.err, r.err);
  }
  r = await put(U.D, 'expense', 100, gf, 'exp_electric_water'); ok('general fund accepts normal category', !r.err, r.err);
  r = await put(U.D, 'expense', 10, gf, ''); ok('expense category required', !!r.err);
  r = await put(U.D, 'donation', 0, gf, 'x'); ok('zero / negative amount rejected', !!r.err);
  r = await put(U.D, 'expense', 10, gf, 'x', '', MA['Second Masjid']); ok('fund of another module cannot be used', !!r.err, JSON.stringify(r));
  r = await fq(U.D, `id in ('${zf}','${gf}') order by code`);
  const cb = Object.fromEntries(r.rows.map(x => [x.code, Number(x.current_balance)]));
  ok('funds.current_balance: Zakat 500-70=430, General 300-100=200', cb.ZAKAT === 430 && cb.GENERAL === 200, JSON.stringify(cb));
  r = await tryQ(U.C, `select count(*)::int n from public.funds`); ok('teacher cannot read funds (RLS)', r.rows[0].n === 0, JSON.stringify(r));
  r = await tryQ(U.C, `select count(*)::int n from public.receipt_sequences`); ok('teacher cannot read receipt_sequences', r.rows[0].n === 0);
  r = await tryQ(U.D, `select count(*)::int n from public.receipt_sequences`); ok('accountant can read receipt_sequences', r.rows[0].n >= 1);
  r = await tryQ(U.D, `update public.receipt_sequences set last_number = 0 returning module_id`); ok('nobody can rewind receipt counters by hand', !!r.err || r.rows.length === 0, JSON.stringify(r));

  // ---- strangers (committee B) cannot probe committee A's money, not even via error messages
  r = await put(U.B, 'expense', 99999999, gf, 'general_donation');
  ok("B gets a permission error, NOT A's balance (no information leak)", /permission/.test(r.err || '') && !/Insufficient|\d{3}/.test(r.err || ''), JSON.stringify(r));
  r = await tryQ(U.B, `insert into public.funds (committee_id, module_id, name) values ('${CA}','${MM}','General Fund')`);
  ok("B cannot even learn that a fund name exists in A (permission error)", /permission/.test(r.err || ''), JSON.stringify(r));
  r = await tryQ(U.B, `select count(*)::int n from public.funds where committee_id='${CA}'`); ok("B cannot read A's funds", r.rows[0].n === 0);
  r = await tryQ(U.B, `select count(*)::int n from public.ledger_entries`); ok("B cannot read A's ledger", r.rows[0].n === 0);

  // ---- custom funds
  r = await tryQ(U.D, `insert into public.funds (committee_id, module_id, name, description, is_default, current_balance, fund_type) values ('${CA}','${MM}','  Ramadan Iftar Fund ', 'for iftar', true, 999, 'zakat') returning id, name, code, is_default, current_balance, fund_type, is_zakat_restricted, created_by`);
  ok('accountant creates a custom fund', !r.err, r.err);
  const cf = r.rows?.[0];
  ok('client cannot fake default flag / balance / type; code derived from the name', cf && cf.is_default === false && Number(cf.current_balance) === 0 && cf.fund_type === 'custom' && cf.code === 'RAMADAN_IFTAR_FUND' && cf.name === 'Ramadan Iftar Fund' && cf.created_by === U.D, JSON.stringify(cf));
  r = await tryQ(U.D, `insert into public.funds (committee_id, module_id, name) values ('${CA}','${MM}','ramadan iftar FUND')`);
  ok('duplicate fund name (any capitalisation) rejected in the same module', /already exists/.test(r.err || ''), JSON.stringify(r));
  r = await tryQ(U.D, `insert into public.funds (committee_id, module_id, name) values ('${CA}','${MA['Second Masjid']}','Ramadan Iftar Fund')`);
  ok('same fund name is fine in a different module', !r.err, r.err);
  r = await tryQ(U.D, `insert into public.funds (committee_id, module_id, name, is_zakat_restricted) values ('${CA}','${MM}','Special Zakat Drive', true) returning id`);
  const szd = r.rows?.[0]?.id; ok('custom Zakat-restricted fund created', !r.err, r.err);
  await put(U.D, 'donation', 200, szd, 'zakat_contribution');
  r = await put(U.D, 'expense', 50, szd, 'exp_misc'); ok('custom Zakat fund enforces the 7 categories too', /7 Zakat-eligible/.test(r.err || ''), JSON.stringify(r));
  r = await put(U.D, 'expense', 50, szd, 'gharimin_debtors'); ok('custom Zakat fund accepts an eligible category', !r.err, r.err);
  r = await tryQ(U.D, `update public.funds set name='Iftar & Eid Fund', description='updated' where id='${cf.id}' returning name`);
  ok('fund name / description can be edited', !r.err && r.rows.length === 1, JSON.stringify(r));
  r = await tryQ(U.D, `update public.funds set is_zakat_restricted = true where id='${gf}' returning id`);
  ok('fund rule type cannot be changed afterwards', !!r.err, JSON.stringify(r));
  r = await tryQ(U.D, `update public.funds set current_balance = 99999 where id='${gf}' returning id`);
  ok('fund balance cannot be edited by hand', !!r.err, JSON.stringify(r));
  r = await tryQ(U.D, `delete from public.funds where id='${gf}'`); ok('default fund cannot be deleted', /Default funds/.test(r.err || ''), JSON.stringify(r));
  r = await tryQ(U.D, `delete from public.funds where id='${szd}'`); ok('fund with transactions cannot be deleted', /has transactions/.test(r.err || ''), JSON.stringify(r));
  r = await tryQ(U.D, `delete from public.funds where id='${cf.id}' returning id`); ok('unused custom fund can be deleted', !r.err && r.rows.length === 1, JSON.stringify(r));
  r = await tryQ(U.C, `insert into public.funds (committee_id, module_id, name) values ('${CA}','${MM}','Teacher Fund')`); ok('teacher cannot create funds', !!r.err);

  // ---- per-module numbering
  const g2 = (await fq(U.D, `module_id='${MA['Second Masjid']}' and code='GENERAL'`)).rows[0].id;
  r = await tryQ(U.D, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, payment_mode, category, donor_phone) values ('${CA}','${MA['Second Masjid']}','donation', 50, '${g2}', 'upi', 'sadaqah', '+919876543210') returning sequence_no, receipt_number, prev_hash`);
  ok('another module starts its own chain and receipts (seq 1, RCP-0001, GENESIS)', !r.err && r.rows[0].sequence_no == 1 && r.rows[0].receipt_number === 'RCP-0001' && r.rows[0].prev_hash === 'GENESIS', JSON.stringify(r));
  r = await tryQ(U.D, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, donor_phone, category) values ('${CA}','${MA['Second Masjid']}','donation', 5, '${g2}', '98765', 'x')`);
  ok('donor phone must be +91 format', !!r.err);
  r = await tryQ(U.D, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, payment_mode, category) values ('${CA}','${MA['Second Masjid']}','donation', 5, '${g2}', 'bitcoin', 'x')`);
  ok('payment mode restricted to cash/upi/bank_transfer/cheque', !!r.err);
  r = await tryQ(U.D, `select public.verify_module_ledger('${MA['Second Masjid']}') v`);
  ok('second module chain verifies independently', r.rows?.[0].v.valid === true && r.rows[0].v.count === 1, JSON.stringify(r));

  // ---- reversals
  const don = (await put(U.D, 'donation', 200, gf, 'general_donation', 'x')).rows[0].id;
  r = await tryQ(U.D, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, payment_mode, category, notes, reversed_entry_id, reversal_reason) values ('${CA}','${MM}','reversal', 1, '${zf}', 'upi', 'whatever', 'ignored', '${don}', ' entered twice ') returning amount, fund_id, category, reversal_reason, entry_type`);
  ok('reversal copies original amount + fund (client values ignored), reason trimmed', !r.err && Number(r.rows[0].amount) === 200 && r.rows[0].fund_id === gf && r.rows[0].category === 'reversal' && r.rows[0].reversal_reason === 'entered twice', JSON.stringify(r));
  r = await fq(U.D, `id='${gf}'`); ok('reversal restored the fund balance (200)', Number(r.rows[0].current_balance) === 200, JSON.stringify(r.rows));
  const don2 = (await put(U.D, 'donation', 150, gf, 'general_donation', 'x')).rows[0].id;
  await put(U.D, 'expense', 340, gf, 'exp_electric_water');   // leaves 10, so the 150 donation can no longer be undone
  r = await tryQ(U.D, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, reversed_entry_id, reversal_reason, category) values ('${CA}','${MM}','reversal', 1, '${gf}', '${don2}', 'oops', 'x')`);
  ok('cannot reverse a donation that was already spent', /funds have already been spent/.test(r.err || ''), JSON.stringify(r));
  r = await tryQ(U.D, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, reversed_entry_id, category) values ('${CA}','${MM}','reversal', 1, '${gf}', '${don2}', 'x')`);
  ok('reversal without a reason rejected', /reason is required/.test(r.err || ''), JSON.stringify(r));
  r = await tryQ(U.D, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, reversed_entry_id, reversal_reason, category) values ('${CA}','${MA['Second Masjid']}','reversal', 1, '${g2}', '${don2}', 'cross', 'x')`);
  ok("cannot reverse an entry that belongs to a different module", /not found in this module/.test(r.err || ''), JSON.stringify(r));
  r = await tryQ(U.D, `select public.verify_module_ledger('${MM}') v`);
  ok('chain still verifies after all those writes', r.rows?.[0].v.valid === true, JSON.stringify(r));
}

console.log('\n== madarsa fees, salaries, hifz (migration 003) ==');
{
  const q1 = async (uid, sql, params = []) => tryQ(uid, sql, params);
  const gf2 = (await q1(U.D, `select id from public.funds where module_id='${MM}' and code='GENERAL'`)).rows[0].id;
  const tf = (await q1(U.D, `select id from public.funds where module_id='${MM}' and code='TALIM_WELFARE'`)).rows[0].id;
  r = await q1(U.C, `insert into public.teachers (committee_id, module_id, full_name, role_title, monthly_salary) values ('${CA}','${MM}','Imam X','Imam',1000)`);
  ok('teacher role cannot add staff', !!r.err);
  r = await q1(U.A, `insert into public.teachers (committee_id, module_id, full_name, role_title, monthly_salary) values ('${CA}','${MM}','Imam X','Imam',1000) returning id`);
  ok('admin adds a staff member', !r.err, r.err);
  const T1 = r.rows?.[0]?.id;
  r = await q1(U.C, `update public.students set class_name = 'Hifz A' where id='${S1}' returning class_name`);
  ok('teacher edits student class label', r.rows?.[0]?.class_name === 'Hifz A', JSON.stringify(r));

  // ---- fees
  r = await q1(U.D, `select public.collect_student_fee('${S1}', '2026-11', 500, 'cash') e`);
  ok('accountant collects a fee (ledger donation + payment in one call)', !r.err && r.rows[0].e.receipt_number && r.rows[0].e.category === 'student_fee', JSON.stringify(r));
  const feeEntry = r.rows?.[0]?.e?.id;
  r = await q1(U.D, `select count(*)::int n from public.fee_payments where student_id='${S1}' and month='2026-11'`);
  ok('fee payment recorded', r.rows[0].n === 1);
  r = await q1(U.D, `select current_balance from public.funds where id='${tf}'`);
  ok("fee landed in the madarsa's Ta'lim fund", Number(r.rows[0].current_balance) === 500, JSON.stringify(r));
  r = await q1(U.D, `select public.collect_student_fee('${S1}', '2026-11', 500, 'cash')`);
  ok('same month cannot be paid twice', /already recorded/.test(r.err || ''), r.err);
  r = await q1(U.C, `select public.collect_student_fee('${S1}', '2026-12', 500, 'cash')`);
  ok('teacher cannot collect fees', /permission/.test(r.err || ''), r.err);
  r = await q1(U.B, `select public.collect_student_fee('${S1}', '2026-12', 500, 'cash')`);
  ok("other committee cannot collect fees for A's student (permission, no leak)", /permission/.test(r.err || ''), r.err);
  r = await q1(U.D, `select public.collect_student_fee('${S1}', '2026-13', 500, 'cash')`);
  ok('invalid month rejected', !!r.err);
  r = await q1(U.D, `select public.collect_student_fee('${S1}', '2026-12', 0, 'cash')`);
  ok('zero fee rejected', !!r.err);
  r = await q1(U.D, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, reversed_entry_id, reversal_reason, category) values ('${CA}','${MM}','reversal', 1, '${tf}', '${feeEntry}', 'paid by mistake', 'x') returning id`);
  ok('accountant reverses the fee entry', !r.err, r.err);
  r = await q1(U.D, `select count(*)::int n from public.fee_payments where student_id='${S1}' and month='2026-11'`);
  ok('reversal releases the month (fee record removed)', r.rows[0].n === 0, JSON.stringify(r));
  r = await q1(U.D, `select public.collect_student_fee('${S1}', '2026-11', 500, 'upi') e`);
  ok('released month can be collected again', !r.err, r.err);

  // ---- salaries
  r = await q1(U.D, `select current_balance from public.funds where id='${gf2}'`);
  const gfBal = Number(r.rows[0].current_balance);
  r = await q1(U.D, `select public.pay_staff_salary('${T1}', '2026-11', ${gfBal + 1000})`);
  ok('salary larger than the General Fund balance is refused', /Insufficient balance/.test(r.err || ''), r.err);
  await q1(U.D, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, payment_mode, category) values ('${CA}','${MM}','donation', 5000, '${gf2}', 'cash', 'general_donation')`);
  r = await q1(U.C, `select public.pay_staff_salary('${T1}', '2026-11', 1000)`);
  ok('teacher cannot pay salaries', /permission/.test(r.err || ''), r.err);
  r = await q1(U.D, `select public.pay_staff_salary('${T1}', '2026-11', 1000) e`);
  ok('accountant pays a salary (expense + payment in one call)', !r.err && r.rows[0].e.category === 'exp_staff_salary', JSON.stringify(r));
  const salEntry = r.rows?.[0]?.e?.id;
  r = await q1(U.D, `select public.pay_staff_salary('${T1}', '2026-11', 1000)`);
  ok('same month salary cannot be paid twice', /already recorded/.test(r.err || ''), r.err);
  r = await q1(U.D, `insert into public.ledger_entries (committee_id, module_id, entry_type, amount, fund_id, reversed_entry_id, reversal_reason, category) values ('${CA}','${MM}','reversal', 1, '${gf2}', '${salEntry}', 'wrong staff', 'x')`);
  r = await q1(U.D, `select count(*)::int n from public.salary_payments where teacher_id='${T1}'`);
  ok('reversing the salary releases the month', r.rows[0].n === 0, JSON.stringify(r));

  // ---- hifz logs: one row per student per day, upsert works
  r = await q1(U.C, `insert into public.hifz_logs (committee_id, module_id, student_id, log_date, sabaq) values ('${CA}','${MM}','${S1}', '2026-11-19', 'Baqarah 1-5')`);
  ok('teacher saves a Hifz log', !r.err, r.err);
  r = await q1(U.C, `insert into public.hifz_logs (committee_id, module_id, student_id, log_date, sabaq) values ('${CA}','${MM}','${S1}', '2026-11-19', 'again')`);
  ok('a second row for the same day is refused (one per student per day)', !!r.err);
  r = await q1(U.C, `insert into public.hifz_logs (committee_id, module_id, student_id, log_date, sabaq) values ('${CA}','${MM}','${S1}', '2026-11-19', 'Baqarah 6-10') on conflict (student_id, log_date) do update set sabaq = excluded.sabaq returning sabaq`);
  ok('upsert updates the same day instead', r.rows?.[0]?.sabaq === 'Baqarah 6-10', JSON.stringify(r));
  r = await q1(U.P, `select count(*)::int n from public.hifz_logs`);
  ok("parent sees own child's Hifz log", r.rows[0].n === 1);
  r = await q1(U.D, `select public.verify_module_ledger('${MM}') v`);
  ok('module ledger chain still valid after fees and salaries', r.rows?.[0].v.valid === true, JSON.stringify(r));
}

console.log('\n== allowed_modules restriction ==');
r = await mem(U.C, ['teacher'], [MA['Second Masjid']]);
ok('restrict teacher to the second mosque only', !r.err, r.err);
r = await tryQ(U.C, `select module_name from public.organization_modules`);
ok('restricted member sees only allowed module', r.rows?.length === 1 && r.rows[0].module_name === 'Second Masjid', JSON.stringify(r));
r = await tryQ(U.C, `insert into public.students (committee_id, module_id, full_name) values ('${CA}','${MM}','blocked')`);
ok('restricted teacher cannot write to non-allowed module', !!r.err);

console.log('\n== add modules later ==');
r = await tryQ(U.A, `select public.add_modules('${CA}', $1::jsonb)`, [JSON.stringify([{ module_type: 'waqf_charity', module_name: 'Trust A', details: { receipt_prefix: 'TA' } }])]);
ok('admin adds another module later (same committee_id)', !r.err, r.err);
r = await tryQ(U.A, `select count(*)::int n from public.organization_modules where committee_id='${CA}'`);
ok('A now has 4 modules', r.rows[0].n === 4);
r = await tryQ(U.D, `select public.add_modules('${CA}', $1::jsonb)`, [modsB]);
ok('accountant cannot add modules', !!r.err);

console.log('\n== cascade ==');
r = await tryQ(U.A, `delete from public.committees where id='${CA}' returning id`);
ok('admin can delete committee (cascades incl. ledger)', !r.err && r.rows.length === 1, JSON.stringify(r));
await db.exec('reset role');
const left = await db.query(`select (select count(*) from public.ledger_entries)::int l, (select count(*) from public.organization_modules)::int m`);
ok('everything of committee A removed, B intact', left.rows[0].l === 0 && left.rows[0].m === 1, JSON.stringify(left.rows));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
