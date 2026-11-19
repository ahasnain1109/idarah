-- ============================================================================
-- Idarah platform: committees + connectable modules + strict row level security
-- 001_modular_committees_rls.sql   (idempotent: safe to run more than once)
--
-- Model
--   committees (tenant) 1 ── * organization_modules (mosque | madarsa | dargah |
--   imambargah | waqf_charity; several of the same type allowed)
--   profiles (1 per auth user, phone is the login id) ── committee_memberships
--   (roles text[]) ── committees
--   Every operational table carries committee_id + module_id and RLS.
--
-- Security notes
--   * Helper functions live in schema "private" (not exposed through the API).
--   * Policies call them as (select private.fn(...)) so Postgres caches the result.
--   * Writes that must be atomic (create committee, add modules, add member)
--     go through SECURITY DEFINER functions in public that validate everything.
--   * The ledger is append-only: hash chain computed in a trigger, and
--     UPDATE / direct DELETE are blocked even for privileged roles.
-- ============================================================================

begin;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ----------------------------------------------------------------------------
-- 1. Core tables
-- ----------------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  phone       text not null unique check (phone ~ '^\+91[6-9][0-9]{9}$'),
  email       text unique check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at  timestamptz not null default now()
);

create table if not exists public.committees (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 2 and 150),
  city        text,
  state       text,
  country     text not null default 'India',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists committees_created_by_idx on public.committees (created_by);

create table if not exists public.organization_modules (
  id            uuid primary key default gen_random_uuid(),
  committee_id  uuid not null references public.committees(id) on delete cascade,
  module_type   text not null check (module_type in ('mosque','madarsa','dargah','imambargah','waqf_charity')),
  module_name   text not null check (char_length(btrim(module_name)) between 2 and 150),
  details       jsonb not null default '{}'::jsonb
                check (jsonb_typeof(details) = 'object' and pg_column_size(details) < 16384),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (id, committee_id)   -- target for composite FKs; NOT unique per type (many mosques allowed)
);
create index if not exists organization_modules_committee_idx on public.organization_modules (committee_id);

create table if not exists public.committee_memberships (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  committee_id     uuid not null references public.committees(id) on delete cascade,
  roles            text[] not null default '{}'
                   check (roles <@ array['admin','mutawalli_trustee','imam_zakir','teacher','accountant','volunteer','parent']::text[]),
  allowed_modules  uuid[],  -- NULL = every module of the committee; otherwise only these module ids
  status           text not null default 'active' check (status in ('active','invited','suspended')),
  created_at       timestamptz not null default now(),
  unique (user_id, committee_id)
);
create index if not exists committee_memberships_user_idx      on public.committee_memberships (user_id);
create index if not exists committee_memberships_committee_idx on public.committee_memberships (committee_id);

-- ----------------------------------------------------------------------------
-- 2. Private helper functions (used inside RLS policies)
-- ----------------------------------------------------------------------------

-- Active member with any of allowed_roles. admin and mutawalli_trustee always pass.
create or replace function private.has_committee_role(target_committee_id uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.committee_memberships m
    where m.committee_id = target_committee_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and (m.roles && allowed_roles or m.roles && array['admin','mutawalli_trustee']::text[])
  );
$$;

-- Same, but also honours the member's allowed_modules restriction.
create or replace function private.can_access(target_committee_id uuid, target_module_id uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.committee_memberships m
    where m.committee_id = target_committee_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and (m.roles && allowed_roles or m.roles && array['admin','mutawalli_trustee']::text[])
      and (m.allowed_modules is null or target_module_id = any (m.allowed_modules))
  );
$$;

