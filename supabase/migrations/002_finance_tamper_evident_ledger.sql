-- ============================================================================
-- Idarah platform: Finance - funds + tamper-evident, append-only ledger
-- 002_finance_tamper_evident_ledger.sql   (run AFTER 001; re-runnable)
--
-- !! If an earlier draft of the finance tables exists (column ledger_entries.type),
-- !! this file DROPS and RECREATES funds, ledger_entries, fee_payments and
-- !! salary_payments. That is intended pre-launch: the hash formula changed, so old
-- !! blocks cannot be carried over. Once the NEW layout exists this file never
-- !! drops anything again, so re-running it is safe.
--
-- Rules enforced INSIDE the database (cannot be bypassed from the browser):
--   * only admin / mutawalli_trustee / accountant can read or write finance tables
--   * per-module SHA-256 hash chain, sequence numbers and receipt numbers
--   * no overspending; Zakat-restricted funds accept only the 7 Zakat categories
--   * reversals mirror their original (fund + amount), need a reason, cannot be
--     repeated, cannot reverse a reversal, cannot undo a donation already spent
--   * ledger rows can never be edited or deleted (is_reversed is flipped by the
--     database itself, and is deliberately NOT part of the hash)
-- Hash input (superset of the minimum): module, committee, sequence_no, type, fund,
-- amount, category, payee/donor, phone, payment mode, notes, receipt no, verification
-- code, reversal link + reason, created_by, created_at, prev_hash.
-- SHA-256 uses PostgreSQL's built-in sha256(), so no extension is required.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. Remove the superseded draft layout (only if it is still there)
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'ledger_entries' and column_name = 'type') then
    drop table if exists public.fee_payments cascade;
    drop table if exists public.salary_payments cascade;
    drop table if exists public.ledger_entries cascade;
    drop table if exists public.funds cascade;
    drop function if exists public.verify_ledger(uuid);
    drop function if exists public.module_fund_balances(uuid);
    drop function if exists private.fund_balance(uuid);
    drop function if exists private.seed_funds_for(uuid, uuid, text);
    drop function if exists private.seed_default_funds() cascade;
    drop function if exists private.ledger_before_insert() cascade;
    drop function if exists private.ledger_block_mutation() cascade;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------

create table if not exists public.funds (
  id                  uuid primary key default gen_random_uuid(),
  committee_id        uuid not null references public.committees(id) on delete cascade,
  module_id           uuid not null references public.organization_modules(id) on delete cascade,
  name                text not null check (char_length(btrim(name)) between 2 and 80),
  code                text not null,
  description         text check (description is null or char_length(description) <= 300),
  fund_type           text not null default 'custom'
                      check (fund_type in ('general','sadaqah','zakat','fitra','module_specific','custom')),
  is_zakat_restricted boolean not null default false,
  is_default          boolean not null default false,
  current_balance     numeric(14,2) not null default 0 check (current_balance >= 0),
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  unique (id, committee_id),
  unique (module_id, code),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);
-- no two funds with the same name (any capitalisation) inside one module
create unique index if not exists funds_module_lower_name_idx on public.funds (module_id, lower(btrim(name)));

create table if not exists public.ledger_entries (
  id                  uuid primary key default gen_random_uuid(),
  committee_id        uuid not null references public.committees(id) on delete cascade,
  module_id           uuid not null references public.organization_modules(id) on delete cascade,
  fund_id             uuid not null,
  sequence_no         bigint not null,
  entry_type          text not null check (entry_type in ('donation','expense','reversal')),
  amount              numeric(14,2) not null check (amount > 0),
  category            text,
  donor_or_payee_name text,
  donor_phone         text check (donor_phone is null or donor_phone ~ '^\+91[6-9][0-9]{9}$'),
  payment_mode        text check (payment_mode is null or payment_mode in ('cash','upi','bank_transfer','cheque')),
  notes               text,
  receipt_number      text,
  verification_code   text,
  reversed_entry_id   uuid references public.ledger_entries(id),
  is_reversed         boolean not null default false,
  reversal_reason     text,
  prev_hash           text not null,
  entry_hash          text not null,
  created_by          uuid not null references auth.users(id),
  created_at          timestamptz not null default now(),
  unique (id, committee_id),
  unique (module_id, sequence_no),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade,
  foreign key (fund_id, committee_id) references public.funds (id, committee_id),
  check ((entry_type = 'reversal') = (reversed_entry_id is not null))
);
create unique index if not exists ledger_entries_one_reversal_idx
  on public.ledger_entries (reversed_entry_id) where reversed_entry_id is not null;

