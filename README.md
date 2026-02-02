# Telegram Mini App (frontend + Supabase MVP)

Каркас Telegram Mini App: React + Vite + TypeScript + Tailwind + `react-router-dom`.

Сейчас:
- 18+ гейт + выбор города (VVO/BLG) (persist в `localStorage`)
- корзина (persist в `localStorage`)
- `/admin` показывает Telegram WebApp debug (`initData`, `initDataUnsafe`, `platform`, `version`, `colorScheme`)
- каталог: **моки**, либо **чтение из Supabase** (если заданы env)
- оформление заказа: `apps/api` (Fastify) + запись в Supabase + уведомление в Telegram

## Требования

- Node.js 20+ (проверено на Node 22)
- `pnpm` (если не установлен: `corepack enable` или используйте `npx pnpm ...`)

## Запуск локально

```bash
pnpm i
pnpm dev
```

Откройте `http://localhost:5173`.

Проверка API: `http://localhost:8787/health`.

Если нужно раздельно:

```bash
pnpm dev:web
pnpm dev:api
```

Вне Telegram приложение работает в **DEV MODE**:
- сверху будет плашка `DEV MODE`
- `window.Telegram.WebApp` замокан (без подписи) — только чтобы UI работал

## Deploy API on Railway

- Root Directory: `apps/api`
- Build: `cd ../.. && corepack enable && pnpm install --frozen-lockfile && pnpm -C apps/api build`
- Start: `cd ../.. && pnpm -C apps/api start`
- Healthcheck path: `/health`

Порт берётся из `PORT` (Railway подставляет автоматически). В UI можно указать `8080`.

## Env (web + api)

1) Скопируйте `.env.example` → `.env.local` (в корне репозитория):

```bash
copy .env.example .env.local
```

2) Заполните:
- `VITE_SUPABASE_URL` — Project URL (для фронта чтение каталога)
- `VITE_SUPABASE_ANON_KEY` — anon public key (для фронта чтение каталога)
- `VITE_API_BASE_URL` — base URL API (по умолчанию `http://localhost:8787`)

Для API (backend):
- `SUPABASE_URL` — Project URL (для сервера)
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (только на сервере!)
- `TELEGRAM_BOT_TOKEN` — токен бота
- `TELEGRAM_WEBHOOK_SECRET` — secret token для Telegram webhook (заголовок `x-telegram-bot-api-secret-token`)
- `PUBLIC_WEBHOOK_URL` — публичный URL вебхука (например `https://your-domain.com/api/telegram/webhook`)
- `TELEGRAM_CHAT_ID_OWNER` — чат по умолчанию (fallback)
- `TELEGRAM_CHAT_ID_VVO` — чат для VVO
- `TELEGRAM_CHAT_ID_BLG` — чат для BLG
- `CORS_ORIGINS` — **только для production**, список origin через запятую

Если env не заданы — каталог продолжит работать на моках и покажет предупреждение.

## Supabase: как создать проект и применить SQL

1) Создайте проект в Supabase.
2) Dashboard → **Settings** → **API**:
   - возьмите **Project URL**
   - возьмите **Project API keys → anon public**
3) Dashboard → **SQL Editor**:
   - выполните `supabase/schema.sql`
   - затем выполните `supabase/seed.sql`

Важно: RLS включён на всех таблицах. Для anon разрешён только read-only доступ к `cities`, `products` (только `is_active=true`) и `inventory`.
Таблицы `orders`, `order_items`, `admins` закрыты для anon (заказы будут создаваться будущим backend’ом через `service_role`).

## Supabase: ALTER для Telegram уведомлений

Чтобы бот мог редактировать сообщение и менять статус заказа по кнопкам, сервер сохраняет `chat_id` и `message_id` в `orders`.

Dashboard → **SQL Editor** → выполните:
- `supabase/alter_orders_notify.sql`

## Storage (product images)

1) Dashboard → **Storage** → **Create bucket**:
   - name: `product-images`
   - Public: `true`
2) (опционально) Загрузите 1–2 картинки и обновите `products.image_url` на публичные URL вида:

`https://<project-ref>.supabase.co/storage/v1/object/public/product-images/<path>`

## Админка (backend only)

Все админ-операции выполняются **только через backend** (`apps/api`) с проверкой Telegram `initData` и allowlist в таблице `admins`.

Примечание про CORS: в dev на API включён `origin: true`. Для production стоит ограничить origin доменом mini app.

В production нужно задать `CORS_ORIGINS` (comma-separated). В dev ограничение не применяется.

### Как добавить админа

Supabase Dashboard → Table editor → `admins` → Insert row:
- `tg_user_id`: ваш Telegram user id
- `role`: `owner` или `manager` (любая строка)

### DEV режим админки (опционально)

Чтобы тестировать админку в обычном браузере вне Telegram:
1) В `.env.local` задайте `DEV_ADMIN_TG_USER_ID=<ваш tg id>`
2) Добавьте себя в таблицу `admins` (как выше)
3) Запустите `pnpm dev` и откройте `/admin`

Фронт в dev будет автоматически слать заголовок `x-dev-admin: 1` если нет Telegram initData.
В production этот обход не работает.

## Роуты

- `/` — каталог (18+ → город → список товаров)
- `/cart` — корзина
- `/admin` — debug Telegram WebApp

## Как открыть в Telegram

Telegram Mini App требует публичный **HTTPS** URL.

Варианты:
- задеплоить (Vercel/Netlify/Cloudflare Pages/любая статика с SPA rewrite)
- или поднять туннель на локальный `5173` (ngrok/cloudflared и т.п.)

Дальше:
1) В BotFather создайте/настройте Mini App и укажите URL.
2) Откройте мини-апп в Telegram.
3) Перейдите на `/admin` — там должны появиться реальные значения `initData` / `initDataUnsafe`.

## Telegram webhook (кнопки статуса в чате)

Уведомление о заказе приходит с inline-кнопками:
- `🟡 В работу` → `processing`
- `✅ Готово` → `done`

Чтобы это работало, нужно настроить webhook бота.

1) Заполните в `.env.local`:
- `PUBLIC_WEBHOOK_URL` (должен быть HTTPS и указывать на `.../api/telegram/webhook`)
- `TELEGRAM_WEBHOOK_SECRET` (любой длинный секрет)

2) Установите webhook (пример через curl):

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$PUBLIC_WEBHOOK_URL" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Для локальной разработки используйте ngrok/cloudflared и ставьте `PUBLIC_WEBHOOK_URL` на публичный туннель.

## Что проверить руками (чеклист)

- `/`: 18+ гейт, сохранение `isAdultConfirmed` в `localStorage`
- `/`: выбор города VVO/BLG, сохранение `city` в `localStorage`
- `/`: если Supabase env задан — загрузка товаров из БД, “в наличии” = `inventory.in_stock`, цена = `price_override ?? base_price`
- `/`: если Supabase env НЕ задан — работает мок-каталог + видно предупреждение
- `/cart`: +/- qty, итог, “Оформить” → POST в API (`/api/order`)
- `/admin`: в Telegram — реальные данные, вне Telegram — DEV MODE + мок
- Telegram чат: после заказа сообщение с кнопками, нажатия меняют статус и редактируют сообщение
