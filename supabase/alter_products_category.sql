-- Run this on an existing DB to enable category filtering from DB.

alter table public.products
  add column if not exists category_slug text;

update public.products
set category_slug = 'other'
where category_slug is null
   or btrim(category_slug) = '';

alter table public.products
  alter column category_slug set default 'other';

alter table public.products
  alter column category_slug set not null;

create index if not exists products_category_slug_idx
  on public.products (category_slug);

-- Optional: examples
-- update public.products set category_slug = 'pods' where id = '...';
-- update public.products set category_slug = 'disposable' where id = '...';
