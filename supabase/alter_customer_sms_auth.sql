-- Shared profile foundation for website accounts.
--
-- The historical filename is retained because this migration may already have
-- been applied. Run alter_customer_password_auth.sql after this file to enable
-- the current free email-and-password flow. The legacy
-- `tg_user_id` remains the internal customer key, so historical Telegram
-- orders, referrals and bonus balances are left untouched. Website-only users
-- receive a negative internal id from the sequence below; Telegram ids are
-- positive, therefore the two namespaces cannot collide.

alter table public.customer_profiles
  add column if not exists auth_user_id uuid null references auth.users (id) on delete set null,
  add column if not exists phone text null;

create unique index if not exists customer_profiles_auth_user_id_uq
  on public.customer_profiles (auth_user_id)
  where auth_user_id is not null;

create unique index if not exists customer_profiles_phone_uq
  on public.customer_profiles (phone)
  where phone is not null;

create sequence if not exists public.web_customer_id_seq
  as bigint
  start with -1
  increment by -1
  minvalue -9223372036854775808
  maxvalue -1;

-- This function is deliberately called only by the API service role after it
-- has verified a Supabase access token with auth.getUser(token).  `phone` is
-- refreshed on every authenticated request, which also handles a verified
-- phone-number change in Supabase Auth.
create or replace function public.ensure_web_customer_profile(
  p_auth_user_id uuid,
  p_phone text
)
returns table (tg_user_id bigint, phone text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id bigint;
  v_phone text;
begin
  if p_auth_user_id is null then
    raise exception 'auth user id is required' using errcode = '22004';
  end if;

  v_phone := nullif(trim(p_phone), '');

  -- One statement makes a first sign-in idempotent even when the browser
  -- starts the profile bootstrap and referral bootstrap at the same time.
  insert into public.customer_profiles (
    tg_user_id,
    auth_user_id,
    phone,
    referral_code,
    created_at,
    updated_at
  ) values (
    nextval('public.web_customer_id_seq'),
    p_auth_user_id,
    v_phone,
    -- UUID makes this deterministic, URL-safe and collision-free while
    -- retaining the existing alphanumeric referral-code contract.
    upper(replace(p_auth_user_id::text, '-', '')),
    now(),
    now()
  )
  on conflict (auth_user_id) where auth_user_id is not null do update
    set phone = excluded.phone,
        updated_at = now()
  returning tg_user_id into v_customer_id;

  return query
    select profile.tg_user_id, profile.phone
      from public.customer_profiles profile
     where profile.tg_user_id = v_customer_id;
end;
$$;

revoke all on function public.ensure_web_customer_profile(uuid, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
