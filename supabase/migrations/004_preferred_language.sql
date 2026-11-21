-- 004: remember each user's chosen language on their profile (safe to re-run)
alter table public.profiles add column if not exists preferred_language text;
alter table public.profiles drop constraint if exists profiles_preferred_language_check;
alter table public.profiles add constraint profiles_preferred_language_check
  check (preferred_language is null or preferred_language in
    ('en','hi','ur','bn','gu','ks','ml','ta','te','kn','mr','as','or','pa'));
-- users may edit only their name, email and language (the existing update policy still limits this to their own row)
grant update (full_name, email, preferred_language) on public.profiles to authenticated;
