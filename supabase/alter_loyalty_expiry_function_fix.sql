-- Fix ambiguous output-column references in loyalty_expire_points.
-- Apply after alter_loyalty_monthly_tiers.sql.

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

  update public.customer_profiles as profile
  set
    bonus_points = case when v_points_expired then 0 else profile.bonus_points end,
    loyalty_expires_at = case when v_points_expired then null else profile.loyalty_expires_at end,
    loyalty_notice_45_sent_at = case when v_points_expired then null else profile.loyalty_notice_45_sent_at end,
    loyalty_notice_59_sent_at = case when v_points_expired then null else profile.loyalty_notice_59_sent_at end,
    current_cashback_level = case when v_status_expired then 0 else profile.current_cashback_level end,
    monthly_spent = case when v_status_expired then 0 else profile.monthly_spent end,
    updated_at = now()
  where profile.tg_user_id = p_tg_user_id;

  return query select v_expired_points,
    case when v_points_expired then 0 else v_profile.bonus_points end;
end;
$$;

revoke all on function public.loyalty_expire_points(bigint) from public;
grant execute on function public.loyalty_expire_points(bigint) to service_role;

notify pgrst, 'reload schema';
