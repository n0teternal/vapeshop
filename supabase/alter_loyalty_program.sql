-- Cashback loyalty program (run after the referral/profile migrations).
--
-- The ledger remains the audit log. `customer_profiles.bonus_points` is the
-- current balance, updated only through the functions below so that a retry or
-- two simultaneous requests cannot create a negative or duplicate balance.

alter table public.customer_profiles
  add column if not exists total_spent numeric not null default 0,
  add column if not exists bonus_points integer not null default 0,
  add column if not exists current_cashback_level integer not null default 0,
  add column if not exists last_order_date timestamptz null,
  add column if not exists loyalty_expires_at timestamptz null,
  add column if not exists loyalty_notice_45_sent_at timestamptz null,
  add column if not exists loyalty_notice_59_sent_at timestamptz null;

alter table public.loyalty_transactions
  add column if not exists comment text null;

alter table public.customer_profiles
  drop constraint if exists customer_profiles_bonus_points_nonnegative_check;

alter table public.customer_profiles
  add constraint customer_profiles_bonus_points_nonnegative_check
  check (bonus_points >= 0);

alter table public.customer_profiles
  drop constraint if exists customer_profiles_cashback_level_check;

alter table public.customer_profiles
  add constraint customer_profiles_cashback_level_check
  check (current_cashback_level in (0, 3, 5, 7));

-- One successful order can create exactly one cashback ledger record. A zero
-- amount is also recorded: it makes the successful order idempotent while the
-- customer is still below the first tier.
create unique index if not exists loyalty_order_cashback_unique_idx
  on public.loyalty_transactions (tg_user_id, kind, order_id)
  where order_id is not null and kind = 'order_cashback';

create index if not exists customer_profiles_loyalty_expiry_idx
  on public.customer_profiles (loyalty_expires_at)
  where bonus_points > 0 and loyalty_expires_at is not null;

-- Populate the new read model from data that already exists in the project.
-- Historical cashback itself is intentionally not invented for old orders;
-- only existing ledger entries are carried into the initial balance.
with done_orders as (
  select
    tg_user_id,
    coalesce(sum(coalesce(total_after_discount, total_price)), 0) as total_spent,
    max(created_at) as last_order_date
  from public.orders
  where status = 'done'
  group by tg_user_id
), ledger as (
  select
    tg_user_id,
    greatest(coalesce(sum(delta_points), 0), 0)::integer as bonus_points,
    max(created_at) filter (where delta_points > 0) as last_credit_date
  from public.loyalty_transactions
  group by tg_user_id
)
update public.customer_profiles profile
set
  total_spent = coalesce(done_orders.total_spent, 0),
  current_cashback_level = case
    when coalesce(done_orders.total_spent, 0) >= 10000 then 7
    when coalesce(done_orders.total_spent, 0) >= 5000 then 5
    when coalesce(done_orders.total_spent, 0) >= 3000 then 3
    else 0
  end,
  bonus_points = coalesce(ledger.bonus_points, 0),
  last_order_date = done_orders.last_order_date,
  loyalty_expires_at = case
    when coalesce(ledger.bonus_points, 0) <= 0 then null
    when done_orders.last_order_date is not null then done_orders.last_order_date + interval '60 days'
    when ledger.last_credit_date is not null then ledger.last_credit_date + interval '60 days'
    else null
  end
from done_orders
full outer join ledger using (tg_user_id)
where profile.tg_user_id = coalesce(done_orders.tg_user_id, ledger.tg_user_id);

