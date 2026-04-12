-- Customer order editing support and discount totals backfill

alter table public.orders
  add column if not exists total_before_discount numeric,
  add column if not exists discount_amount numeric not null default 0,
  add column if not exists total_after_discount numeric,
  add column if not exists edited_at timestamptz,
  add column if not exists edit_session_expires_at timestamptz;

update public.orders
set total_before_discount = coalesce(total_before_discount, total_price),
    total_after_discount = coalesce(total_after_discount, total_price),
    discount_amount = coalesce(discount_amount, 0)
where total_before_discount is null
   or total_after_discount is null
   or discount_amount is null;
