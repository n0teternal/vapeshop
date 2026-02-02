# Backend: структура таблиц для товаров

Этот документ фиксирует **ожидаемые поля БД**, которые использует backend для каталога и наличия.

## `public.products`
| Поле | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `uuid` | no | ID товара |
| `title` | `text` | no | Название |
| `description` | `text` | yes | Описание |
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
| `stock_qty` | `int` | yes | Кол-во (опционально) |
| `price_override` | `numeric` | yes | Переопределение цены |

## `public.cities` (используется при фильтрации каталога)
| Поле | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `bigint` | no | ID города |
| `name` | `text` | no | Название |
| `slug` | `text` | no | Короткий код (например `vvo`, `blg`) |

## Бизнес-правила
- **Эффективная цена**: `price_override ?? base_price`
- **Видимость в каталоге**: `products.is_active = true`
- **Наличие**: `inventory.in_stock = true`
