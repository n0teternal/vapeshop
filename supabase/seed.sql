-- Minimal seed for local/manual testing (run AFTER schema.sql)

insert into public.cities (id, name, slug)
values
  (1, 'Vladivostok', 'vvo'),
  (2, 'Blagoveshchensk', 'blg')
on conflict (slug) do update
set name = excluded.name;

insert into public.products (id, title, description, category_slug, base_price, image_url, is_active)
values
  (
    '11111111-1111-1111-1111-111111111111',
    'Seed Product 1',
    'Demo product (Supabase seed)',
    'pods',
    490,
    null,
    true
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'Seed Product 2',
    'Demo product (Supabase seed)',
    'disposable',
    1590,
    null,
    true
  )
on conflict (id) do update
set
  title = excluded.title,
  description = excluded.description,
  category_slug = excluded.category_slug,
  base_price = excluded.base_price,
  image_url = excluded.image_url,
  is_active = excluded.is_active;

-- Inventory: per city per product. price_override demonstrates "effective price".
insert into public.inventory (product_id, city_id, in_stock, stock_qty, price_override)
values
  ('11111111-1111-1111-1111-111111111111', 1, true, 12, 450),
  ('11111111-1111-1111-1111-111111111111', 2, false, 0, null),
  ('22222222-2222-2222-2222-222222222222', 1, true, 5, null),
  ('22222222-2222-2222-2222-222222222222', 2, true, 8, 1490)
on conflict (product_id, city_id) do update
set
  in_stock = excluded.in_stock,
  stock_qty = excluded.stock_qty,
  price_override = excluded.price_override;
