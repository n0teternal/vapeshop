import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { verifyTelegramInitData } from "./telegram/verifyInitData.js";
import { createOrder, type CreateOrderPayload } from "./order/createOrder.js";
import {
  applyOrderEdit,
  startOrderEditSession,
  stopOrderEditSession,
} from "./order/editOrder.js";
import { listCustomerOrders } from "./order/customerOrders.js";
import { cancelOrderAndRestoreInventory } from "./order/cancelOrder.js";
import {
  geocodeDeliveryAddress,
  previewDeliveryAddressDistance,
  type DeliveryDistancePreviewResult,
  type DeliveryGeocodeResult,
} from "./delivery/yandexGeocode.js";
import {
  loadDeliveryPricingSettings,
  parseDeliveryPricingSettingsUpdate,
  saveDeliveryPricingSettings,
  type DeliveryPricingSettings,
} from "./delivery/pricing.js";
import {
  BLG_DELIVERY_TIME_SLOTS,
  getBlgDeliveryTimeSlotsForDate,
  getMinDeliveryDateForCity,
  getTodayIsoDateForCity,
  isBlgDeliveryTimeSlotOrderOpen,
  isValidIsoDate,
} from "./order/deliverySchedule.js";
import {
  DELIVERY_METHOD_EXPRESS,
  isDeliveryAddressMethod,
  isOrderDeliveryMethod,
} from "./order/deliveryMethod.js";
import { sendOrderNotificationToChats } from "./order/sendOrderNotification.js";
import {
  buildNotifyTargetRecords,
  syncEditedOrderTelegramState,
  syncFinalOrderTelegramState,
} from "./order/telegramFinalStatus.js";
import { HttpError, isHttpError } from "./httpError.js";
import { registerAdminRoutes } from "./admin/routes.js";
import {
  fetchCatalogByCity,
  type CatalogCitySlug,
  type CatalogItem,
} from "./catalog/getCatalog.js";
import { config } from "./config.js";
import { loadActivePromotionRules } from "./promotions/rules.js";
import { previewPromoCode, type PromoCodeLine } from "./promoCodes/service.js";
import { bootstrapReferralProfile, getReferralOverview } from "./referral/service.js";
import { createServiceSupabaseClient } from "./supabase/serviceClient.js";
import { sendMessage } from "./telegram/api.js";
import { registerTelegramWebhookRoutes } from "./telegram/webhookRoutes.js";
import { ensureTelegramWebhook } from "./telegram/webhookSetup.js";

type ApiSuccess<T> = {
  ok: true;
  data: T;
};

type ErrorResponse = {
  ok: false;
  error: { code: string; message: string };
};

type SuccessResponse = {
  ok: true;
  orderId: string;
  notified: boolean;
};

type CitySlug = "vvo" | "blg";
const DELIVERY_PRICING_ALLOWED_TG_USER_ID = 1208488286;
const DEV_FALLBACK_TG_USER_ID = 42;

type OrderRequestBody = CreateOrderPayload & {
  initData?: string;
};

function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getHeaderString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function requireVerifiedTelegramRequest(params: {
  headers: Record<string, unknown>;
  initDataFallback?: string | undefined;
}) {
  const initData = (
    getHeaderString(params.headers["x-telegram-init-data"]) ??
    params.initDataFallback ??
    ""
  ).trim();

  if (!initData) {
    throw new HttpError(401, "TG_INIT_DATA_REQUIRED", "Open the mini app inside Telegram");
  }

  const verified = verifyTelegramInitData(initData, config.telegram.botToken);
  const maxAgeSeconds = 24 * 60 * 60;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - verified.authDate > maxAgeSeconds) {
    throw new HttpError(401, "TG_INIT_DATA_EXPIRED", "initData auth_date is too old");
  }

  return verified;
}

function requireCustomerTelegramUser(params: {
  headers: Record<string, unknown>;
  initDataFallback?: string | undefined;
}): { id: number; username: string | null } {
  const devHeaderOn = getHeaderString(params.headers["x-dev-admin"]) === "1";
  if (config.isDev && devHeaderOn && config.dev.adminTgUserId) {
    return { id: config.dev.adminTgUserId, username: null };
  }
  if (config.isDev && devHeaderOn) {
    return { id: DEV_FALLBACK_TG_USER_ID, username: "dev_mode" };
  }

  return requireVerifiedTelegramRequest(params).user;
}

function readOptionalCustomerTelegramUser(params: {
  headers: Record<string, unknown>;
  initDataFallback?: string | undefined;
}): { id: number; username: string | null } | null {
  const devHeaderOn = getHeaderString(params.headers["x-dev-admin"]) === "1";
  if (config.isDev && devHeaderOn && config.dev.adminTgUserId) {
    return { id: config.dev.adminTgUserId, username: null };
  }
  if (config.isDev && devHeaderOn) {
    return { id: DEV_FALLBACK_TG_USER_ID, username: "dev_mode" };
  }

  const initData = (
    getHeaderString(params.headers["x-telegram-init-data"]) ??
    params.initDataFallback ??
    ""
  ).trim();
  if (!initData) return null;

  return requireVerifiedTelegramRequest(params).user;
}

