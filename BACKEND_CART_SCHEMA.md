# Backend: структура таблиц для корзины/заказов

Этот документ фиксирует **ожидаемые поля БД**, которые использует backend для оформления заказа.

## `public.orders`
| Поле | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `uuid` | no | ID заказа |
| `tg_user_id` | `bigint` | no | Telegram user id |
| `tg_username` | `text` | yes | Telegram username |
| `city_id` | `bigint` | yes | Ссылка на `cities.id` |
| `delivery_method` | `text` | no | Способ получения |
| `comment` | `text` | yes | Комментарий |
| `status` | `text` | no | Статус (`new`/`processing`/`done`) |
| `total_price` | `numeric` | no | Итоговая сумма |
| `created_at` | `timestamptz` | no | Дата создания |
| `notify_chat_id` | `bigint` | yes | Telegram chat id уведомления |
| `notify_message_id` | `bigint` | yes | Telegram message id уведомления |
| `notify_sent_at` | `timestamptz` | yes | Когда отправлено уведомление |

## `public.order_items`
| Поле | Тип | NULL | Описание |
|---|---|---|---|
| `id` | `bigint` | no | ID строки |
| `order_id` | `uuid` | no | Ссылка на `orders.id` |
| `product_id` | `uuid` | yes | Ссылка на `products.id` |
| `qty` | `int` | no | Кол-во |
| `unit_price` | `numeric` | no | Цена за единицу |

## Бизнес-правила
- **Пересчёт цены** происходит на backend: `unit_price = price_override ?? base_price`.
- **Итог**: `total_price = sum(unit_price * qty)` по всем позициям.
- **Валидации**: товары должны существовать, быть активными и `in_stock = true`.
