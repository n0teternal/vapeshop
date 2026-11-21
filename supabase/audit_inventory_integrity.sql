-- Read-only inventory audit.
-- Run in Supabase SQL Editor after alter_inventory_integrity.sql to inspect
-- existing data. None of these queries changes a row.

-- 1. Physical stock must cover the total quantity currently allocated to
-- staff. `inventory.stock_qty` is the free city amount; active reservations
-- have already been subtracted from it, so they are added back here.
with active_reservations as (
  select
    order_row.city_id,
    reservation.product_id,
    sum(reservation.qty)::integer as qty
  from public.order_inventory_reservations as reservation
  join public.orders as order_row on order_row.id = reservation.order_id
  where order_row.status in ('new', 'processing')
  group by order_row.city_id, reservation.product_id
), staff_totals as (
  select city_id, product_id, sum(stock_qty)::integer as qty
  from public.staff_inventory
  group by city_id, product_id
)
select
  city.slug as city_slug,
  product.id as product_id,
  product.title,
  inventory.stock_qty as free_city_qty,
  coalesce(active_reservations.qty, 0) as reserved_qty,
  coalesce(staff_totals.qty, 0) as staff_qty,
  inventory.stock_qty + coalesce(active_reservations.qty, 0) as physical_qty
from public.inventory as inventory
join public.cities as city on city.id = inventory.city_id
join public.products as product on product.id = inventory.product_id
left join active_reservations
  on active_reservations.city_id = inventory.city_id
 and active_reservations.product_id = inventory.product_id
left join staff_totals
  on staff_totals.city_id = inventory.city_id
 and staff_totals.product_id = inventory.product_id
where inventory.stock_qty is not null
  and inventory.stock_qty + coalesce(active_reservations.qty, 0) < coalesce(staff_totals.qty, 0)
order by city.slug, product.title;

-- 2. These products use an unlimited quantity (stock_qty is NULL) while being
-- shown as available. This can be intentional, but is the first list to
-- inspect when an item appears available without a counted balance.
select city.slug as city_slug, product.id as product_id, product.title
from public.inventory as inventory
join public.cities as city on city.id = inventory.city_id
join public.products as product on product.id = inventory.product_id
where inventory.in_stock = true
  and inventory.stock_qty is null
order by city.slug, product.title;

-- 3. An active finite-stock order should have a reservation matching every
-- product line. Legacy orders created before reservations existed are shown so
-- they can be reviewed manually; do not create reservations retroactively.
with line_items as (
  select order_id, product_id, sum(qty)::integer as qty
  from public.order_items
  where product_id is not null
  group by order_id, product_id
), reservations as (
  select order_id, product_id, sum(qty)::integer as qty
  from public.order_inventory_reservations
  group by order_id, product_id
)
select
  order_row.id as order_id,
  city.slug as city_slug,
  product.title,
  line_items.qty as ordered_qty,
  coalesce(reservations.qty, 0) as reserved_qty
from public.orders as order_row
join line_items on line_items.order_id = order_row.id
join public.products as product on product.id = line_items.product_id
join public.inventory as inventory
  on inventory.city_id = order_row.city_id
 and inventory.product_id = line_items.product_id
left join public.cities as city on city.id = order_row.city_id
left join reservations
  on reservations.order_id = line_items.order_id
 and reservations.product_id = line_items.product_id
where order_row.status in ('new', 'processing')
  and inventory.stock_qty is not null
  and line_items.qty <> coalesce(reservations.qty, 0)
order by order_row.created_at, order_row.id, product.title;

-- 4. This should normally return no rows after the integrity migration. A row
-- means an old confirmed sale has neither a checkout reservation nor an
-- adjustment marker, usually because its city inventory row was missing and
-- the automatic repair safely skipped it.
select
  movement.order_id,
  city.slug as city_slug,
  product.id as product_id,
  product.title,
  sum(movement.qty)::integer as sale_qty
from public.inventory_movements as movement
join public.orders as order_row on order_row.id = movement.order_id
join public.products as product on product.id = movement.product_id
left join public.cities as city on city.id = order_row.city_id
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
group by movement.order_id, city.slug, product.id, product.title
order by movement.order_id, product.title;
