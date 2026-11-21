-- Inventory integrity hardening.
--
-- Apply this AFTER:
--   alter_staff_inventory.sql
--   alter_order_inventory_reservations.sql
--   alter_order_completion_inventory.sql
--
-- It closes three race/consistency gaps:
--   * a reserved order could be completed by a staff member who did not have
--     the actual goods;
--   * two simultaneous cancellation requests could each return the same
--     reservation to city stock;
--   * concurrent staff issues were calculated outside one DB transaction.
--   * a legacy order without a reservation could be marked done without
--     reducing the city stock.

-- An explicit ledger makes the legacy repair idempotent and records the
-- unreserved part that was consumed when an order was completed.
create table if not exists public.order_inventory_completion_adjustments (
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  qty int not null check (qty > 0),
  source text not null check (source in ('completion', 'legacy_reconcile')),
  created_at timestamptz not null default now(),
  primary key (order_id, product_id)
);

alter table public.order_inventory_completion_adjustments enable row level security;
revoke all on public.order_inventory_completion_adjustments from anon, authenticated;

create or replace function public.complete_order_with_staff_sale(
  p_order_id uuid,
  p_staff_id bigint,
  p_payment_method text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_order public.orders%rowtype;
  v_line record;
  v_staff_qty integer;
  v_city_qty integer;
  v_unreserved_qty integer;
  v_has_stock_items boolean := false;
begin
  -- One transaction owns the final state transition and the seller balances.
  select * into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'ORDER_NOT_FOUND';
  end if;
  if v_order.status = 'done' then
    if v_order.seller_id = p_staff_id and v_order.payment_method = p_payment_method then
      return false;
    end if;
    raise exception using errcode = 'P0001', message = 'ORDER_FINAL';
  end if;
  if v_order.status = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'ORDER_FINAL';
  end if;
  if v_order.status not in ('new', 'processing') then
    raise exception using errcode = 'P0001', message = 'ORDER_COMPLETION_CONFLICT';
  end if;
  if v_order.edit_session_expires_at is not null and v_order.edit_session_expires_at > now() then
    raise exception using errcode = 'P0001', message = 'ORDER_EDIT_IN_PROGRESS';
  end if;
  if v_order.city_id is null then
    raise exception using errcode = 'P0001', message = 'ORDER_CITY_MISSING';
  end if;
  if p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception using errcode = 'P0001', message = 'INVALID_PAYMENT_METHOD';
  end if;

  perform 1
    from public.staff_members
   where id = p_staff_id
     and is_active = true
   for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'STAFF_UNAVAILABLE';
  end if;

  -- Aggregate repeated lines.  A city reservation only promises the customer
  -- the item; it never substitutes the item physically held by this seller.
  for v_line in
    with line_items as (
      select product_id, sum(qty)::integer as qty
        from public.order_items
       where order_id = p_order_id
         and product_id is not null
       group by product_id
    )
    select line_items.product_id,
           line_items.qty,
           coalesce(reservation.qty, 0)::integer as reserved_qty
      from line_items
      left join public.order_inventory_reservations as reservation
        on reservation.order_id = p_order_id
       and reservation.product_id = line_items.product_id
     order by line_items.product_id
  loop
    v_has_stock_items := true;
    if v_line.qty <= 0 then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER_ITEM_QTY';
    end if;

    select stock_qty into v_staff_qty
      from public.staff_inventory
     where staff_id = p_staff_id
       and city_id = v_order.city_id
       and product_id = v_line.product_id
     for update;

    if not found or v_staff_qty < v_line.qty then
      raise exception using errcode = 'P0001', message = 'STAFF_OUT_OF_STOCK';
    end if;

    update public.staff_inventory
       set stock_qty = stock_qty - v_line.qty
     where staff_id = p_staff_id
       and city_id = v_order.city_id
       and product_id = v_line.product_id
       and stock_qty = v_staff_qty;
    if not found then
      raise exception using errcode = 'P0001', message = 'STAFF_STOCK_CONFLICT';
    end if;

    -- Current orders reserve finite stock at checkout, so there is no second
    -- city deduction at completion.  Old orders sometimes have no reservation
    -- row; deduct only that uncovered part here.  The adjustment row ensures
    -- the later repair job and retries cannot deduct it a second time.
    v_unreserved_qty := greatest(0, v_line.qty - least(v_line.reserved_qty, v_line.qty));
    if v_unreserved_qty > 0 then
      select stock_qty into v_city_qty
        from public.inventory
       where city_id = v_order.city_id
         and product_id = v_line.product_id
       for update;
      if not found then
        raise exception using errcode = 'P0001', message = 'INVENTORY_MISSING';
      end if;

      if v_city_qty is not null then
        update public.inventory
           set stock_qty = greatest(0, stock_qty - v_unreserved_qty),
               in_stock = stock_qty > v_unreserved_qty
         where city_id = v_order.city_id
           and product_id = v_line.product_id;
      end if;

      insert into public.order_inventory_completion_adjustments (
        order_id, product_id, qty, source
      ) values (
        p_order_id, v_line.product_id, v_unreserved_qty, 'completion'
      ) on conflict (order_id, product_id) do nothing;
    end if;

    insert into public.inventory_movements (
      city_id, staff_id, product_id, kind, qty, order_id
    ) values (
      v_order.city_id, p_staff_id, v_line.product_id, 'sale', v_line.qty, p_order_id
    );
  end loop;

  if not v_has_stock_items then
    raise exception using errcode = 'P0001', message = 'ORDER_NO_STOCK_ITEMS';
  end if;

  update public.orders
     set status = 'done', seller_id = p_staff_id, payment_method = p_payment_method
   where id = p_order_id
     and status = v_order.status;
  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_COMPLETION_CONFLICT';
  end if;

  return true;
end;
$$;

-- Repair historical completed sales created before per-order reservations were
-- introduced.  The predicate deliberately requires an existing `sale`
-- movement, so direct/manual status changes are never guessed or changed.
-- `greatest(0, ...)` is intentional: an already-zero city balance stays zero
-- instead of becoming negative. Every processed line is recorded above, so
-- rerunning this function is safe.
create or replace function public.reconcile_legacy_completed_order_inventory()
returns table (
  order_id uuid,
  product_id uuid,
  sale_qty integer,
  city_qty_deducted integer
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_sale record;
  v_city_qty integer;
  v_deducted integer;
begin
  for v_sale in
    select movement.order_id,
           movement.product_id,
           sum(movement.qty)::integer as qty
      from public.inventory_movements as movement
      join public.orders as order_row on order_row.id = movement.order_id
      left join public.order_inventory_reservations as reservation
        on reservation.order_id = movement.order_id
       and reservation.product_id = movement.product_id
      left join public.order_inventory_completion_adjustments as adjustment
        on adjustment.order_id = movement.order_id
       and adjustment.product_id = movement.product_id
     where movement.kind = 'sale'
       and movement.order_id is not null
       and order_row.status = 'done'
       and reservation.order_id is null
       and adjustment.order_id is null
     group by movement.order_id, movement.product_id
     order by movement.order_id, movement.product_id
  loop
    select inventory.stock_qty into v_city_qty
      from public.inventory as inventory
     where inventory.city_id = (
             select city_id from public.orders where id = v_sale.order_id
           )
       and inventory.product_id = v_sale.product_id
     for update;

    if not found then
      -- Preserve the missing-row case for manual review; it is unsafe to
      -- invent a city inventory row from a historical sale.
      continue;
    end if;

    v_deducted := case
      when v_city_qty is null then 0
      else least(v_city_qty, v_sale.qty)
    end;
    if v_city_qty is not null then
      update public.inventory as inventory
         set stock_qty = inventory.stock_qty - v_deducted,
             in_stock = inventory.stock_qty > v_deducted
       where inventory.city_id = (
               select city_id from public.orders where id = v_sale.order_id
             )
         and inventory.product_id = v_sale.product_id;
    end if;

    insert into public.order_inventory_completion_adjustments (
      order_id, product_id, qty, source
    ) values (
      v_sale.order_id, v_sale.product_id, v_sale.qty, 'legacy_reconcile'
    );

    order_id := v_sale.order_id;
    product_id := v_sale.product_id;
    sale_qty := v_sale.qty;
    city_qty_deducted := v_deducted;
    return next;
  end loop;
end;
$$;

-- Apply the repair once as part of this migration. Its ledger makes a later
-- manual rerun a no-op for lines that were already processed.
select * from public.reconcile_legacy_completed_order_inventory();

-- Cancellation and return of a finite-stock reservation must be one atomic
-- operation.  In particular, this function locks the order before reading its
-- reservation rows, so repeated Telegram callbacks cannot return it twice.
create or replace function public.cancel_order_and_restore_inventory(
  p_order_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_order public.orders%rowtype;
  v_reservation record;
  v_stock_qty integer;
begin
  select * into v_order
    from public.orders
   where id = p_order_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'ORDER_NOT_FOUND';
  end if;
  if v_order.status = 'cancelled' then
    return false;
  end if;
  if v_order.status = 'done' then
    raise exception using errcode = 'P0001', message = 'ORDER_FINAL';
  end if;
  if v_order.edit_session_expires_at is not null and v_order.edit_session_expires_at > now() then
    raise exception using errcode = 'P0001', message = 'ORDER_EDIT_IN_PROGRESS';
  end if;

  if v_order.city_id is not null then
    for v_reservation in
      select product_id, qty
        from public.order_inventory_reservations
       where order_id = p_order_id
       order by product_id
    loop
      select stock_qty into v_stock_qty
        from public.inventory
       where city_id = v_order.city_id
         and product_id = v_reservation.product_id
       for update;

      if not found then
        raise exception using errcode = 'P0001', message = 'INVENTORY_MISSING';
      end if;

      -- A null quantity deliberately means unlimited/manual inventory.  Do
      -- not manufacture a finite quantity from an old reservation in that
      -- case.
      if v_stock_qty is not null then
        update public.inventory
           set stock_qty = stock_qty + v_reservation.qty,
               in_stock = true
         where city_id = v_order.city_id
           and product_id = v_reservation.product_id;
      end if;
    end loop;
  end if;

  update public.orders
     set status = 'cancelled'
   where id = p_order_id
     and status = v_order.status;
  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_CANCELLATION_CONFLICT';
  end if;

  return true;
end;
$$;

-- Serialize increases of staff stock through the city-product row.  This
-- avoids two admin/bot actions independently seeing the same free quantity.
create or replace function public.issue_stock_to_staff(
  p_city_id bigint,
  p_staff_id bigint,
  p_product_id uuid,
  p_qty integer,
  p_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_city_stock integer;
  v_city_in_stock boolean;
  v_allocated integer;
  v_reserved integer;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_STOCK_QTY';
  end if;

  perform 1 from public.staff_members where id = p_staff_id and is_active = true for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'STAFF_UNAVAILABLE';
  end if;

  select stock_qty, in_stock into v_city_stock, v_city_in_stock
    from public.inventory
   where city_id = p_city_id and product_id = p_product_id
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'INVENTORY_MISSING';
  end if;
  if not v_city_in_stock then
    raise exception using errcode = 'P0001', message = 'OUT_OF_STOCK';
  end if;

  select coalesce(sum(stock_qty), 0) into v_allocated
    from public.staff_inventory
   where city_id = p_city_id and product_id = p_product_id;

  -- stock_qty is the currently free city amount: checkout has already
  -- subtracted active reservations from it. Add them back only for this
  -- physical-allocation check, otherwise moving an item from one employee to
  -- another would fail whenever an order is awaiting completion.
  select coalesce(sum(reservation.qty), 0) into v_reserved
    from public.order_inventory_reservations as reservation
    join public.orders as order_row on order_row.id = reservation.order_id
   where reservation.product_id = p_product_id
     and order_row.city_id = p_city_id
     and order_row.status in ('new', 'processing');
  if v_city_stock is not null and v_allocated + p_qty > v_city_stock + v_reserved then
    raise exception using errcode = 'P0001', message = 'STAFF_STOCK_EXCEEDS_CITY';
  end if;

  insert into public.staff_inventory (city_id, staff_id, product_id, stock_qty)
  values (p_city_id, p_staff_id, p_product_id, p_qty)
  on conflict (staff_id, city_id, product_id)
  do update set stock_qty = public.staff_inventory.stock_qty + excluded.stock_qty;

  insert into public.inventory_movements (city_id, staff_id, product_id, kind, qty, note)
  values (p_city_id, p_staff_id, p_product_id, 'inbound', p_qty, nullif(btrim(p_note), ''));
  return true;
end;
$$;

revoke all on function public.complete_order_with_staff_sale(uuid, bigint, text) from public;
revoke all on function public.cancel_order_and_restore_inventory(uuid) from public;
revoke all on function public.issue_stock_to_staff(bigint, bigint, uuid, integer, text) from public;
revoke all on function public.reconcile_legacy_completed_order_inventory() from public;
grant execute on function public.complete_order_with_staff_sale(uuid, bigint, text) to service_role;
grant execute on function public.cancel_order_and_restore_inventory(uuid) to service_role;
grant execute on function public.issue_stock_to_staff(bigint, bigint, uuid, integer, text) to service_role;
grant execute on function public.reconcile_legacy_completed_order_inventory() to service_role;

notify pgrst, 'reload schema';
