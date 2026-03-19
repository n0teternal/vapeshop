-- Allow cancelled orders in existing DBs.
-- Run this in Supabase SQL Editor for already deployed projects.

alter table public.orders
  drop constraint if exists orders_status_check;

alter table public.orders
  add constraint orders_status_check
  check (status in ('new', 'processing', 'done', 'cancelled'));
