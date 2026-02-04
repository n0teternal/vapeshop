import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { verifyTelegramInitData } from "./telegram/verifyInitData.js";
import { createOrder, type CreateOrderPayload } from "./order/createOrder.js";
import { HttpError, isHttpError } from "./httpError.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { config } from "./config.js";
import { createServiceSupabaseClient } from "./supabase/serviceClient.js";
import { sendMessage } from "./telegram/api.js";
import { registerTelegramWebhookRoutes } from "./telegram/webhookRoutes.js";
import { ensureTelegramWebhook } from "./telegram/webhookSetup.js";

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

type OrderRequestBody = CreateOrderPayload & {
  initData?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

  const commentRaw = value.comment;
  const comment =
    commentRaw === undefined || commentRaw === null
      ? null
      : typeof commentRaw === "string"
        ? commentRaw
        : null;

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

  const initData = typeof value.initData === "string" ? value.initData : undefined;

  const base: CreateOrderPayload = {
    citySlug: citySlug as CitySlug,
    deliveryMethod: deliveryMethod.trim(),
    comment: comment?.trim() ? comment.trim() : null,
    items,
  };

  if (typeof initData === "string" && initData.trim().length > 0) {
    return { ...base, initData: initData.trim() };
  }

  return base;
}

function pickTelegramChatId(citySlug: CitySlug): string {
  if (citySlug === "vvo") {
    return config.telegram.chatIdVvo ?? config.telegram.chatIdOwner;
  }
  if (citySlug === "blg") {
    return config.telegram.chatIdBlg ?? config.telegram.chatIdOwner;
  }
  return config.telegram.chatIdOwner;
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

app.post<{ Body: unknown; Reply: ErrorResponse | SuccessResponse }>(
  "/api/order",
  async (request, reply) => {
    try {
      const body = parseOrderRequestBody(request.body);

      const headerInitData = request.headers["x-telegram-init-data"];
      const initDataFromHeader =
        typeof headerInitData === "string"
          ? headerInitData
          : Array.isArray(headerInitData)
            ? headerInitData[0]
            : undefined;
      const initData = (initDataFromHeader ?? body.initData ?? "").trim();

      if (!initData) {
        throw new HttpError(401, "TG_INIT_DATA_REQUIRED", "Open the mini app inside Telegram");
      }

      const verified = verifyTelegramInitData(initData, config.telegram.botToken);
      const maxAgeSeconds = 24 * 60 * 60;
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds - verified.authDate > maxAgeSeconds) {
        throw new HttpError(401, "TG_INIT_DATA_EXPIRED", "initData auth_date is too old");
      }

      const order = await createOrder({
        payload: {
          citySlug: body.citySlug,
          deliveryMethod: body.deliveryMethod,
          comment: body.comment,
          items: body.items,
        },
        tgUser: {
          id: verified.user.id,
          username: verified.user.username,
        },
      });

      const chatId = pickTelegramChatId(body.citySlug);

      let notified = false;
      try {
        const result = await sendMessage({
          botToken: config.telegram.botToken,
          chatId,
          text: order.telegramMessage.text,
          replyMarkup: order.telegramMessage.reply_markup,
        });
        notified = true;

        try {
          const supabase = createServiceSupabaseClient();
          const { error } = await supabase
            .from("orders")
            .update({
              notify_chat_id: result.chat.id,
              notify_message_id: result.message_id,
              notify_sent_at: new Date().toISOString(),
            })
            .eq("id", order.orderId);

          if (error) {
            request.log.error({ err: error }, "Failed to update orders.notify_*");
          }
        } catch (e) {
          request.log.error({ err: e }, "Failed to update orders.notify_*");
        }
      } catch (e) {
        request.log.error({ err: e }, "Failed to notify Telegram");
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