-- one counter row per module; only the database trigger may touch it
create table if not exists public.receipt_sequences (
  module_id    uuid primary key references public.organization_modules(id) on delete cascade,
  committee_id uuid not null references public.committees(id) on delete cascade,
  last_number  bigint not null default 0,
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);

create table if not exists public.fee_payments (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  student_id uuid not null,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount numeric(12,2) not null check (amount > 0),
  ledger_entry_id uuid,
  created_at timestamptz not null default now(),
  unique (student_id, month),   -- no double payment for the same month
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade,
  foreign key (student_id, committee_id) references public.students (id, committee_id) on delete cascade,
  foreign key (ledger_entry_id, committee_id) references public.ledger_entries (id, committee_id)
);

create table if not exists public.salary_payments (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  teacher_id uuid not null,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount numeric(12,2) not null check (amount > 0),
  ledger_entry_id uuid,
  created_at timestamptz not null default now(),
  unique (teacher_id, month),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade,
  foreign key (teacher_id, committee_id) references public.teachers (id, committee_id) on delete cascade,
  foreign key (ledger_entry_id, committee_id) references public.ledger_entries (id, committee_id)
);

-- ----------------------------------------------------------------------------
-- 2. Funds: protection triggers + default funds per module
--    "internal" flag: set only inside SECURITY DEFINER functions of this file.
-- ----------------------------------------------------------------------------

create or replace function private.is_internal()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('idarah.internal', true), '') = 'on';
$$;

create or replace function private.funds_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_internal() then
    if not private.can_access(new.committee_id, new.module_id, array['accountant']::text[]) then
      raise exception 'You do not have permission to create funds here' using errcode = '42501';
    end if;
    -- a person creating a custom fund cannot claim default status, a balance or an author
    new.is_default := false;
    new.current_balance := 0;
    new.fund_type := 'custom';
    new.created_by := (select auth.uid());
  end if;
  new.name := btrim(new.name);
  if new.code is null or btrim(new.code) = '' then
    new.code := trim(both '_' from upper(regexp_replace(new.name, '[^A-Za-z0-9]+', '_', 'g')));
    if new.code = '' then new.code := 'FUND'; end if;
  end if;
  -- (default-fund seeding is internal and relies on "on conflict do nothing", so skip these checks for it)
  if not private.is_internal() then
    if exists (select 1 from public.funds f
               where f.module_id = new.module_id and lower(btrim(f.name)) = lower(new.name)) then
      raise exception 'A fund named "%" already exists in this module', new.name;
    end if;
    if exists (select 1 from public.funds f where f.module_id = new.module_id and f.code = new.code) then
      new.code := new.code || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);
    end if;
  end if;
  return new;
end $$;

create or replace function private.funds_before_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_internal() then
    if not private.can_access(old.committee_id, old.module_id, array['accountant']::text[]) then
      raise exception 'You do not have permission to edit funds here' using errcode = '42501';
    end if;
    if new.current_balance is distinct from old.current_balance
       or new.is_default is distinct from old.is_default
       or new.is_zakat_restricted is distinct from old.is_zakat_restricted
       or new.fund_type is distinct from old.fund_type
       or new.code is distinct from old.code
       or new.module_id is distinct from old.module_id
       or new.committee_id is distinct from old.committee_id
       or new.created_by is distinct from old.created_by then
      raise exception 'Only the fund name and description can be edited';
    end if;
    new.name := btrim(new.name);
    if exists (select 1 from public.funds f
               where f.module_id = new.module_id and f.id <> new.id and lower(btrim(f.name)) = lower(new.name)) then
      raise exception 'A fund named "%" already exists in this module', new.name;
    end if;
  end if;
  return new;
end $$;

create or replace function private.funds_before_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then return old; end if;   -- cascade from deleting a whole module/committee
  if old.is_default then
    raise exception 'Default funds cannot be deleted';
  end if;
  if exists (select 1 from public.ledger_entries l where l.fund_id = old.id) then
    raise exception 'A fund that has transactions cannot be deleted';
  end if;
  return old;
