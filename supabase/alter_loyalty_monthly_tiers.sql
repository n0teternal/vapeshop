-- Monthly tier rules for the cashback loyalty program.
-- Run this AFTER supabase/alter_loyalty_program.sql.
--
-- A customer earns or upgrades a tier from their completed orders in the
-- rolling last 30 days. Once earned, that tier remains active while the
-- customer completes at least one order every 60 days.

alter table public.customer_profiles
  add column if not exists monthly_spent numeric not null default 0;

-- `created_at` is not a reliable completion time for an order that was kept
-- in processing for a while. New completions receive this value atomically in
-- loyalty_complete_order; old done orders are seeded with their created time.
alter table public.orders
  add column if not exists completed_at timestamptz null;

update public.orders
set completed_at = created_at
where status = 'done'
  and completed_at is null;

create index if not exists orders_done_user_completed_idx
  on public.orders (tg_user_id, completed_at desc)
  where status = 'done';

-- Recalculate the starting status from the rolling window. Historical spend
-- remains in total_spent for reporting, but does not grant a tier by itself.
with order_summary as (
  select
    profile.tg_user_id,
    coalesce(
      sum(coalesce(order_row.total_after_discount, order_row.total_price)) filter (
        where order_row.status = 'done'
          and coalesce(order_row.completed_at, order_row.created_at) >= now() - interval '30 days'
      ),
      0
    ) as monthly_spent,
    max(coalesce(order_row.completed_at, order_row.created_at)) filter (
      where order_row.status = 'done'
    ) as last_order_date
  from public.customer_profiles profile
  left join public.orders order_row on order_row.tg_user_id = profile.tg_user_id
  group by profile.tg_user_id
)
update public.customer_profiles profile
set
  monthly_spent = summary.monthly_spent,
  last_order_date = summary.last_order_date,
  current_cashback_level = case
    when summary.last_order_date is null
      or summary.last_order_date <= now() - interval '60 days' then 0
    when summary.monthly_spent >= 10000 then 7
    when summary.monthly_spent >= 5000 then 5
    when summary.monthly_spent >= 3000 then 3
    else 0
  end,
  updated_at = now()
from order_summary summary
where profile.tg_user_id = summary.tg_user_id;