function requireReferralTelegramContext(params: {
  headers: Record<string, unknown>;
  initDataFallback?: string | undefined;
}): { user: { id: number; username: string | null }; startParam: string | null } {
  const devHeaderOn = getHeaderString(params.headers["x-dev-admin"]) === "1";
  if (config.isDev && devHeaderOn && config.dev.adminTgUserId) {
    return { user: { id: config.dev.adminTgUserId, username: null }, startParam: null };
  }
  if (config.isDev && devHeaderOn) {
    return { user: { id: DEV_FALLBACK_TG_USER_ID, username: "dev_mode" }, startParam: null };
  }

  const verified = requireVerifiedTelegramRequest(params);
  const startParam =
    typeof verified.params.start_param === "string" ? verified.params.start_param : null;

  return { user: verified.user, startParam };
}

function getAllowedDeliveryLocation(
  citySlug: CitySlug,
  deliveryLocation: CreateOrderPayload["deliveryLocation"],
): CreateOrderPayload["deliveryLocation"] {
  if (!deliveryLocation) return null;

  if (citySlug !== "blg") {
    throw new HttpError(
      400,
      "DELIVERY_LOCATION_CITY_ONLY",
      "Delivery location is only available for Blagoveshchensk",
    );
  }

  return deliveryLocation;
}