create or replace function private.is_member(target_committee_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.committee_memberships m
    where m.committee_id = target_committee_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

create or replace function private.can_see_module(target_committee_id uuid, target_module_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.committee_memberships m
    where m.committee_id = target_committee_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and (m.allowed_modules is null or target_module_id = any (m.allowed_modules))
  );
$$;

create or replace function private.shares_committee(other_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.committee_memberships a
    join public.committee_memberships b on b.committee_id = a.committee_id
    where a.user_id = (select auth.uid()) and a.status = 'active'
      and b.user_id = other_user
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. Operational tables (all tagged with committee_id + module_id)
--    The composite FK (module_id, committee_id) guarantees a row can never
--    point at a module of a different committee.
-- ----------------------------------------------------------------------------

create table if not exists public.teachers (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  full_name text not null, phone text, role_title text,
  monthly_salary numeric(12,2) not null default 0 check (monthly_salary >= 0),
  user_id uuid references auth.users(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, committee_id),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  name text not null, shift text,
  teacher_id uuid,
  created_at timestamptz not null default now(),
  unique (id, committee_id),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade,
  foreign key (teacher_id, committee_id) references public.teachers (id, committee_id)
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  class_id uuid,
  full_name text not null, guardian_name text, guardian_phone text,
  guardian_user_id uuid references auth.users(id) on delete set null,
  monthly_fee numeric(12,2) not null default 0 check (monthly_fee >= 0),
  admission_date date not null default current_date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, committee_id),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade,
  foreign key (class_id, committee_id) references public.classes (id, committee_id)
);
create index if not exists students_guardian_idx on public.students (guardian_user_id);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  student_id uuid not null,
  attendance_date date not null,
  status text not null check (status in ('present','absent','leave')),
  created_at timestamptz not null default now(),
  unique (student_id, attendance_date),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade,
  foreign key (student_id, committee_id) references public.students (id, committee_id) on delete cascade
);

create table if not exists public.hifz_logs (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  student_id uuid not null,
  log_date date not null default current_date,
  sabaq text, sabqi text, manzil text, notes text,
  created_at timestamptz not null default now(),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade,
  foreign key (student_id, committee_id) references public.students (id, committee_id) on delete cascade
);

create table if not exists public.funds (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  name text not null,
  is_zakat_eligible boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, committee_id),
  unique (module_id, name),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  seq bigint not null,
  entry_date timestamptz not null default now(),
  type text not null check (type in ('donation','expense','reversal')),
  amount numeric(14,2) not null check (amount > 0),
  fund_id uuid not null,
  method text, category text, note text,
  donor_name text, donor_phone text,
  receipt_no text, verify_code text,
  recorded_by uuid references auth.users(id) on delete set null,
  reverses_entry_id uuid references public.ledger_entries(id),
  prev_hash text not null default '',
  hash text not null default '',
  unique (id, committee_id),
  unique (committee_id, seq),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade,
  foreign key (fund_id, committee_id) references public.funds (id, committee_id),
  check ((type = 'reversal') = (reverses_entry_id is not null))
);
create unique index if not exists ledger_entries_one_reversal_idx
  on public.ledger_entries (reverses_entry_id) where reverses_entry_id is not null;

create table if not exists public.donors (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  full_name text not null, phone text, address text, notes text,
  created_at timestamptz not null default now(),
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

create table if not exists public.prayer_times (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  prayer text not null check (prayer in ('fajr','dhuhr','asr','maghrib','isha','jumuah')),
  adhan_time time, iqamah_time time,
  unique (module_id, prayer),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);

create table if not exists public.notices (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  title text not null, body text,
  published_on date not null default current_date, expires_on date,
  created_at timestamptz not null default now(),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);

create table if not exists public.nikah_records (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  groom text not null, bride text not null, wali_witnesses text, mahr text,
  nikah_date date not null, qazi text,
  created_at timestamptz not null default now(),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);

create table if not exists public.janazah_records (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  deceased text not null, age int check (age is null or age between 0 and 150),
  demise_date date not null, janazah_time text, burial_place text,
  created_at timestamptz not null default now(),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);

create table if not exists public.majlis_urs_events (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  event_type text not null check (event_type in ('majlis','urs','milad','muharram','other')),
  title text not null, starts_on date, hijri_date text, notes text,
  created_at timestamptz not null default now(),
  unique (id, committee_id),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);

create table if not exists public.langar_niyaz (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  event_id uuid,
  service_date date not null default current_date,
  kind text not null check (kind in ('langar','niyaz','sabeel')),
  meals_served int check (meals_served is null or meals_served >= 0), notes text,
  created_at timestamptz not null default now(),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade,
  foreign key (event_id, committee_id) references public.majlis_urs_events (id, committee_id)
);

create table if not exists public.waqf_assets (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  name text not null,
  asset_type text not null check (asset_type in ('property','shop','land','other')),
  location text, annual_rent numeric(14,2) check (annual_rent is null or annual_rent >= 0),
  acquired_on date, notes text,
  created_at timestamptz not null default now(),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);

create table if not exists public.beneficiaries (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  full_name text not null, phone text, category text, support_type text, notes text,
  created_at timestamptz not null default now(),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  committee_id uuid not null references public.committees(id) on delete cascade,
  module_id uuid not null references public.organization_modules(id) on delete cascade,
  name text not null, location text,
  value numeric(14,2) check (value is null or value >= 0),
  condition text, acquired_on date,
  created_at timestamptz not null default now(),
  foreign key (module_id, committee_id) references public.organization_modules (id, committee_id) on delete cascade
);

-- ----------------------------------------------------------------------------
-- 4. Append-only ledger: hash chain + immutability
-- ----------------------------------------------------------------------------

create or replace function private.compute_ledger_hash(e public.ledger_entries)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(concat_ws('|',
    e.seq::text,
    to_char(e.entry_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    e.type,
    e.amount::text,
    e.committee_id::text,
    e.module_id::text,
    e.fund_id::text,
    coalesce(e.method, ''),
    coalesce(e.category, ''),
    coalesce(e.note, ''),
    coalesce(e.donor_name, ''),
    coalesce(e.donor_phone, ''),
    coalesce(e.receipt_no, ''),
    coalesce(e.verify_code, ''),
    coalesce(e.recorded_by::text, ''),
    coalesce(e.reverses_entry_id::text, ''),
    e.prev_hash
  ), 'UTF8')), 'hex');
