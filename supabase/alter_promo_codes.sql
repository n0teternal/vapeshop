-- Global promo codes managed from the admin panel.

create table if not exists public.promo_codes (
  code text primary key,
  discount_amount numeric not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  max_uses int not null,
  used_count int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (btrim(code) <> ''),
  check (discount_amount > 0),
  check (max_uses > 0),
  check (used_count >= 0),
  check (used_count <= max_uses),
  check (ends_at >= starts_at)
);

alter table public.orders
  add column if not exists coupon_id text null,
  add column if not exists coupon_discount_amount numeric not null default 0;

create index if not exists promo_codes_active_window_idx
  on public.promo_codes (is_active, starts_at, ends_at, code);

create index if not exists orders_coupon_id_idx
  on public.orders (coupon_id)
  where coupon_id is not null;

revoke all on public.promo_codes from anon, authenticated;
alter table public.promo_codes enable row level security;

notify pgrst, 'reload schema';
