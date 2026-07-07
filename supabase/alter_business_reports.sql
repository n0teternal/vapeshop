-- Business report support:
-- links a completed order to an applied coupon/promo-code when that flow is enabled.

alter table public.orders
  add column if not exists coupon_id text null;

create index if not exists orders_coupon_id_idx
  on public.orders (coupon_id)
  where coupon_id is not null;

notify pgrst, 'reload schema';
