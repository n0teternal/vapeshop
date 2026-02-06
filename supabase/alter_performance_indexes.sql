-- Apply on existing projects to speed up admin queries.
-- Safe to re-run (IF NOT EXISTS).

create index if not exists orders_status_created_at_idx
  on public.orders (status, created_at desc);

create index if not exists order_items_order_id_idx
  on public.order_items (order_id);