$$;

create or replace function private.ledger_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  last_seq bigint;
  last_hash text;
  target public.ledger_entries;
begin
  -- serialise writers per committee so seq / prev_hash can never fork
  perform pg_advisory_xact_lock(hashtextextended(new.committee_id::text, 0));

  select l.seq, l.hash into last_seq, last_hash
  from public.ledger_entries l
  where l.committee_id = new.committee_id
  order by l.seq desc limit 1;

  if new.type = 'reversal' then
    select * into target from public.ledger_entries
    where id = new.reverses_entry_id and committee_id = new.committee_id;
    if not found then
      raise exception 'Reversal target not found in this committee';
    end if;
    if target.type = 'reversal' then
      raise exception 'A reversal entry cannot itself be reversed';
    end if;
  end if;

  new.seq         := coalesce(last_seq, 0) + 1;
  new.prev_hash   := coalesce(last_hash, 'GENESIS');
  new.entry_date  := now();
  new.recorded_by := (select auth.uid());

  if new.type = 'donation' then
    new.receipt_no  := 'RCP-' || lpad((select count(*) + 1 from public.ledger_entries
                        where committee_id = new.committee_id and type = 'donation')::text, 4, '0');
    new.verify_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  else
    new.receipt_no  := null;
    new.verify_code := null;
  end if;

  new.hash := private.compute_ledger_hash(new);
  return new;
end $$;

create or replace function private.ledger_block_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- allow only cascading deletes (deleting a whole committee/module); never user-level edits
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Ledger entries are append-only: record a reversal instead';
end $$;

drop trigger if exists ledger_entries_before_insert on public.ledger_entries;
create trigger ledger_entries_before_insert before insert on public.ledger_entries
  for each row execute function private.ledger_before_insert();

drop trigger if exists ledger_entries_block_mutation on public.ledger_entries;
create trigger ledger_entries_block_mutation before update or delete on public.ledger_entries
  for each row execute function private.ledger_block_mutation();

