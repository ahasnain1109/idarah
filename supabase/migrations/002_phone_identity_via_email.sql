-- ============================================================================
-- 002_phone_identity_via_email.sql   (idempotent)
--
-- Supabase's Phone provider needs a paid SMS provider (Twilio). Until OTP is
-- added, the app signs people up with a hidden address derived from their
-- number:  91XXXXXXXXXX@phone.idarah.example.com  (+ password).
-- This replaces the new-user trigger function so the profile's phone is taken
-- from that address. Run this once if you already ran 001 before this file existed
-- (001 now contains the same function, so a fresh install does not need 002).
-- ============================================================================

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_phone text;
begin
  if new.phone is not null then
    v_phone := case when new.phone like '+%' then new.phone else '+' || new.phone end;
  elsif lower(new.email) ~ '^91[6-9][0-9]{9}@phone\.idarah\.example\.com$' then
    v_phone := '+' || split_part(lower(new.email), '@', 1);
  else
    raise exception 'Sign up with an Indian mobile number';
  end if;
  insert into public.profiles (id, full_name, phone, email)
  values (
    new.id,
    coalesce(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    v_phone,
    nullif(btrim(new.raw_user_meta_data ->> 'contact_email'), '')
  );
  return new;
end $$;

revoke all on function private.handle_new_user() from public, anon, authenticated;