end $$;

drop trigger if exists funds_before_insert_trg on public.funds;
create trigger funds_before_insert_trg before insert on public.funds
  for each row execute function private.funds_before_insert();
drop trigger if exists funds_before_update_trg on public.funds;
create trigger funds_before_update_trg before update on public.funds
  for each row execute function private.funds_before_update();
drop trigger if exists funds_before_delete_trg on public.funds;
create trigger funds_before_delete_trg before delete on public.funds
  for each row execute function private.funds_before_delete();

create or replace function private.seed_funds_for(p_module uuid, p_committee uuid, p_type text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_specific_name text;
  v_specific_code text;
begin
  perform set_config('idarah.internal', 'on', true);

  insert into public.funds (committee_id, module_id, name, code, fund_type, is_zakat_restricted, is_default)
  values
    (p_committee, p_module, 'General Fund',          'GENERAL', 'general', false, true),
    (p_committee, p_module, 'Sadaqah',               'SADAQAH', 'sadaqah', false, true),
    (p_committee, p_module, 'Zakat',                 'ZAKAT',   'zakat',   true,  true),
    (p_committee, p_module, 'Fitra (Zakat al-Fitr)', 'FITRA',   'fitra',   true,  true)
  on conflict do nothing;

  select case p_type
           when 'madarsa'      then 'Ta''lim & Student Welfare Fund'
           when 'dargah'       then 'Langar & Urs Fund'
           when 'imambargah'   then 'Majlis & Niyaz Fund'
           when 'waqf_charity' then 'Waqf Property & Maintenance Fund'
           when 'mosque'       then 'Masjid Maintenance & Utilities Fund'
         end,
         case p_type
           when 'madarsa'      then 'TALIM_WELFARE'
           when 'dargah'       then 'LANGAR_URS'
           when 'imambargah'   then 'MAJLIS_NIYAZ'
           when 'waqf_charity' then 'WAQF_PROPERTY'
           when 'mosque'       then 'MASJID_MAINT'
         end
    into v_specific_name, v_specific_code;

  if v_specific_name is not null then
    insert into public.funds (committee_id, module_id, name, code, fund_type, is_zakat_restricted, is_default)
    values (p_committee, p_module, v_specific_name, v_specific_code, 'module_specific', false, true)
    on conflict do nothing;
  end if;

  perform set_config('idarah.internal', 'off', true);
end $$;

create or replace function private.seed_default_funds()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.seed_funds_for(new.id, new.committee_id, new.module_type);
  insert into public.receipt_sequences (module_id, committee_id) values (new.id, new.committee_id)
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists organization_modules_seed_funds on public.organization_modules;
create trigger organization_modules_seed_funds after insert on public.organization_modules
  for each row execute function private.seed_default_funds();

-- backfill modules that existed before this migration
do $$
declare m record;
begin
  for m in select id, committee_id, module_type from public.organization_modules loop
    perform private.seed_funds_for(m.id, m.committee_id, m.module_type);
    insert into public.receipt_sequences (module_id, committee_id) values (m.id, m.committee_id)
    on conflict do nothing;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Ledger: hash chain, accounting rules, immutability
-- ----------------------------------------------------------------------------

create or replace function private.compute_entry_hash(e public.ledger_entries)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(concat_ws('|',
    e.module_id::text,
    e.committee_id::text,
    e.sequence_no::text,
    e.entry_type,
    e.fund_id::text,
    e.amount::text,
    coalesce(e.category, ''),
    coalesce(e.donor_or_payee_name, ''),
    coalesce(e.donor_phone, ''),
    coalesce(e.payment_mode, ''),
    coalesce(e.notes, ''),
    coalesce(e.receipt_number, ''),
    coalesce(e.verification_code, ''),
    coalesce(e.reversed_entry_id::text, ''),
    coalesce(e.reversal_reason, ''),
    e.created_by::text,
    to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    e.prev_hash
  ), 'UTF8')), 'hex');
$$;

-- Live balance of a fund from the ledger itself (source of truth).
create or replace function private.fund_balance(p_fund_id uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case
      when l.entry_type = 'donation' then l.amount
      when l.entry_type = 'expense'  then -l.amount
      when l.entry_type = 'reversal' then case when t.entry_type = 'donation' then -l.amount else l.amount end
    end), 0)
  from public.ledger_entries l
  left join public.ledger_entries t on t.id = l.reversed_entry_id
  where l.fund_id = p_fund_id;