-- Every positive/negative manual or referral operation goes through this
-- function. It locks the customer row, writes the ledger, and changes the
-- cached balance in one database transaction.
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

  -- A customer cannot keep or spend a balance merely because the scheduled
  -- worker was delayed. Every mutation enforces the 60-day deadline too.
  if v_profile.bonus_points > 0
    and v_profile.loyalty_expires_at is not null
    and v_profile.loyalty_expires_at <= v_now then
    insert into public.loyalty_transactions (
      tg_user_id, delta_points, kind, comment, created_at
    ) values (
      p_tg_user_id, -v_profile.bonus_points, 'points_expired',
      'Expired after 60 days without a successful order', v_now
    );
    update public.customer_profiles
    set bonus_points = 0, loyalty_expires_at = null, updated_at = v_now
    where tg_user_id = p_tg_user_id;
    v_profile.bonus_points := 0;
    v_profile.loyalty_expires_at := null;
  end if;

  -- Referral calls are retried safely after a webhook retry.
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
    last_order_date = case when p_reset_expiry then v_now else last_order_date end,
    loyalty_expires_at = case when v_next_points = 0 then null else v_expires_at end,
    loyalty_notice_45_sent_at = case when p_reset_expiry then null else loyalty_notice_45_sent_at end,
    loyalty_notice_59_sent_at = case when p_reset_expiry then null else loyalty_notice_59_sent_at end,
    updated_at = v_now
  where tg_user_id = p_tg_user_id;

  return query select true, v_next_points, case when v_next_points = 0 then null else v_expires_at end;
end;
$$;

