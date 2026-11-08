-- Free website accounts authenticated with an email and password.
--
-- Run this after alter_customer_sms_auth.sql. It leaves the previously added
-- phone column untouched: phone is still collected only for order delivery.
-- No email is sent when Supabase Auth's "Confirm email" setting is disabled.

alter table public.customer_profiles
  add column if not exists email text null;

create unique index if not exists customer_profiles_email_uq
  on public.customer_profiles (lower(email))
  where email is not null;

-- The API service role calls this only after auth.getUser(token), so neither
-- the browser nor an anonymous user can choose an internal customer id.
create or replace function public.ensure_web_customer_profile_by_email(
  p_auth_user_id uuid,
  p_email text
)
returns table (tg_user_id bigint, email text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id bigint;
  v_email text;
begin
  if p_auth_user_id is null then
    raise exception 'auth user id is required' using errcode = '22004';
  end if;

  v_email := lower(nullif(trim(p_email), ''));
  if v_email is null then
    raise exception 'email is required' using errcode = '22004';
  end if;

  insert into public.customer_profiles (
    tg_user_id,
    auth_user_id,
    email,
    referral_code,
    created_at,
    updated_at
  ) values (
    nextval('public.web_customer_id_seq'),
    p_auth_user_id,
    v_email,
    upper(replace(p_auth_user_id::text, '-', '')),
    now(),
    now()
  )
  on conflict (auth_user_id) where auth_user_id is not null do update
    set email = excluded.email,
        updated_at = now()
  returning tg_user_id into v_customer_id;

  return query
    select profile.tg_user_id, profile.email
      from public.customer_profiles profile
     where profile.tg_user_id = v_customer_id;
end;
$$;

revoke all on function public.ensure_web_customer_profile_by_email(uuid, text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