function parseOptionalTrimmedString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "BAD_REQUEST", `${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validatePhoneIfPresent(phone: string | null): void {
  if (!phone) return;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 20 || phone.length > 40) {
    throw new HttpError(400, "BAD_REQUEST", "phone must be a valid phone number");
  }
}

function parseOptionalDeliveryLocation(value: unknown): CreateOrderPayload["deliveryLocation"] {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new HttpError(400, "BAD_REQUEST", "deliveryLocation must be an object");
  }

  const address = parseOptionalTrimmedString(value.address, "deliveryLocation.address");
  const lat = value.lat;
  const lon = value.lon;
  const distanceKm = value.distanceKm;
  const zone = value.zone;

  if (
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    typeof lon !== "number" ||
    !Number.isFinite(lon) ||
    Math.abs(lon) > 180
  ) {
    throw new HttpError(400, "BAD_REQUEST", "deliveryLocation coordinates are invalid");
  }

  if (
    typeof distanceKm !== "number" ||
    !Number.isFinite(distanceKm) ||
    distanceKm < 0 ||
    distanceKm > 500
  ) {
    throw new HttpError(400, "BAD_REQUEST", "deliveryLocation.distanceKm is invalid");
  }

  if (
    zone !== undefined &&
    zone !== null &&
    zone !== "near" &&
    zone !== "middle" &&
    zone !== "far" &&
    zone !== "manual"
  ) {
    throw new HttpError(400, "BAD_REQUEST", "deliveryLocation.zone is invalid");
  }

  return {
    address,
    lat,
    lon,
    distanceKm,
    zone: zone ?? null,
  };
}

function parseOrderRequestBody(value: unknown): OrderRequestBody {
  if (!isRecord(value)) {
    throw new HttpError(400, "BAD_REQUEST", "Invalid JSON body");
  }

  const citySlug = value.citySlug;
  if (citySlug !== "vvo" && citySlug !== "blg") {
    throw new HttpError(400, "BAD_REQUEST", "citySlug must be 'vvo' | 'blg'");
  }

  const deliveryMethod = value.deliveryMethod;
  if (typeof deliveryMethod !== "string" || deliveryMethod.trim().length === 0) {
    throw new HttpError(400, "BAD_REQUEST", "deliveryMethod is required");
  }
  const normalizedDeliveryMethod = deliveryMethod.trim();
  if (!isOrderDeliveryMethod(normalizedDeliveryMethod)) {
    throw new HttpError(400, "BAD_REQUEST", "deliveryMethod is invalid");
  }
  if (
    !config.features.deliveryUpgradesEnabled &&
    normalizedDeliveryMethod === DELIVERY_METHOD_EXPRESS
  ) {
    throw new HttpError(400, "BAD_REQUEST", "deliveryMethod is invalid");
  }

  const phone = parseOptionalTrimmedString(value.phone, "phone");
  validatePhoneIfPresent(phone);
  const comment = parseOptionalTrimmedString(value.comment, "comment");
  const address = parseOptionalTrimmedString(value.address, "address");
  const deliveryDate = parseOptionalTrimmedString(value.deliveryDate, "deliveryDate");
  const deliveryTimeSlot = parseOptionalTrimmedString(
    value.deliveryTimeSlot,
    "deliveryTimeSlot",
  );
  const deliveryLocation = parseOptionalDeliveryLocation(value.deliveryLocation);
  const couponCode = parseOptionalTrimmedString(value.couponCode, "couponCode");

  if (isDeliveryAddressMethod(normalizedDeliveryMethod) && address === null) {
    throw new HttpError(400, "BAD_REQUEST", "Укажите адрес для доставки.");
  }

  if (citySlug === "blg" && normalizedDeliveryMethod === "delivery" && deliveryDate === null) {
    throw new HttpError(400, "BAD_REQUEST", "Р’С‹Р±РµСЂРёС‚Рµ РґР°С‚Сѓ РґРѕСЃС‚Р°РІРєРё.");
  }

  if (
    citySlug === "blg" &&
    normalizedDeliveryMethod === "delivery" &&
    deliveryTimeSlot === null
  ) {
    throw new HttpError(400, "BAD_REQUEST", "Р’С‹Р±РµСЂРёС‚Рµ РІСЂРµРјСЏ РґРѕСЃС‚Р°РІРєРё.");
  }

  if (
    citySlug === "blg" &&
    normalizedDeliveryMethod === "delivery" &&
    deliveryTimeSlot !== null &&
    deliveryDate === null
  ) {
    throw new HttpError(400, "BAD_REQUEST", "Выберите дату доставки.");
  }

  if (deliveryDate !== null && !isValidIsoDate(deliveryDate)) {
    throw new HttpError(400, "BAD_REQUEST", "deliveryDate must be in YYYY-MM-DD format");
  }

  if (deliveryDate !== null) {
    const cityToday = getTodayIsoDateForCity(citySlug);
    const minDeliveryDate =
      citySlug === "blg" && normalizedDeliveryMethod === "delivery"
        ? getMinDeliveryDateForCity(citySlug)
        : cityToday;

    if (deliveryDate < minDeliveryDate) {
      throw new HttpError(
        400,
        minDeliveryDate > cityToday
          ? "DELIVERY_DATE_CLOSED_FOR_TODAY"
          : "DELIVERY_DATE_IN_PAST",
        minDeliveryDate > cityToday
          ? "На сегодня свободных слотов уже нет. Выберите другую дату."
          : "Нельзя выбрать дату раньше сегодняшней по местному времени города.",
      );
    }

    if (deliveryDate < cityToday) {
      throw new HttpError(
        400,
        "DELIVERY_DATE_IN_PAST",
        "Нельзя выбрать дату раньше сегодняшней по местному времени города.",
      );
    }
  }

  if (deliveryTimeSlot !== null && citySlug === "blg" && normalizedDeliveryMethod === "delivery") {
    if (deliveryDate === null) {
      throw new HttpError(
        400,
        "BAD_REQUEST",
        "Выбран неизвестный временной слот доставки.",
      );
    }

    const availableTimeSlotsForDate = getBlgDeliveryTimeSlotsForDate(deliveryDate);
    if (
      !availableTimeSlotsForDate.includes(
        deliveryTimeSlot as (typeof BLG_DELIVERY_TIME_SLOTS)[number],
      )
    ) {
      throw new HttpError(
        400,
        "BAD_REQUEST",
        "Сначала выберите дату доставки для этого временного слота.",
      );
    }

    if (
      !isBlgDeliveryTimeSlotOrderOpen({
        deliveryDate,
        deliveryTimeSlot,
      })
    ) {
      throw new HttpError(
        400,
        "DELIVERY_TIME_SLOT_UNAVAILABLE",
        "Этот слот уже недоступен. Выберите более позднее время или другую дату.",
      );
    }
  }

  const itemsRaw = value.items;
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    throw new HttpError(400, "BAD_REQUEST", "items must be a non-empty array");
  }

  const items: CreateOrderPayload["items"] = itemsRaw.map((it) => {
    if (!isRecord(it)) {
      throw new HttpError(400, "BAD_REQUEST", "Invalid items[] element");
    }
    const productId = it.productId;
    const qty = it.qty;
    if (typeof productId !== "string" || productId.length === 0) {
      throw new HttpError(400, "BAD_REQUEST", "items[].productId is required");
    }
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0) {
      throw new HttpError(400, "BAD_REQUEST", "items[].qty must be a positive integer");
    }
    return { productId, qty };
  });

  const pointsToSpendRaw = value.pointsToSpend;
  const pointsToSpend =
    pointsToSpendRaw === undefined || pointsToSpendRaw === null ? 0 : pointsToSpendRaw;
  if (
    typeof pointsToSpend !== "number" ||
    !Number.isInteger(pointsToSpend) ||
    pointsToSpend < 0
  ) {
    throw new HttpError(400, "BAD_REQUEST", "pointsToSpend must be a non-negative integer");
  }

  const initData = typeof value.initData === "string" ? value.initData : undefined;

  const base: CreateOrderPayload = {
    citySlug: citySlug as CitySlug,
    deliveryMethod: normalizedDeliveryMethod,
    phone,
    address,
    comment,
    deliveryDate: normalizedDeliveryMethod === "delivery" ? deliveryDate : null,
    deliveryTimeSlot: normalizedDeliveryMethod === "delivery" ? deliveryTimeSlot : null,
    deliveryLocation:
      isDeliveryAddressMethod(normalizedDeliveryMethod)
        ? deliveryLocation
        : null,
    couponCode,
    pointsToSpend,
    items,
  };

  if (typeof initData === "string" && initData.trim().length > 0) {
    return { ...base, initData: initData.trim() };
  }

  return base;
}

function parsePromoCodePreviewLines(value: unknown): PromoCodeLine[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "BAD_REQUEST", "lines must be an array");
  }

  return value.map((line, index) => {
    if (!isRecord(line)) {
      throw new HttpError(400, "BAD_REQUEST", `lines[${index}] must be an object`);
    }

    const categorySlug =
      typeof line.categorySlug === "string" && line.categorySlug.trim().length > 0
        ? line.categorySlug.trim()
        : null;
    const totalRaw = line.total;
    const total =
      typeof totalRaw === "number"
        ? totalRaw
        : typeof totalRaw === "string"
          ? Number(totalRaw)
          : Number.NaN;
    if (!Number.isFinite(total) || total < 0) {
      throw new HttpError(400, "BAD_REQUEST", `lines[${index}].total must be a non-negative number`);
    }

    return {
      categorySlug,
      total,
    };
  });
}

function pickTelegramChatIds(citySlug: CitySlug): string[] {
  if (citySlug === "vvo") {
    return config.telegram.chatIdsVvo ?? config.telegram.chatIdsOwner;
  }
  if (citySlug === "blg") {
    return config.telegram.chatIdsBlg ?? config.telegram.chatIdsOwner;
  }
  return config.telegram.chatIdsOwner;
}

function pickTelegramChatIdsForOrder(params: {
  citySlug: CitySlug;
  tgUserId: number;
}): string[] {
  return pickTelegramChatIds(params.citySlug);
}

function parseUrlHost(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

const imageProxyAllowedHosts = new Set<string>();
{
  const supabaseHost = parseUrlHost(config.supabase.url);
  if (supabaseHost) imageProxyAllowedHosts.add(supabaseHost);

  const productImagesHost = parseUrlHost(config.productImagesBaseUrl);
  if (productImagesHost) imageProxyAllowedHosts.add(productImagesHost);
}

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => {
    // Allow requests without Origin (curl, Telegram webhook, etc.)
    if (!origin) return cb(null, true);
    if (config.corsOrigins === null) return cb(null, true);
    return cb(null, config.corsOrigins.includes(origin));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-telegram-init-data", "x-dev-admin"],
  preflight: true,
  maxAge: 600,
  // IMPORTANT: browsers send OPTIONS preflight for PUT/JSON requests.
  // If we continue to route handling, Fastify may return 404 for OPTIONS and the browser will fail with "Failed to fetch".
  preflightContinue: false,
  optionsSuccessStatus: 204,
});

await app.register(multipart, {
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const staticRoot = path.resolve(process.cwd(), "static");
const staticItemsDir = path.join(staticRoot, "items");
if (!fs.existsSync(staticItemsDir)) {
  fs.mkdirSync(staticItemsDir, { recursive: true });
}

await app.register(fastifyStatic, {
  root: staticRoot,
  prefix: "/static/",
});

await registerAdminRoutes(app);
await registerTelegramWebhookRoutes(app);

app.get("/health", async () => {
  return { ok: true };
});

app.get<{
  Querystring: { url?: string };
  Reply: Buffer | NodeJS.ReadableStream | ErrorResponse;
}>("/api/image-proxy", async (request, reply) => {
  try {
    const rawUrl = request.query.url?.trim() ?? "";
    if (!rawUrl) {
      throw new HttpError(400, "BAD_REQUEST", "url query is required");
    }

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      throw new HttpError(400, "BAD_REQUEST", "url query must be a valid absolute URL");
    }

    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new HttpError(400, "BAD_REQUEST", "Only http/https image URLs are allowed");
    }

    if (target.pathname.startsWith("/api/image-proxy")) {
      throw new HttpError(400, "BAD_REQUEST", "Recursive proxy URL is not allowed");
    }

    if (!imageProxyAllowedHosts.has(target.host)) {
      throw new HttpError(400, "BAD_REQUEST", "Host is not allowed for image proxy");
    }

    let upstream: Response;
    try {
      upstream = await fetch(target.toString(), { redirect: "follow" });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to fetch upstream image";
      throw new HttpError(502, "UPSTREAM", message);
    }

    if (!upstream.ok) {
      if (upstream.status === 404) {
        throw new HttpError(404, "NOT_FOUND", "Image not found");
      }
      throw new HttpError(502, "UPSTREAM", `Upstream image request failed with ${upstream.status}`);
    }

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const cacheControl =
      upstream.headers.get("cache-control") ??
      "public, max-age=300, s-maxage=1800, stale-while-revalidate=3600";
    const contentLength = upstream.headers.get("content-length");
    const etag = upstream.headers.get("etag");
    const lastModified = upstream.headers.get("last-modified");
    const stream = upstream.body;
    if (!stream) {
      throw new HttpError(502, "UPSTREAM", "Upstream image body is empty");
    }

    const response = reply
      .header("Content-Type", contentType)
      .header("Cache-Control", cacheControl)
      .code(200);

    if (contentLength) response.header("Content-Length", contentLength);
    if (etag) response.header("ETag", etag);
    if (lastModified) response.header("Last-Modified", lastModified);

    return response.send(
      Readable.fromWeb(stream as unknown as import("node:stream/web").ReadableStream),
    );
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Image proxy request failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.get<{
  Querystring: { citySlug?: string; includePromos?: string };
  Reply:
    | ApiSuccess<{
        citySlug: CatalogCitySlug;
        items: CatalogItem[];
        promoItems: Awaited<ReturnType<typeof fetchCatalogByCity>>["promoItems"];
      }>
    | ErrorResponse;
}>("/api/catalog", async (request, reply) => {
  try {
    const citySlug = request.query.citySlug;
    if (citySlug !== "vvo" && citySlug !== "blg") {
      throw new HttpError(400, "BAD_REQUEST", "citySlug must be 'vvo' | 'blg'");
    }

    const includePromos = request.query.includePromos === "1";
    const catalog = await fetchCatalogByCity({ citySlug, includePromos });

    return reply
      .header("Cache-Control", "public, max-age=30, s-maxage=120, stale-while-revalidate=300")
      .code(200)
      .send(ok({ citySlug, items: catalog.items, promoItems: catalog.promoItems }));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Catalog request failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.get<{
  Querystring: { citySlug?: string };
  Reply:
    | ApiSuccess<{
        items: Awaited<ReturnType<typeof loadActivePromotionRules>>;
      }>
    | ErrorResponse;
}>("/api/promotions/active", async (request, reply) => {
  try {
    const citySlug = request.query.citySlug;
    if (citySlug !== "vvo" && citySlug !== "blg") {
      throw new HttpError(400, "BAD_REQUEST", "citySlug must be 'vvo' | 'blg'");
    }

    const supabase = createServiceSupabaseClient();
    const { data: city, error: cityError } = await supabase
      .from("cities")
      .select("id")
      .eq("slug", citySlug)
      .maybeSingle();

    if (cityError) {
      throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
    }
    if (!city) {
      throw new HttpError(400, "CITY_NOT_FOUND", "City not found");
    }

    const items = await loadActivePromotionRules({ supabase, cityId: city.id });

    return reply
      .header("Cache-Control", "public, max-age=30, s-maxage=120, stale-while-revalidate=300")
      .code(200)
      .send(ok({ items }));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Promotion rules request failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.post<{
  Body: unknown;
  Reply:
    | ApiSuccess<{
        code: string;
        discountAmount: number;
        categorySlug: string | null;
        requiresPreviousOrder: boolean;
      }>
    | ErrorResponse;
}>("/api/promocodes/preview", async (request, reply) => {
  try {
    if (!isRecord(request.body)) {
      throw new HttpError(400, "BAD_REQUEST", "Invalid JSON body");
    }

    const code = parseOptionalTrimmedString(request.body.code, "code");
    if (!code) {
      throw new HttpError(400, "BAD_REQUEST", "Введите промокод.");
    }
    const citySlug = request.body.citySlug;
    if (citySlug === "vvo") {
      throw new HttpError(
        400,
        "PROMO_CODES_CITY_DISABLED",
        "Промокоды недоступны для Владивостока.",
      );
    }
    if (citySlug !== undefined && citySlug !== null && citySlug !== "blg") {
      throw new HttpError(400, "BAD_REQUEST", "citySlug must be 'blg' when provided");
    }

    const totalRaw = request.body.total;
    const total =
      typeof totalRaw === "number"
        ? totalRaw
        : typeof totalRaw === "string"
          ? Number(totalRaw)
          : Number.NaN;
    if (!Number.isFinite(total) || total < 0) {
      throw new HttpError(400, "BAD_REQUEST", "total must be a non-negative number");
    }

    const lines = parsePromoCodePreviewLines(request.body.lines);
    const user = readOptionalCustomerTelegramUser({
      headers: request.headers as Record<string, unknown>,
      initDataFallback:
        typeof request.body.initData === "string" ? request.body.initData : undefined,
    });

    const result = await previewPromoCode({
      code,
      orderTotal: total,
      lines,
      tgUserId: user?.id ?? null,
    });
    return reply.code(200).send(ok(result));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Promo code preview failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.get<{
  Querystring: { citySlug?: string; address?: string };
  Reply: ApiSuccess<DeliveryGeocodeResult> | ErrorResponse;
}>("/api/delivery/geocode", async (request, reply) => {
  try {
    const citySlug = request.query.citySlug;
    if (citySlug !== "blg") {
      throw new HttpError(400, "BAD_REQUEST", "citySlug must be 'blg'");
    }

    const address = request.query.address?.trim() ?? "";
    if (address.length < 3) {
      throw new HttpError(400, "BAD_REQUEST", "address is too short");
    }

    const result = await geocodeDeliveryAddress({
      citySlug,
      address,
    });

    return reply.code(200).send(ok(result));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Delivery geocode failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.get<{
  Querystring: { citySlug?: string };
  Reply: ApiSuccess<DeliveryPricingSettings> | ErrorResponse;
}>("/api/delivery/pricing", async (request, reply) => {
  try {
    const citySlug = request.query.citySlug;
    if (citySlug !== "vvo" && citySlug !== "blg") {
      throw new HttpError(400, "BAD_REQUEST", "citySlug must be 'vvo' | 'blg'");
    }

    const result = await loadDeliveryPricingSettings({
      supabase: createServiceSupabaseClient(),
      citySlug,
    });

    return reply.code(200).send(ok(result));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Delivery pricing load failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.put<{
  Body: unknown;
  Reply: ApiSuccess<DeliveryPricingSettings> | ErrorResponse;
}>("/api/delivery/pricing", async (request, reply) => {
  try {
    const context = requireReferralTelegramContext({
      headers: request.headers as Record<string, unknown>,
    });
    if (context.user.id !== DELIVERY_PRICING_ALLOWED_TG_USER_ID) {
      throw new HttpError(
        403,
        "DELIVERY_PRICING_USER_ONLY",
        "Delivery pricing is only available for this user",
      );
    }

    const update = parseDeliveryPricingSettingsUpdate(request.body);
    const result = await saveDeliveryPricingSettings({
      supabase: createServiceSupabaseClient(),
      update,
    });

    return reply.code(200).send(ok(result));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Delivery pricing save failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.get<{
  Querystring: {
    citySlug?: string;
    address?: string;
    originLat?: string;
    originLon?: string;
  };
  Reply: ApiSuccess<DeliveryDistancePreviewResult> | ErrorResponse;
}>("/api/delivery/distance-preview", async (request, reply) => {
  try {
    const citySlug = request.query.citySlug;
    if (citySlug !== "blg") {
      throw new HttpError(400, "BAD_REQUEST", "citySlug must be 'blg'");
    }

    const address = request.query.address?.trim() ?? "";
    if (address.length < 3) {
      throw new HttpError(400, "BAD_REQUEST", "address is too short");
    }

    const originLat = Number(request.query.originLat);
    const originLon = Number(request.query.originLon);

    const result = await previewDeliveryAddressDistance({
      citySlug,
      address,
      originLat,
      originLon,
    });

    return reply.code(200).send(ok(result));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Delivery distance preview failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.post<{
  Reply:
    | ApiSuccess<{ referralCode: string; referralLink: string; referralBound: boolean }>
    | ErrorResponse;
}>("/api/referrals/bootstrap", async (request, reply) => {
  try {
    const context = requireReferralTelegramContext({
      headers: request.headers as Record<string, unknown>,
    });

    const result = await bootstrapReferralProfile({
      tgUserId: context.user.id,
      tgUsername: context.user.username,
      startParam: context.startParam,
    });

    return reply.code(200).send(ok(result));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Referral bootstrap failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.get<{
  Querystring: { limit?: string; offset?: string };
  Reply: ApiSuccess<Awaited<ReturnType<typeof getReferralOverview>>> | ErrorResponse;
}>("/api/referrals/overview", async (request, reply) => {
  try {
    const context = requireReferralTelegramContext({
      headers: request.headers as Record<string, unknown>,
    });

    const limitRaw = Number(request.query.limit ?? 20);
    const offsetRaw = Number(request.query.offset ?? 0);
    const limit = Number.isFinite(limitRaw) && Number.isInteger(limitRaw) ? limitRaw : 20;
    const offset = Number.isFinite(offsetRaw) && Number.isInteger(offsetRaw) ? offsetRaw : 0;

    const overview = await getReferralOverview({
      tgUserId: context.user.id,
      tgUsername: context.user.username,
      startParam: context.startParam,
      limit,
      offset,
    });

    return reply.code(200).send(ok(overview));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Referral overview failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.get<{
  Reply: ApiSuccess<{ orders: Awaited<ReturnType<typeof listCustomerOrders>> }> | ErrorResponse;
}>("/api/orders", async (request, reply) => {
  try {
    const user = requireCustomerTelegramUser({
      headers: request.headers as Record<string, unknown>,
    });

    const orders = await listCustomerOrders(user.id);
    return reply.code(200).send(ok({ orders }));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Customer orders request failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.put<{
  Params: { orderId: string };
  Reply: ApiSuccess<Awaited<ReturnType<typeof cancelOrderAndRestoreInventory>>> | ErrorResponse;
}>("/api/orders/:orderId/cancel", async (request, reply) => {
  try {
    const orderId = request.params.orderId?.trim() ?? "";
    if (!orderId) {
      throw new HttpError(400, "BAD_REQUEST", "orderId is required");
    }

    const user = requireCustomerTelegramUser({
      headers: request.headers as Record<string, unknown>,
    });

      const result = await cancelOrderAndRestoreInventory({
        orderId,
        expectedTgUserId: user.id,
      });

      if (result.changed && result.status === "cancelled") {
        try {
          await syncFinalOrderTelegramState({
            orderId,
            status: "cancelled",
            logger: request.log,
          });
        } catch (syncError) {
          request.log.error(
            { err: syncError, orderId },
            "Customer cancellation completed, but Telegram final status sync failed",
          );
        }
      }

      return reply.code(200).send(ok(result));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Customer cancel order request failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.put<{
  Params: { orderId: string };
  Reply: ApiSuccess<Awaited<ReturnType<typeof startOrderEditSession>>> | ErrorResponse;
}>("/api/orders/:orderId/edit-session", async (request, reply) => {
  try {
    const orderId = request.params.orderId?.trim() ?? "";
    if (!orderId) {
      throw new HttpError(400, "BAD_REQUEST", "orderId is required");
    }

    const user = requireCustomerTelegramUser({
      headers: request.headers as Record<string, unknown>,
    });

    const result = await startOrderEditSession({
      orderId,
      expectedTgUserId: user.id,
      allowPromoPrices: true,
    });
    return reply.code(200).send(ok(result));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Customer start edit session request failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.delete<{
  Params: { orderId: string };
  Reply: ApiSuccess<{ stopped: true }> | ErrorResponse;
}>("/api/orders/:orderId/edit-session", async (request, reply) => {
  try {
    const orderId = request.params.orderId?.trim() ?? "";
    if (!orderId) {
      throw new HttpError(400, "BAD_REQUEST", "orderId is required");
    }

    const user = requireCustomerTelegramUser({
      headers: request.headers as Record<string, unknown>,
    });

    await stopOrderEditSession({
      orderId,
      expectedTgUserId: user.id,
    });
    return reply.code(200).send(ok({ stopped: true }));
  } catch (e: unknown) {
    const statusCode = isHttpError(e) ? e.statusCode : 500;
    const code = isHttpError(e) ? e.code : "INTERNAL";
    const message = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : "Unexpected error";

    request.log.error({ err: e }, "Customer stop edit session request failed");
    return reply.code(statusCode).send({ ok: false, error: { code, message } });
  }
});

app.put<{ Params: { orderId: string }; Body: unknown; Reply: ErrorResponse | SuccessResponse }>(
  "/api/orders/:orderId/edit",
  async (request, reply) => {
    try {
      const orderId = request.params.orderId?.trim() ?? "";
      if (!orderId) {
        throw new HttpError(400, "BAD_REQUEST", "orderId is required");
      }

      const body = parseOrderRequestBody(request.body);
      const verified = requireVerifiedTelegramRequest({
        headers: request.headers as Record<string, unknown>,
        initDataFallback: body.initData,
      });
      const deliveryLocation = getAllowedDeliveryLocation(
        body.citySlug,
        body.deliveryLocation,
      );

      const result = await applyOrderEdit({
        orderId,
        expectedTgUserId: verified.user.id,
        allowPromoPrices: true,
        payload: {
          citySlug: body.citySlug,
          deliveryMethod: body.deliveryMethod,
          phone: body.phone,
          address: body.address,
          comment: body.comment,
          deliveryDate: body.deliveryDate,
          deliveryTimeSlot: body.deliveryTimeSlot,
          deliveryLocation,
          couponCode: null,
          pointsToSpend: body.pointsToSpend,
          items: body.items,
        },
      });

      try {
        await syncEditedOrderTelegramState({
          orderId: result.orderId,
          logger: request.log,
        });
      } catch (syncError) {
        request.log.error(
          { err: syncError, orderId: result.orderId },
          "Edited order saved, but Telegram edited order sync failed",
        );
      }

      return reply.code(200).send({ ok: true, orderId: result.orderId, notified: true });
    } catch (e: unknown) {
      const statusCode = isHttpError(e) ? e.statusCode : 500;
      const code = isHttpError(e) ? e.code : "INTERNAL";
      const message = isHttpError(e)
        ? e.message
        : e instanceof Error
          ? e.message
          : "Unexpected error";

      request.log.error({ err: e }, "Customer edit order request failed");
      return reply.code(statusCode).send({ ok: false, error: { code, message } });
    }
  },
);

app.post<{ Body: unknown; Reply: ErrorResponse | SuccessResponse }>(
  "/api/order",
  async (request, reply) => {
    try {
      const body = parseOrderRequestBody(request.body);
      const headers = request.headers as Record<string, unknown>;
      const initData = (
        getHeaderString(headers["x-telegram-init-data"]) ??
        body.initData ??
        ""
      ).trim();
      const devHeaderOn = getHeaderString(headers["x-dev-admin"]) === "1";
      const useDevBypass = config.isDev && devHeaderOn && initData.length === 0;
      const verified = initData
        ? requireVerifiedTelegramRequest({ headers, initDataFallback: body.initData })
        : null;
      const isGuestOrder = !verified && !useDevBypass;
      if (isGuestOrder && !body.phone) {
        throw new HttpError(400, "PHONE_REQUIRED", "Укажите номер телефона.");
      }
      const orderUser = verified
        ? verified.user
        : useDevBypass && config.dev.adminTgUserId
          ? { id: config.dev.adminTgUserId, username: null }
          : useDevBypass
            ? { id: DEV_FALLBACK_TG_USER_ID, username: "dev_mode" }
            : { id: 0, username: null };
      const deliveryLocation = getAllowedDeliveryLocation(
        body.citySlug,
        body.deliveryLocation,
      );

      if (verified) {
        try {
          const startParam =
            typeof verified.params.start_param === "string" ? verified.params.start_param : null;
          await bootstrapReferralProfile({
            tgUserId: verified.user.id,
            tgUsername: verified.user.username,
            startParam,
          });
        } catch (bootstrapError) {
          request.log.error({ err: bootstrapError }, "Referral bootstrap failed during order flow");
        }
      }

      const order = await createOrder({
        payload: {
          citySlug: body.citySlug,
          deliveryMethod: body.deliveryMethod,
          phone: body.phone,
          address: body.address,
          comment: body.comment,
          deliveryDate: body.deliveryDate,
          deliveryTimeSlot: body.deliveryTimeSlot,
          deliveryLocation,
          couponCode: body.couponCode,
          pointsToSpend: body.pointsToSpend,
          items: body.items,
        },
        tgUser: {
          id: orderUser.id,
          username: orderUser.username,
        },
        allowPromoPrices: true,
      });

      const chatIds = pickTelegramChatIdsForOrder({
        citySlug: body.citySlug,
        tgUserId: orderUser.id,
      });
      const notificationResult = await sendOrderNotificationToChats({
        botToken: config.telegram.botToken,
        chatIds,
        text: order.telegramMessage.text,
        replyMarkup: order.telegramMessage.reply_markup,
        logger: request.log,
      });
      const { sentMessages, fallbackWithoutMarkupChatIds } = notificationResult;
      const notified = sentMessages.length > 0;
      const firstSent = sentMessages[0] ?? null;

      if (fallbackWithoutMarkupChatIds.length > 0) {
        request.log.warn(
          {
            orderId: order.orderId,
            chatIds: fallbackWithoutMarkupChatIds,
          },
          "Order notifications sent without reply markup fallback",
        );
      }

      if (firstSent) {
        try {
          const supabase = createServiceSupabaseClient();
          const { error } = await supabase
            .from("orders")
            .update({
              notify_chat_id: firstSent.chat.id,
              notify_message_id: firstSent.message_id,
              notify_sent_at: new Date().toISOString(),
              notify_targets: buildNotifyTargetRecords(sentMessages),
            })
            .eq("id", order.orderId);

          if (error) {
            request.log.error({ err: error }, "Failed to update orders.notify_*");
          }
        } catch (e) {
          request.log.error({ err: e }, "Failed to update orders.notify_*");
        }
      }

      return reply.code(200).send({ ok: true, orderId: order.orderId, notified });
    } catch (e: unknown) {
      const statusCode = isHttpError(e) ? e.statusCode : 500;
      const code = isHttpError(e) ? e.code : "INTERNAL";
      const message = isHttpError(e)
        ? e.message
        : e instanceof Error
          ? e.message
          : "Unexpected error";

      request.log.error({ err: e }, "Request failed");
      return reply.code(statusCode).send({ ok: false, error: { code, message } });
    }
  },
);

await app.listen({ port: config.port, host: config.host });

// Best-effort: keep Telegram webhook configured in production so inline buttons work.
try {
  await ensureTelegramWebhook();
} catch (e) {
  app.log.error({ err: e }, "Failed to ensure Telegram webhook");
}