-- Keeps the single order write-off row in sync while an unfinalized order is
-- edited. The function also restores the balance when the write-off decreases.
create or replace function public.loyalty_set_order_points_spend(
  p_tg_user_id bigint,
  p_order_id uuid,
  p_points_to_spend integer
)
returns table (
  previous_points integer,
  points_to_spend integer,
  bonus_points integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.customer_profiles%rowtype;
  v_transaction public.loyalty_transactions%rowtype;
  v_previous_points integer := 0;
  v_requested_points integer := greatest(coalesce(p_points_to_spend, 0), 0);
  v_next_points integer;
begin
  select * into v_profile
  from public.customer_profiles
  where tg_user_id = p_tg_user_id
  for update;
  if not found then
    raise exception 'loyalty profile % not found', p_tg_user_id using errcode = 'P0002';
  end if;

  if v_profile.bonus_points > 0
    and v_profile.loyalty_expires_at is not null
    and v_profile.loyalty_expires_at <= now() then
    insert into public.loyalty_transactions (
      tg_user_id, delta_points, kind, comment, created_at
    ) values (
      p_tg_user_id, -v_profile.bonus_points, 'points_expired',
      'Expired after 60 days without a successful order', now()
    );
    update public.customer_profiles
    set bonus_points = 0, loyalty_expires_at = null, updated_at = now()
    where tg_user_id = p_tg_user_id;
    v_profile.bonus_points := 0;
    v_profile.loyalty_expires_at := null;
  end if;

  select * into v_transaction
  from public.loyalty_transactions
  where tg_user_id = p_tg_user_id
    and kind = 'order_points_spend'
    and order_id = p_order_id
  for update;

  if found then
    v_previous_points := greatest(-v_transaction.delta_points, 0);
  end if;

  v_next_points := v_profile.bonus_points + v_previous_points - v_requested_points;
  if v_next_points < 0 then
    raise exception 'not enough loyalty points' using errcode = 'P0001';
  end if;

  if found and v_requested_points = 0 then
    delete from public.loyalty_transactions where id = v_transaction.id;
  elsif found then
    update public.loyalty_transactions
    set delta_points = -v_requested_points
    where id = v_transaction.id;
  elsif v_requested_points > 0 then
    insert into public.loyalty_transactions (tg_user_id, delta_points, kind, order_id, created_at)
    values (p_tg_user_id, -v_requested_points, 'order_points_spend', p_order_id, now());
  end if;

  update public.customer_profiles
  set
    bonus_points = v_next_points,
    loyalty_expires_at = case when v_next_points = 0 then null else loyalty_expires_at end,
    updated_at = now()
  where tg_user_id = p_tg_user_id;

  return query select v_previous_points, v_requested_points, v_next_points;
end;
$$;

-- Called only after an order becomes `done`. The record with kind
-- `order_cashback` makes the operation idempotent even when the order-status
-- webhook is delivered more than once.
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
  v_percent integer;
  v_cashback_points integer;
  v_new_total numeric;
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

  if v_profile.bonus_points > 0
    and v_profile.loyalty_expires_at is not null
    and v_profile.loyalty_expires_at <= v_now then
    insert into public.loyalty_transactions (
      tg_user_id, delta_points, kind, comment, created_at
    ) values (
      p_tg_user_id, -v_profile.bonus_points, 'points_expired',
      'Expired after 60 days without a successful order', v_now
    );
    update public.customer_profiles
    set bonus_points = 0, loyalty_expires_at = null, updated_at = v_now
    where tg_user_id = p_tg_user_id;
    v_profile.bonus_points := 0;
    v_profile.loyalty_expires_at := null;
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
      case
        when v_profile.total_spent >= 10000 then 7
        when v_profile.total_spent >= 5000 then 5
        when v_profile.total_spent >= 3000 then 3
        else 0
      end,
      v_profile.total_spent,
      v_profile.bonus_points,
      v_profile.loyalty_expires_at;
    return;
  end if;

  v_percent := case
    when v_profile.total_spent >= 10000 then 7
    when v_profile.total_spent >= 5000 then 5
    when v_profile.total_spent >= 3000 then 3
    else 0
  end;
  v_cashback_points := round(greatest(coalesce(p_cashback_base, 0), 0) * v_percent / 100.0)::integer;
  v_new_total := v_profile.total_spent + greatest(coalesce(p_cashback_base, 0), 0);
  v_new_level := case
    when v_new_total >= 10000 then 7
    when v_new_total >= 5000 then 5
    when v_new_total >= 3000 then 3
    else 0
  end;
  v_new_bonus_points := v_profile.bonus_points + v_cashback_points;

  insert into public.loyalty_transactions (
    tg_user_id, delta_points, kind, order_id, comment, created_at
  ) values (
    p_tg_user_id, v_cashback_points, 'order_cashback', p_order_id,
    format('%s%% cashback from order', v_percent), v_now
  );

  update public.customer_profiles
  set
    total_spent = v_new_total,
    bonus_points = v_new_bonus_points,
    current_cashback_level = v_new_level,
    last_order_date = v_now,
    loyalty_expires_at = case when v_new_bonus_points > 0 then v_expires_at else null end,
    loyalty_notice_45_sent_at = null,
    loyalty_notice_59_sent_at = null,
    updated_at = v_now
  where tg_user_id = p_tg_user_id;

  return query select true, v_cashback_points, v_percent, v_new_total, v_new_bonus_points,
    case when v_new_bonus_points > 0 then v_expires_at else null end;
end;
$$;

-- The daily worker calls this on expired profiles. The row lock protects
-- against a simultaneous successful order resetting the expiry timer.
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
  v_expired_points integer;
begin
  select * into v_profile
  from public.customer_profiles
  where tg_user_id = p_tg_user_id
  for update;
  if not found then
    raise exception 'loyalty profile % not found', p_tg_user_id using errcode = 'P0002';
  end if;

  if v_profile.bonus_points <= 0
    or v_profile.loyalty_expires_at is null
    or v_profile.loyalty_expires_at > now() then
    return query select 0, v_profile.bonus_points;
    return;
  end if;

  v_expired_points := v_profile.bonus_points;
  insert into public.loyalty_transactions (
    tg_user_id, delta_points, kind, comment, created_at
  ) values (
    p_tg_user_id, -v_expired_points, 'points_expired', 'Expired after 60 days without a successful order', now()
  );

  update public.customer_profiles
  set
    bonus_points = 0,
    loyalty_expires_at = null,
    updated_at = now()
  where tg_user_id = p_tg_user_id;

  return query select v_expired_points, 0;
end;
$$;

revoke all on function public.loyalty_apply_points_transaction(bigint, integer, text, uuid, bigint, text, boolean) from public;
revoke all on function public.loyalty_set_order_points_spend(bigint, uuid, integer) from public;
revoke all on function public.loyalty_complete_order(bigint, uuid, numeric) from public;
revoke all on function public.loyalty_expire_points(bigint) from public;

notify pgrst, 'reload schema';