-- Manual credit extends point expiry but must not be treated as a successful
-- purchase: it never refreshes last_order_date or a cashback status.
create or replace function public.loyalty_apply_points_transaction(
  p_tg_user_id bigint,
  p_delta_points integer,
  p_kind text,
  p_order_id uuid default null,
  p_referral_id bigint default null,
  p_comment text default null,
  p_reset_expiry boolean default false
)
returns table (
  applied boolean,
  bonus_points integer,
  loyalty_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.customer_profiles%rowtype;
  v_existing_id bigint;
  v_now timestamptz := now();
  v_next_points integer;
  v_expires_at timestamptz;
begin
  if p_delta_points = 0 then
    raise exception 'loyalty delta must not be zero' using errcode = '22023';
  end if;

  select * into v_profile
  from public.customer_profiles
  where tg_user_id = p_tg_user_id
  for update;
  if not found then
    raise exception 'loyalty profile % not found', p_tg_user_id using errcode = 'P0002';
  end if;

  if v_profile.bonus_points > 0
    and v_profile.loyalty_expires_at is not null
    and v_profile.loyalty_expires_at <= v_now then
    insert into public.loyalty_transactions (tg_user_id, delta_points, kind, comment, created_at)
    values (
      p_tg_user_id, -v_profile.bonus_points, 'points_expired',
      'Expired after 60 days without a successful order', v_now
    );
    update public.customer_profiles
    set bonus_points = 0, loyalty_expires_at = null, updated_at = v_now
    where tg_user_id = p_tg_user_id;
    v_profile.bonus_points := 0;
    v_profile.loyalty_expires_at := null;
  end if;

  if v_profile.current_cashback_level > 0
    and (v_profile.last_order_date is null or v_profile.last_order_date <= v_now - interval '60 days') then
    update public.customer_profiles
    set current_cashback_level = 0, monthly_spent = 0, updated_at = v_now
    where tg_user_id = p_tg_user_id;
    v_profile.current_cashback_level := 0;
    v_profile.monthly_spent := 0;
  end if;

  if p_referral_id is not null and p_kind in ('referral_inviter_bonus', 'referral_invitee_bonus') then
    select id into v_existing_id
    from public.loyalty_transactions
    where tg_user_id = p_tg_user_id
      and kind = p_kind
      and referral_id = p_referral_id;
    if found then
      return query select false, v_profile.bonus_points, v_profile.loyalty_expires_at;
      return;
    end if;
  end if;

  v_next_points := v_profile.bonus_points + p_delta_points;
  if v_next_points < 0 then
    raise exception 'not enough loyalty points' using errcode = 'P0001';
  end if;

  v_expires_at := case
    when p_reset_expiry then v_now + interval '60 days'
    when p_delta_points > 0 and v_profile.loyalty_expires_at is null then v_now + interval '60 days'
    else v_profile.loyalty_expires_at
  end;

  insert into public.loyalty_transactions (
    tg_user_id, delta_points, kind, order_id, referral_id, comment, created_at
  ) values (
    p_tg_user_id, p_delta_points, p_kind, p_order_id, p_referral_id, p_comment, v_now
  );

  update public.customer_profiles
  set
    bonus_points = v_next_points,
    loyalty_expires_at = case when v_next_points = 0 then null else v_expires_at end,
    loyalty_notice_45_sent_at = case when p_reset_expiry then null else loyalty_notice_45_sent_at end,
    loyalty_notice_59_sent_at = case when p_reset_expiry then null else loyalty_notice_59_sent_at end,
    updated_at = v_now
  where tg_user_id = p_tg_user_id;

  return query select true, v_next_points, case when v_next_points = 0 then null else v_expires_at end;
end;
$$;

create or replace function public.loyalty_complete_order(
  p_tg_user_id bigint,
  p_order_id uuid,
  p_cashback_base numeric
)
returns table (
  applied boolean,
  cashback_points integer,
  cashback_percent integer,
  total_spent numeric,
  bonus_points integer,
  loyalty_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.customer_profiles%rowtype;
  v_existing public.loyalty_transactions%rowtype;
  v_now timestamptz := now();
  v_completed_at timestamptz;
  v_percent integer;
  v_cashback_points integer;
  v_new_total numeric;
  v_monthly_spent numeric;
  v_earned_level integer;
  v_new_level integer;
  v_new_bonus_points integer;
  v_expires_at timestamptz := v_now + interval '60 days';
begin
  select * into v_profile
  from public.customer_profiles
  where tg_user_id = p_tg_user_id
  for update;
  if not found then
    raise exception 'loyalty profile % not found', p_tg_user_id using errcode = 'P0002';
  end if;

  update public.orders
  set completed_at = coalesce(completed_at, v_now)
  where id = p_order_id
    and tg_user_id = p_tg_user_id
    and status = 'done'
  returning completed_at into v_completed_at;
  if not found then
    raise exception 'completed order % not found for loyalty', p_order_id using errcode = 'P0002';
  end if;

  if v_profile.bonus_points > 0
    and v_profile.loyalty_expires_at is not null
    and v_profile.loyalty_expires_at <= v_now then
    insert into public.loyalty_transactions (tg_user_id, delta_points, kind, comment, created_at)
    values (
      p_tg_user_id, -v_profile.bonus_points, 'points_expired',
      'Expired after 60 days without a successful order', v_now
    );
    update public.customer_profiles
    set bonus_points = 0, loyalty_expires_at = null, updated_at = v_now
    where tg_user_id = p_tg_user_id;
    v_profile.bonus_points := 0;
    v_profile.loyalty_expires_at := null;
  end if;

  if v_profile.current_cashback_level > 0
    and (v_profile.last_order_date is null or v_profile.last_order_date <= v_now - interval '60 days') then
    update public.customer_profiles
    set current_cashback_level = 0, monthly_spent = 0, updated_at = v_now
    where tg_user_id = p_tg_user_id;
    v_profile.current_cashback_level := 0;
    v_profile.monthly_spent := 0;
  end if;

  select * into v_existing
  from public.loyalty_transactions
  where tg_user_id = p_tg_user_id
    and kind = 'order_cashback'
    and order_id = p_order_id;
  if found then
    return query select
      false,
      v_existing.delta_points,
      v_profile.current_cashback_level,
      v_profile.total_spent,
      v_profile.bonus_points,
      v_profile.loyalty_expires_at;
    return;
  end if;

  v_percent := v_profile.current_cashback_level;
  v_cashback_points := round(greatest(coalesce(p_cashback_base, 0), 0) * v_percent / 100.0)::integer;
  v_new_total := v_profile.total_spent + greatest(coalesce(p_cashback_base, 0), 0);
  v_new_bonus_points := v_profile.bonus_points + v_cashback_points;

  insert into public.loyalty_transactions (
    tg_user_id, delta_points, kind, order_id, comment, created_at
  ) values (
    p_tg_user_id, v_cashback_points, 'order_cashback', p_order_id,
    format('%s%% cashback from order', v_percent), v_now
  );

  select coalesce(sum(coalesce(order_row.total_after_discount, order_row.total_price)), 0)
  into v_monthly_spent
  from public.orders order_row
  where order_row.tg_user_id = p_tg_user_id
    and order_row.status = 'done'
    and order_row.completed_at >= v_now - interval '30 days';

  v_earned_level := case
    when v_monthly_spent >= 10000 then 7
    when v_monthly_spent >= 5000 then 5
    when v_monthly_spent >= 3000 then 3
    else 0
  end;
  v_new_level := greatest(v_profile.current_cashback_level, v_earned_level);

  update public.customer_profiles
  set
    total_spent = v_new_total,
    monthly_spent = v_monthly_spent,
    bonus_points = v_new_bonus_points,
    current_cashback_level = v_new_level,
    last_order_date = v_completed_at,
    loyalty_expires_at = case when v_new_bonus_points > 0 then v_expires_at else null end,
    loyalty_notice_45_sent_at = null,
    loyalty_notice_59_sent_at = null,
    updated_at = v_now
  where tg_user_id = p_tg_user_id;

  return query select true, v_cashback_points, v_percent, v_new_total, v_new_bonus_points,
    case when v_new_bonus_points > 0 then v_expires_at else null end;
end;
$$;

-- This function now also removes a cashback status after 60 days without a
-- completed purchase. A manual credit can keep points alive, but not a tier.
create or replace function public.loyalty_expire_points(
  p_tg_user_id bigint
)
returns table (
  expired_points integer,
  bonus_points integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.customer_profiles%rowtype;
  v_expired_points integer := 0;
  v_points_expired boolean;
  v_status_expired boolean;
begin
  select * into v_profile
  from public.customer_profiles
  where tg_user_id = p_tg_user_id
  for update;
  if not found then
    raise exception 'loyalty profile % not found', p_tg_user_id using errcode = 'P0002';
  end if;

  v_points_expired := v_profile.bonus_points > 0
    and v_profile.loyalty_expires_at is not null
    and v_profile.loyalty_expires_at <= now();
  v_status_expired := v_profile.current_cashback_level > 0
    and (v_profile.last_order_date is null or v_profile.last_order_date <= now() - interval '60 days');

  if not v_points_expired and not v_status_expired then
    return query select 0, v_profile.bonus_points;
    return;
  end if;

  if v_points_expired then
    v_expired_points := v_profile.bonus_points;
    insert into public.loyalty_transactions (tg_user_id, delta_points, kind, comment, created_at)
    values (
      p_tg_user_id, -v_expired_points, 'points_expired',
      'Expired after 60 days without a successful order', now()
    );
  end if;

  update public.customer_profiles
  set
    bonus_points = case when v_points_expired then 0 else bonus_points end,
    loyalty_expires_at = case when v_points_expired then null else loyalty_expires_at end,
    loyalty_notice_45_sent_at = case when v_points_expired then null else loyalty_notice_45_sent_at end,
    loyalty_notice_59_sent_at = case when v_points_expired then null else loyalty_notice_59_sent_at end,
    current_cashback_level = case when v_status_expired then 0 else current_cashback_level end,
    monthly_spent = case when v_status_expired then 0 else monthly_spent end,
    updated_at = now()
  where tg_user_id = p_tg_user_id;

  return query select v_expired_points,
    case when v_points_expired then 0 else v_profile.bonus_points end;
end;
$$;

revoke all on function public.loyalty_apply_points_transaction(bigint, integer, text, uuid, bigint, text, boolean) from public;
revoke all on function public.loyalty_complete_order(bigint, uuid, numeric) from public;
revoke all on function public.loyalty_expire_points(bigint) from public;

notify pgrst, 'reload schema';
