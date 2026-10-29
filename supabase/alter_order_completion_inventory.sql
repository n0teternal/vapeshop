-- Finish an order against the inventory already reserved at checkout.
-- Apply after alter_staff_inventory.sql and alter_order_inventory_reservations.sql,
-- then deploy the API.

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
  v_staff_row_found boolean;
  v_required_staff_qty integer;
  v_deduct_staff_qty integer;
  v_has_stock_items boolean := false;
begin
  -- Serialize duplicate completion attempts and cancellation/status changes.
  select *
    into v_order
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

  if exists (
    select 1
      from public.order_items
     where order_id = p_order_id
       and product_id is not null
       and qty <= 0
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER_ITEM_QTY';
  end if;

  -- Aggregate duplicate order lines before joining reservations, so a repeated
  -- product line cannot multiply its reserved quantity.
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
           coalesce(reservation.qty, 0) as reserved_qty
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

    -- Checkout already removed reserved units from city inventory. Only any
    -- uncovered remainder must still be available in the selected seller's
    -- stock. A seller allocation is consumed when present, but it is not
    -- required a second time for units the order already reserved.
    v_required_staff_qty := greatest(
      0,
      v_line.qty - least(v_line.reserved_qty, v_line.qty)
    );

    select stock_qty
      into v_staff_qty
      from public.staff_inventory
     where staff_id = p_staff_id
       and city_id = v_order.city_id
       and product_id = v_line.product_id
     for update;
    v_staff_row_found := found;
    if not v_staff_row_found then
      v_staff_qty := 0;
    end if;

    if v_staff_qty < v_required_staff_qty then
      raise exception using errcode = 'P0001', message = 'STAFF_OUT_OF_STOCK';
    end if;

    v_deduct_staff_qty := least(v_staff_qty, v_line.qty);
    if v_staff_row_found and v_deduct_staff_qty > 0 then
      update public.staff_inventory
         set stock_qty = stock_qty - v_deduct_staff_qty
       where staff_id = p_staff_id
         and city_id = v_order.city_id
         and product_id = v_line.product_id
         and stock_qty = v_staff_qty;

      if not found then
        raise exception using errcode = 'P0001', message = 'STAFF_STOCK_CONFLICT';
      end if;
    end if;

    insert into public.inventory_movements (
      city_id,
      staff_id,
      product_id,
      kind,
      qty,
      order_id
    ) values (
      v_order.city_id,
      p_staff_id,
      v_line.product_id,
      'sale',
      v_line.qty,
      p_order_id
    );
  end loop;

  if not v_has_stock_items then
    raise exception using errcode = 'P0001', message = 'ORDER_NO_STOCK_ITEMS';
  end if;

  update public.orders
     set status = 'done',
         seller_id = p_staff_id,
         payment_method = p_payment_method
   where id = p_order_id
     and status = v_order.status;

  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_COMPLETION_CONFLICT';
  end if;

  return true;
end;
$$;

revoke all on function public.complete_order_with_staff_sale(uuid, bigint, text) from public;
grant execute on function public.complete_order_with_staff_sale(uuid, bigint, text) to service_role;

notify pgrst, 'reload schema';