$$;

create or replace function private.ledger_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_fund public.funds;
  v_target public.ledger_entries;
  v_last_seq bigint;
  v_last_hash text;
  v_balance numeric;
  v_delta numeric;
  v_receipt bigint;
  zakat_categories constant text[] := array[
    'fuqara_poor','masakin_needy','amilin_zakat_admin','muallafat_new_muslims',
    'riqab_freeing_captives','gharimin_debtors','ibn_sabil_wayfarers'];
begin
  -- 0. This function bypasses RLS, so it must check the caller itself BEFORE it
  --    reads anything (otherwise error messages could leak other committees' balances).
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not private.can_access(new.committee_id, new.module_id, array['accountant']::text[]) then
    raise exception 'You do not have permission to record finance entries here' using errcode = '42501';
  end if;

  -- 1. Serialise all writers of this module (locks the module's fund rows).
  perform 1 from public.funds where module_id = new.module_id for update;

  -- 2. Business rules
  if new.entry_type = 'reversal' then
    select * into v_target from public.ledger_entries
    where id = new.reversed_entry_id and module_id = new.module_id and committee_id = new.committee_id;
    if not found then
      raise exception 'The entry to reverse was not found in this module';
    end if;
    if v_target.entry_type = 'reversal' then
      raise exception 'A reversal entry cannot itself be reversed';
    end if;
    if v_target.is_reversed then
      raise exception 'This entry has already been reversed';
    end if;
    if new.reversal_reason is null or btrim(new.reversal_reason) = '' then
      raise exception 'A reason is required to reverse an entry';
    end if;
    -- the caller cannot choose what a reversal undoes: it mirrors its original exactly
    new.fund_id             := v_target.fund_id;
    new.amount              := v_target.amount;
    new.category            := 'reversal';
    new.payment_mode        := v_target.payment_mode;
    new.donor_or_payee_name := v_target.donor_or_payee_name;
    new.donor_phone         := v_target.donor_phone;
    new.reversal_reason     := btrim(new.reversal_reason);

    select * into v_fund from public.funds where id = new.fund_id;
    v_balance := private.fund_balance(new.fund_id);
    if v_target.entry_type = 'donation' then
      if v_balance < v_target.amount then
        raise exception 'Cannot reverse donation: funds have already been spent';
      end if;
      v_delta := -v_target.amount;
    else
      v_delta := v_target.amount;
    end if;
  else
    select * into v_fund from public.funds
    where id = new.fund_id and module_id = new.module_id and committee_id = new.committee_id;
    if not found then
      raise exception 'Fund not found in this module';
    end if;
    v_balance := private.fund_balance(new.fund_id);

    if new.entry_type = 'expense' then
      if new.category is null or btrim(new.category) = '' then
        raise exception 'A category is required for an expense';
      end if;
      if new.amount > v_balance then
        raise exception 'Insufficient balance in selected fund';
      end if;
      if v_fund.is_zakat_restricted and not (new.category = any (zakat_categories)) then
        raise exception 'Zakat-restricted funds can only be spent on the 7 Zakat-eligible categories';
      end if;
      v_delta := -new.amount;
    else
      v_delta := new.amount;
    end if;
    new.reversed_entry_id := null;
    new.reversal_reason   := null;
  end if;

  -- 3. Chain position, receipt, hash
  select l.sequence_no, l.entry_hash into v_last_seq, v_last_hash
  from public.ledger_entries l where l.module_id = new.module_id
  order by l.sequence_no desc limit 1;

  new.sequence_no := coalesce(v_last_seq, 0) + 1;
  new.prev_hash   := coalesce(v_last_hash, 'GENESIS');
  new.created_by  := v_uid;
  new.created_at  := now();
  new.is_reversed := false;

  if new.entry_type = 'donation' then
    insert into public.receipt_sequences (module_id, committee_id, last_number)
    values (new.module_id, new.committee_id, 1)
    on conflict (module_id) do update set last_number = public.receipt_sequences.last_number + 1
    returning last_number into v_receipt;
    new.receipt_number    := 'RCP-' || lpad(v_receipt::text, 4, '0');
    new.verification_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  else
    new.receipt_number    := null;
    new.verification_code := null;
  end if;

  new.entry_hash := private.compute_entry_hash(new);

  -- 4. Side effects (all roll back together if the insert fails)
  perform set_config('idarah.internal', 'on', true);
  update public.funds set current_balance = v_balance + v_delta where id = new.fund_id;
  if new.entry_type = 'reversal' then
    update public.ledger_entries set is_reversed = true where id = v_target.id;
  end if;
  perform set_config('idarah.internal', 'off', true);

  return new;
end $$;

create or replace function private.ledger_block_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;   -- cascade from deleting a whole module/committee
    raise exception 'Ledger entries are append-only and can never be deleted';
  end if;
  -- the ONLY permitted change: the database marking an original entry as reversed
  if private.is_internal()
     and old.is_reversed = false and new.is_reversed = true
     and (to_jsonb(new) - 'is_reversed') = (to_jsonb(old) - 'is_reversed') then
    return new;
  end if;
  raise exception 'Ledger entries are append-only and can never be edited';
end $$;

drop trigger if exists ledger_entries_before_insert on public.ledger_entries;
create trigger ledger_entries_before_insert before insert on public.ledger_entries
  for each row execute function private.ledger_before_insert();

drop trigger if exists ledger_entries_block_mutation on public.ledger_entries;
create trigger ledger_entries_block_mutation before update or delete on public.ledger_entries
  for each row execute function private.ledger_block_mutation();

-- Recomputes every hash of one module's chain from sequence_no = 1. SECURITY INVOKER:
-- RLS applies, so only people allowed to read the ledger get a meaningful answer.
create or replace function public.verify_module_ledger(target_module_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  r public.ledger_entries;
  expected_prev text := 'GENESIS';
  expected_seq bigint := 1;
  n bigint := 0;
begin
  for r in select * from public.ledger_entries where module_id = target_module_id order by sequence_no loop
    if r.sequence_no <> expected_seq or r.prev_hash <> expected_prev
       or r.entry_hash <> private.compute_entry_hash(r) then
      return jsonb_build_object('valid', false, 'count', n, 'broken_sequence_no', r.sequence_no);
    end if;
    expected_prev := r.entry_hash;
    expected_seq := expected_seq + 1;
    n := n + 1;
  end loop;
  return jsonb_build_object('valid', true, 'count', n, 'last_hash', expected_prev);
end $$;

-- ----------------------------------------------------------------------------
-- 4. Row Level Security (admin / mutawalli_trustee / accountant only)
-- ----------------------------------------------------------------------------

do $$
begin
  perform private.apply_ops_policies('funds',           array['accountant'], array['accountant']);
  perform private.apply_ops_policies('ledger_entries',  array['accountant'], array['accountant'], false);
  perform private.apply_ops_policies('receipt_sequences', array['accountant'], array['accountant'], false);
  perform private.apply_ops_policies('fee_payments',    array['accountant','teacher'], array['accountant']);
  perform private.apply_ops_policies('salary_payments', array['accountant'], array['accountant']);
end $$;

-- ledger: read + insert only (no UPDATE / DELETE policy; triggers also block them)
drop policy if exists ledger_entries_update on public.ledger_entries;
-- counters: read only; the trigger (definer) is the only writer
drop policy if exists receipt_sequences_insert on public.receipt_sequences;
drop policy if exists receipt_sequences_update on public.receipt_sequences;
revoke insert, update, delete on public.receipt_sequences from authenticated;

drop policy if exists fee_payments_parent_select on public.fee_payments;
create policy fee_payments_parent_select on public.fee_payments for select to authenticated
  using ((select private.is_member(committee_id)) and exists (
    select 1 from public.students s
    where s.id = fee_payments.student_id and s.guardian_user_id = (select auth.uid())));

-- ----------------------------------------------------------------------------
-- 5. Function privileges
-- ----------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname in ('is_internal','funds_before_insert','funds_before_update','funds_before_delete',
                        'seed_funds_for','seed_default_funds','compute_entry_hash','fund_balance',
                        'ledger_before_insert','ledger_block_mutation')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    -- verify_module_ledger (invoker) needs the hash function
    if f.proname = 'compute_entry_hash' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;

  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'verify_module_ledger'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

commit;
