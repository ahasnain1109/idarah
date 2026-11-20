-- ============================================================================
-- Idarah platform: Madarsa + Mosque operations support
-- 003_madarsa_mosque_ops.sql   (run AFTER 001 and 002; re-runnable)
--
--   * students.class_name (simple class label, as in the old app)
--   * one Hifz/Sabaq log row per student per day (enables save-by-date upserts)
--   * collect_student_fee()  - atomically: ledger donation + fee payment record
--   * pay_staff_salary()     - atomically: ledger expense + salary payment record
--   * reversing a fee/salary ledger entry automatically releases that month so it
--     can be collected / paid again
-- Money rules (balances, Zakat, append-only, hash chain) still come from 002.
-- ============================================================================

begin;

alter table public.students add column if not exists class_name text;
create unique index if not exists hifz_logs_student_date_idx on public.hifz_logs (student_id, log_date);

-- ----------------------------------------------------------------------------
-- Madarsa fee: ledger donation + fee_payments row in ONE transaction
-- ----------------------------------------------------------------------------
create or replace function public.collect_student_fee(
  p_student_id uuid, p_month text, p_amount numeric, p_payment_mode text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  s public.students;
  f public.funds;
  e public.ledger_entries;
  v_phone text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into s from public.students where id = p_student_id;
  if not found then
    raise exception 'Student not found';
  end if;
  if not private.can_access(s.committee_id, s.module_id, array['accountant']::text[]) then
    raise exception 'You do not have permission to collect fees here' using errcode = '42501';
  end if;
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Choose a valid month';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount greater than zero';
  end if;
  if exists (select 1 from public.fee_payments fp where fp.student_id = s.id and fp.month = p_month) then
    raise exception 'The fee for % is already recorded for %', p_month, s.full_name;
  end if;

  select * into f from public.funds where module_id = s.module_id and code = 'TALIM_WELFARE';
  if not found then
    select * into f from public.funds where module_id = s.module_id and code = 'GENERAL';
  end if;
  if not found then
    raise exception 'No fund available for fees in this module';
  end if;

  v_phone := case when s.guardian_phone ~ '^[6-9][0-9]{9}$' then '+91' || s.guardian_phone
                  when s.guardian_phone ~ '^\+91[6-9][0-9]{9}$' then s.guardian_phone
                  else null end;

  insert into public.ledger_entries
    (committee_id, module_id, fund_id, entry_type, amount, category, donor_or_payee_name, donor_phone, payment_mode, notes)
  values
    (s.committee_id, s.module_id, f.id, 'donation', p_amount, 'student_fee',
     'Guardian of ' || s.full_name, v_phone, p_payment_mode,
     'Madarsa fee for ' || s.full_name || ' (' || p_month || ')')
  returning * into e;

  insert into public.fee_payments (committee_id, module_id, student_id, month, amount, ledger_entry_id)
  values (s.committee_id, s.module_id, s.id, p_month, p_amount, e.id);

  return jsonb_build_object(
    'id', e.id, 'sequence_no', e.sequence_no, 'created_at', e.created_at, 'entry_type', e.entry_type,
    'amount', e.amount, 'fund_id', e.fund_id, 'payment_mode', e.payment_mode, 'category', e.category,
    'notes', e.notes, 'donor_or_payee_name', e.donor_or_payee_name, 'donor_phone', e.donor_phone,
    'receipt_number', e.receipt_number, 'verification_code', e.verification_code, 'entry_hash', e.entry_hash,
    'is_reversed', e.is_reversed, 'reversed_entry_id', e.reversed_entry_id, 'reversal_reason', e.reversal_reason);
end $$;

-- ----------------------------------------------------------------------------
-- Staff salary: ledger expense (General Fund) + salary_payments row in ONE transaction
-- ----------------------------------------------------------------------------
create or replace function public.pay_staff_salary(
  p_teacher_id uuid, p_month text, p_amount numeric
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  t public.teachers;
  f public.funds;
  e public.ledger_entries;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into t from public.teachers where id = p_teacher_id;
  if not found then
    raise exception 'Staff member not found';
  end if;
  if not private.can_access(t.committee_id, t.module_id, array['accountant']::text[]) then
    raise exception 'You do not have permission to pay salaries here' using errcode = '42501';
  end if;
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Choose a valid month';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount greater than zero';
  end if;
  if exists (select 1 from public.salary_payments sp where sp.teacher_id = t.id and sp.month = p_month) then
    raise exception 'The salary for % is already recorded for %', p_month, t.full_name;
  end if;

  select * into f from public.funds where module_id = t.module_id and code = 'GENERAL';
  if not found then
    raise exception 'General Fund not found for this module';
  end if;

  -- the ledger trigger enforces the balance ("Insufficient balance in selected fund")
  insert into public.ledger_entries
    (committee_id, module_id, fund_id, entry_type, amount, category, donor_or_payee_name, payment_mode, notes)
  values
    (t.committee_id, t.module_id, f.id, 'expense', p_amount, 'exp_staff_salary',
     t.full_name, 'cash', 'Salary for ' || t.full_name || ' (' || coalesce(t.role_title, 'staff') || ') - ' || p_month)
  returning * into e;

  insert into public.salary_payments (committee_id, module_id, teacher_id, month, amount, ledger_entry_id)
  values (t.committee_id, t.module_id, t.id, p_month, p_amount, e.id);

  return jsonb_build_object(
    'id', e.id, 'sequence_no', e.sequence_no, 'created_at', e.created_at, 'entry_type', e.entry_type,
    'amount', e.amount, 'category', e.category, 'entry_hash', e.entry_hash);
end $$;

-- ----------------------------------------------------------------------------
-- Reversing a fee / salary entry releases that month again
-- ----------------------------------------------------------------------------
create or replace function private.release_payments_on_reversal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.fee_payments where ledger_entry_id = new.reversed_entry_id;
  delete from public.salary_payments where ledger_entry_id = new.reversed_entry_id;
  return new;
end $$;

drop trigger if exists ledger_entries_release_payments on public.ledger_entries;
create trigger ledger_entries_release_payments after insert on public.ledger_entries
  for each row when (new.entry_type = 'reversal')
  execute function private.release_payments_on_reversal();

-- ----------------------------------------------------------------------------
-- Function privileges
-- ----------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'release_payments_on_reversal'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('collect_student_fee', 'pay_staff_salary')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

commit;
