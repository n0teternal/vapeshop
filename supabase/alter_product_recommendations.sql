-- Product recommendations from successful (done) orders only.
--
-- The function exposes no order history to the browser. The API service role
-- uses the signals to rank products that are currently sellable in the chosen
-- city. Product popularity is counted by sold quantity across the store;
-- personal affinities use every completed order of the current customer.

create index if not exists order_items_product_order_idx
  on public.order_items (product_id, order_id)
  where product_id is not null;

create or replace function public.get_product_recommendation_signals(
  p_city_slug text,
  p_tg_user_id bigint default null
)
returns table (
  product_id uuid,
  popularity_qty bigint,
  personal_product_qty bigint,
  personal_category_qty bigint,
  personal_last_bought_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with target_city as (
    select id
      from public.cities
     where slug = p_city_slug
  ),
  eligible_products as (
    select inventory.product_id, products.category_slug
      from public.inventory inventory
      join target_city city on city.id = inventory.city_id
      join public.products products on products.id = inventory.product_id
     where inventory.in_stock = true
       and (inventory.stock_qty is null or inventory.stock_qty > 0)
       and products.is_active = true
  ),
  global_product_sales as (
    select order_items.product_id, sum(order_items.qty)::bigint as qty
      from eligible_products eligible_products
      join public.order_items order_items
        on order_items.product_id = eligible_products.product_id
      join public.orders orders on orders.id = order_items.order_id
     where orders.status = 'done'
     group by order_items.product_id
  ),
  personal_orders as (
    select orders.id, coalesce(orders.completed_at, orders.created_at) as completed_at
      from public.orders orders
     where orders.status = 'done'
       and orders.tg_user_id = p_tg_user_id
  ),
  personal_product_sales as (
    select order_items.product_id,
           sum(order_items.qty)::bigint as qty,
           max(personal_orders.completed_at) as last_bought_at
      from public.order_items order_items
      join personal_orders on personal_orders.id = order_items.order_id
     where order_items.product_id is not null
     group by order_items.product_id
  ),
  personal_category_sales as (
    select products.category_slug, sum(order_items.qty)::bigint as qty
      from public.order_items order_items
      join personal_orders on personal_orders.id = order_items.order_id
      join public.products products on products.id = order_items.product_id
     where order_items.product_id is not null
     group by products.category_slug
  )
  select eligible_products.product_id,
         coalesce(global_product_sales.qty, 0)::bigint as popularity_qty,
         coalesce(personal_product_sales.qty, 0)::bigint as personal_product_qty,
         coalesce(personal_category_sales.qty, 0)::bigint as personal_category_qty,
         personal_product_sales.last_bought_at as personal_last_bought_at
    from eligible_products
    left join global_product_sales
      on global_product_sales.product_id = eligible_products.product_id
    left join personal_product_sales
      on personal_product_sales.product_id = eligible_products.product_id
    left join personal_category_sales
      on personal_category_sales.category_slug = eligible_products.category_slug;
$$;

revoke all on function public.get_product_recommendation_signals(text, bigint)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
