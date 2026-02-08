# Backend: структура таблиц каталога (с фильтрацией по категориям)

Документ фиксирует поля БД, которые использует backend/frontend для каталога, наличия и фильтрации по категориям.

## `public.products`
| Поле | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `uuid` | no | ID товара |
| `title` | `text` | no | Название |
| `description` | `text` | yes | Описание |
| `category_slug` | `text` | no | Категория для фильтрации (`pods`, `disposable`, `liquid` и т.д.) |
| `base_price` | `numeric` | no | Базовая цена |
| `image_url` | `text` | yes | Публичный URL картинки |
| `is_active` | `boolean` | no | Активен ли товар |
| `created_at` | `timestamptz` | no | Дата создания |

## `public.inventory`
| Поле | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `bigint` | no | ID строки |
| `product_id` | `uuid` | no | Ссылка на `products.id` |
| `city_id` | `bigint` | no | Ссылка на `cities.id` |
| `in_stock` | `boolean` | no | В наличии |
| `stock_qty` | `int` | yes | Количество (опционально) |
| `price_override` | `numeric` | yes | Переопределение цены |

## `public.cities`
| Поле | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `bigint` | no | ID города |
| `name` | `text` | no | Название |
| `slug` | `text` | no | Короткий код (`vvo`, `blg`) |

## Что вводить в БД для категорий

1. Для существующей БД добавьте колонку:
```sql
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
```

2. Заполняйте `category_slug` в товарах:
```sql
update public.products set category_slug = 'pods' where id = '11111111-1111-1111-1111-111111111111';
update public.products set category_slug = 'disposable' where id = '22222222-2222-2222-2222-222222222222';
```

3. Пример вставки нового товара:
```sql
insert into public.products (id, title, description, category_slug, base_price, image_url, is_active)
values (
  gen_random_uuid(),
  'Pods Grape Soda',
  null,
  'pods',
  980,
  null,
  true
);
```

## Рекомендуемые `category_slug`
- `pods`
- `disposable`
- `liquid`
- `cartridge`
- `accessory`
- `tobacco`
- `other`

## Бизнес-правила
- Эффективная цена: `price_override ?? base_price`
- Видимость в каталоге: `products.is_active = true`
- Наличие: `inventory.in_stock = true`
- Фильтрация категорий: по `products.category_slug`