-- Recomputes every hash of a committee's chain. SECURITY INVOKER: RLS applies,
-- so only users allowed to read the ledger get a result.
create or replace function public.verify_ledger(p_committee_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  r public.ledger_entries;
  expected_prev text := 'GENESIS';
  expected_seq bigint := 1;
  n bigint := 0;
begin
  for r in select * from public.ledger_entries where committee_id = p_committee_id order by seq loop
    if r.seq <> expected_seq or r.prev_hash <> expected_prev
       or r.hash <> private.compute_ledger_hash(r) then
      return jsonb_build_object('valid', false, 'count', n, 'broken_seq', r.seq);
    end if;
    expected_prev := r.hash;
    expected_seq := expected_seq + 1;
    n := n + 1;
  end loop;
  return jsonb_build_object('valid', true, 'count', n, 'last_hash', expected_prev);
end $$;

-- ----------------------------------------------------------------------------
-- 5. New-user profile (phone is the login identifier)
-- ----------------------------------------------------------------------------

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_phone text;
begin
  v_phone := case when new.phone is null then null
                  when new.phone like '+%' then new.phone
                  else '+' || new.phone end;
  insert into public.profiles (id, full_name, phone, email)
  values (
    new.id,
    coalesce(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    v_phone,
    nullif(btrim(new.raw_user_meta_data ->> 'contact_email'), '')
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ----------------------------------------------------------------------------
-- 6. Atomic RPCs (SECURITY DEFINER, validate everything themselves)
-- ----------------------------------------------------------------------------

create or replace function private.insert_modules(p_committee_id uuid, p_modules jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare m jsonb;
begin
  if jsonb_typeof(p_modules) <> 'array' or jsonb_array_length(p_modules) not between 1 and 25 then
    raise exception 'Select between 1 and 25 modules';
  end if;
  for m in select * from jsonb_array_elements(p_modules) loop
    if jsonb_typeof(m) <> 'object' then
      raise exception 'Invalid module payload';
    end if;
    insert into public.organization_modules (committee_id, module_type, module_name, details)
    values (
      p_committee_id,
      m ->> 'module_type',
      btrim(coalesce(m ->> 'module_name', '')),
      coalesce(m -> 'details', '{}'::jsonb)
    );
  end loop;
end $$;

create or replace function public.create_committee_with_modules(
  p_name text, p_city text, p_state text, p_modules jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_cid uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_name is null or char_length(btrim(p_name)) < 2 then
    raise exception 'Committee name is required';
  end if;
  if (select count(*) from public.committees where created_by = v_uid) >= 20 then
    raise exception 'Committee limit reached for this account';
  end if;

  insert into public.committees (name, city, state, created_by)
  values (btrim(p_name), nullif(btrim(coalesce(p_city, '')), ''), nullif(btrim(coalesce(p_state, '')), ''), v_uid)
  returning id into v_cid;

  insert into public.committee_memberships (user_id, committee_id, roles)
  values (v_uid, v_cid, array['admin']);

  perform private.insert_modules(v_cid, p_modules);
  return v_cid;
end $$;

create or replace function public.add_modules(p_committee_id uuid, p_modules jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_committee_role(p_committee_id, array['admin','mutawalli_trustee']) then
    raise exception 'Only an admin or trustee can onboard modules' using errcode = '42501';
  end if;
  perform private.insert_modules(p_committee_id, p_modules);
  return jsonb_array_length(p_modules);
end $$;

create or replace function public.add_member_by_phone(
  p_committee_id uuid, p_phone text, p_roles text[], p_allowed_modules uuid[] default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_id uuid;
begin
  if not private.has_committee_role(p_committee_id, array['admin','mutawalli_trustee']) then
    raise exception 'Only an admin or trustee can manage members' using errcode = '42501';
  end if;
  if p_phone !~ '^\+91[6-9][0-9]{9}$' then
    raise exception 'Enter a valid +91 mobile number';
  end if;
  if p_roles is null or cardinality(p_roles) = 0 then
    raise exception 'Choose at least one role';
  end if;
  if p_allowed_modules is not null and exists (
       select 1 from unnest(p_allowed_modules) as x(mid)
       where not exists (select 1 from public.organization_modules o
                         where o.id = x.mid and o.committee_id = p_committee_id)
     ) then
    raise exception 'Unknown module for this committee';
  end if;

  select id into v_user from public.profiles where phone = p_phone;
  if v_user is null then
    raise exception 'No account found for this number. Ask the person to sign up first.';
  end if;

  insert into public.committee_memberships (user_id, committee_id, roles, allowed_modules, status)
  values (v_user, p_committee_id, p_roles, p_allowed_modules, 'active')
  on conflict (user_id, committee_id)
  do update set roles = excluded.roles, allowed_modules = excluded.allowed_modules, status = 'active'
  returning id into v_id;
  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Row Level Security
-- ----------------------------------------------------------------------------

-- Generic policy builder for operational tables (select / insert / update / delete)
create or replace function private.apply_ops_policies(
  tbl text, read_roles text[], write_roles text[], allow_delete boolean default true
) returns void language plpgsql set search_path = '' as $$
begin
  execute format('alter table public.%I enable row level security', tbl);
  execute format('revoke all on public.%I from anon', tbl);
  execute format('create index if not exists %I on public.%I (committee_id)', tbl || '_committee_idx', tbl);
  execute format('create index if not exists %I on public.%I (module_id)', tbl || '_module_idx', tbl);

  execute format('drop policy if exists %I on public.%I', tbl || '_select', tbl);
  execute format('drop policy if exists %I on public.%I', tbl || '_insert', tbl);
  execute format('drop policy if exists %I on public.%I', tbl || '_update', tbl);
  execute format('drop policy if exists %I on public.%I', tbl || '_delete', tbl);

  execute format($p$create policy %I on public.%I for select to authenticated
    using ((select private.can_access(committee_id, module_id, %L::text[])))$p$,
    tbl || '_select', tbl, read_roles);
  execute format($p$create policy %I on public.%I for insert to authenticated
    with check ((select private.can_access(committee_id, module_id, %L::text[])))$p$,
    tbl || '_insert', tbl, write_roles);
  execute format($p$create policy %I on public.%I for update to authenticated
    using ((select private.can_access(committee_id, module_id, %L::text[])))
    with check ((select private.can_access(committee_id, module_id, %L::text[])))$p$,
    tbl || '_update', tbl, write_roles, write_roles);
  if allow_delete then
    execute format($p$create policy %I on public.%I for delete to authenticated
      using ((select private.can_access(committee_id, module_id, %L::text[])))$p$,
      tbl || '_delete', tbl, write_roles);
  end if;
end $$;

do $$
declare
  staff constant text[] := array['admin','mutawalli_trustee','imam_zakir','teacher','accountant','volunteer'];
begin
  perform private.apply_ops_policies('teachers',        staff,                 array['admin']);
  perform private.apply_ops_policies('classes',         staff,                 array['teacher']);
  perform private.apply_ops_policies('students',        staff,                 array['teacher']);
  perform private.apply_ops_policies('attendance',      staff,                 array['teacher']);
  perform private.apply_ops_policies('hifz_logs',       staff,                 array['teacher']);
  perform private.apply_ops_policies('funds',           array['accountant'],   array['accountant']);
  perform private.apply_ops_policies('donors',          array['accountant'],   array['accountant']);
  perform private.apply_ops_policies('fee_payments',    array['accountant','teacher'], array['accountant']);
  perform private.apply_ops_policies('salary_payments', array['accountant'],   array['accountant']);
  perform private.apply_ops_policies('prayer_times',    staff,                 array['imam_zakir']);
  perform private.apply_ops_policies('notices',         staff,                 array['imam_zakir']);
  perform private.apply_ops_policies('nikah_records',   array['imam_zakir'],   array['imam_zakir']);
  perform private.apply_ops_policies('janazah_records', array['imam_zakir'],   array['imam_zakir']);
  perform private.apply_ops_policies('majlis_urs_events', staff,               array['imam_zakir']);
  perform private.apply_ops_policies('langar_niyaz',    staff,                 array['volunteer']);
  perform private.apply_ops_policies('waqf_assets',     array['accountant'],   array['accountant']);
  perform private.apply_ops_policies('beneficiaries',   array['accountant'],   array['accountant']);
  perform private.apply_ops_policies('assets',          array['accountant'],   array['accountant']);
  -- ledger: read + insert only. No UPDATE / DELETE policy exists (and triggers block them anyway).
  perform private.apply_ops_policies('ledger_entries',  array['accountant'],   array['accountant'], false);
end $$;

-- Ledger is insert-only: drop the generic update policy created above.
drop policy if exists ledger_entries_update on public.ledger_entries;

-- Parents: strictly read-only access to their own linked children
drop policy if exists students_parent_select on public.students;
create policy students_parent_select on public.students for select to authenticated
  using (guardian_user_id = (select auth.uid()) and (select private.is_member(committee_id)));

drop policy if exists attendance_parent_select on public.attendance;
create policy attendance_parent_select on public.attendance for select to authenticated
  using ((select private.is_member(committee_id)) and exists (
    select 1 from public.students s
    where s.id = attendance.student_id and s.guardian_user_id = (select auth.uid())));

drop policy if exists hifz_logs_parent_select on public.hifz_logs;
create policy hifz_logs_parent_select on public.hifz_logs for select to authenticated
  using ((select private.is_member(committee_id)) and exists (
    select 1 from public.students s
    where s.id = hifz_logs.student_id and s.guardian_user_id = (select auth.uid())));

drop policy if exists fee_payments_parent_select on public.fee_payments;
create policy fee_payments_parent_select on public.fee_payments for select to authenticated
  using ((select private.is_member(committee_id)) and exists (
    select 1 from public.students s
    where s.id = fee_payments.student_id and s.guardian_user_id = (select auth.uid())));

-- profiles: see yourself and people who share a committee with you; edit only name/email
alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
revoke insert, delete on public.profiles from authenticated;
revoke update on public.profiles from authenticated;
grant update (full_name, email) on public.profiles to authenticated;
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.shares_committee(id)));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- committees: members read; admin/trustee edit; creation only via RPC
alter table public.committees enable row level security;
revoke all on public.committees from anon;
revoke insert on public.committees from authenticated;
drop policy if exists committees_select on public.committees;
create policy committees_select on public.committees for select to authenticated
  using ((select private.is_member(id)));
drop policy if exists committees_update on public.committees;
create policy committees_update on public.committees for update to authenticated
  using ((select private.has_committee_role(id, array['admin','mutawalli_trustee']::text[])))
  with check ((select private.has_committee_role(id, array['admin','mutawalli_trustee']::text[])));
drop policy if exists committees_delete on public.committees;
create policy committees_delete on public.committees for delete to authenticated
  using ((select private.has_committee_role(id, array['admin']::text[])));

-- organization_modules: members see modules they are allowed to; admin/trustee manage
alter table public.organization_modules enable row level security;
revoke all on public.organization_modules from anon;
revoke insert on public.organization_modules from authenticated;  -- via add_modules()
drop policy if exists organization_modules_select on public.organization_modules;
create policy organization_modules_select on public.organization_modules for select to authenticated
  using ((select private.can_see_module(committee_id, id)));
drop policy if exists organization_modules_update on public.organization_modules;
create policy organization_modules_update on public.organization_modules for update to authenticated
  using ((select private.can_access(committee_id, id, array['admin','mutawalli_trustee']::text[])))
  with check ((select private.can_access(committee_id, id, array['admin','mutawalli_trustee']::text[])));
drop policy if exists organization_modules_delete on public.organization_modules;
create policy organization_modules_delete on public.organization_modules for delete to authenticated
  using ((select private.has_committee_role(committee_id, array['admin']::text[])));

-- committee_memberships: see your own; admin/trustee see + manage all of their committee
alter table public.committee_memberships enable row level security;
revoke all on public.committee_memberships from anon;
revoke insert on public.committee_memberships from authenticated;  -- via add_member_by_phone()
drop policy if exists committee_memberships_select on public.committee_memberships;
create policy committee_memberships_select on public.committee_memberships for select to authenticated
  using (user_id = (select auth.uid())
         or (select private.has_committee_role(committee_id, array['admin','mutawalli_trustee']::text[])));
drop policy if exists committee_memberships_update on public.committee_memberships;
create policy committee_memberships_update on public.committee_memberships for update to authenticated
  using ((select private.has_committee_role(committee_id, array['admin','mutawalli_trustee']::text[])))
  with check ((select private.has_committee_role(committee_id, array['admin','mutawalli_trustee']::text[])));
drop policy if exists committee_memberships_delete on public.committee_memberships;
create policy committee_memberships_delete on public.committee_memberships for delete to authenticated
  using ((select private.has_committee_role(committee_id, array['admin','mutawalli_trustee']::text[])));

-- ----------------------------------------------------------------------------
-- 8. Function privileges: nothing in "private" is callable by anon / public
-- ----------------------------------------------------------------------------

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    -- only the helpers that RLS policies / verify_ledger evaluate need to be callable
    if f.sig::text ~ '^private\.(has_committee_role|can_access|is_member|can_see_module|shares_committee|compute_ledger_hash)\(' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;

  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_committee_with_modules','add_modules','add_member_by_phone','verify_ledger')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

commit;
