-- Track the exact finite-stock quantities reserved by each order.
-- Run once in the Supabase SQL Editor before deploying the matching API change.
-- Existing orders deliberately start without rows: cancelling a legacy order must
-- never add stock that was not reserved from the inventory table.

create table if not exists public.order_inventory_reservations (
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  qty int not null check (qty > 0),
  created_at timestamptz not null default now(),
  primary key (order_id, product_id)
);

create index if not exists order_inventory_reservations_order_idx
  on public.order_inventory_reservations (order_id);

revoke all on public.order_inventory_reservations from anon, authenticated;

alter table public.order_inventory_reservations enable row level security;

notify pgrst, 'reload schema';
