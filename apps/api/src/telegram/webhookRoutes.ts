import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { buildOrderTelegramMessage, type CitySlug, type OrderStatus } from "../order/telegramMessage.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import { answerCallbackQuery, deleteMessage, editMessageText } from "./api.js";

type CallbackStatus = Exclude<OrderStatus, "new">;

type CallbackUiView = "main" | "done_confirm";

type ParsedCallbackQuery = {
  callbackQueryId: string;
  fromId: number;
  data: string;
  message?: { chatId: number; messageId: number };
};

type ParsedCallbackAction =
  | { kind: "status"; status: CallbackStatus; orderId: string }
  | { kind: "ui"; view: CallbackUiView; orderId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function parseCitySlug(value: unknown): CitySlug | null {
  if (value === "vvo" || value === "blg") return value;
  return null;
}

function parseCallbackQuery(update: unknown): ParsedCallbackQuery | null {
  if (!isRecord(update)) return null;
  const callbackQuery = update.callback_query;
  if (!isRecord(callbackQuery)) return null;

  const callbackQueryId = typeof callbackQuery.id === "string" ? callbackQuery.id : null;
  const data = typeof callbackQuery.data === "string" ? callbackQuery.data : null;

  const from = callbackQuery.from;
  const fromId =
    isRecord(from) && typeof from.id === "number" && Number.isInteger(from.id) ? from.id : null;

  if (!callbackQueryId || !data || fromId === null) return null;

  const messageRaw = callbackQuery.message;
  let message: ParsedCallbackQuery["message"];
  if (isRecord(messageRaw)) {
    const messageId =
      typeof messageRaw.message_id === "number" && Number.isInteger(messageRaw.message_id)
        ? messageRaw.message_id
        : null;
    const chatRaw = messageRaw.chat;
    const chatId =
      isRecord(chatRaw) && typeof chatRaw.id === "number" && Number.isInteger(chatRaw.id)
        ? chatRaw.id
        : null;
    if (messageId !== null && chatId !== null) {
      message = { chatId, messageId };
    }
  }

  const base: ParsedCallbackQuery = { callbackQueryId, fromId, data };
  return message ? { ...base, message } : base;
}

function parseCallbackData(data: string): ParsedCallbackAction | null {
  const parts = data.split(":");
  // Keep this tolerant: Telegram callback_data is just a string and older/newer clients may add segments.
  if (parts.length < 3) return null;

  const type = parts[0];
  const actionRaw = parts[1];
  const orderId = parts.slice(2).join(":");
  if (!type || !actionRaw || !orderId) return null;

  const uuidV4ish =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
  if (!uuidV4ish) return null;

  if (type === "status") {
    if (actionRaw !== "processing" && actionRaw !== "done") return null;
    return { kind: "status", status: actionRaw, orderId };
  }

  if (type === "ui") {
    if (actionRaw !== "main" && actionRaw !== "done_confirm") return null;
    return { kind: "ui", view: actionRaw, orderId };
  }

  return null;
}

function numberFromUnknown(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw new Error("Expected numeric value");
}

function parseOrderStatus(value: unknown): OrderStatus {
  if (value === "new" || value === "processing" || value === "done") return value;
  return "new";
}

async function answerSafe(callbackQueryId: string, text: string): Promise<void> {
  try {
    await answerCallbackQuery({
      botToken: config.telegram.botToken,
      callbackQueryId,
      text,
    });
  } catch {
    // Best-effort; webhook should still return 200 to avoid Telegram retries.
  }
}

export async function registerTelegramWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: unknown }>("/api/telegram/webhook", async (request, reply) => {
    const secretHeader = getHeaderValue(request.headers["x-telegram-bot-api-secret-token"]);
    // If the webhook was configured with a secret token, Telegram will send it in a header.
    // In practice it's easy to forget setting the secret on Telegram side; in that case we keep working
    // (but log a warning) instead of silently breaking all admin buttons.
    if (secretHeader && secretHeader !== config.telegram.webhookSecret) {
      return reply.code(401).send({ ok: false });
    }
    if (!secretHeader) {
      request.log.warn("Telegram webhook called without x-telegram-bot-api-secret-token header");
    }

    const parsed = parseCallbackQuery(request.body);
    if (!parsed) {
      return reply.code(200).send({ ok: true });
    }

    const action = parseCallbackData(parsed.data);
    if (!action) {
      await answerSafe(parsed.callbackQueryId, "Неизвестная кнопка");
      return reply.code(200).send({ ok: true });
    }

    const supabase = createServiceSupabaseClient();

    const { data: adminRow, error: adminError } = await supabase
      .from("admins")
      .select("tg_user_id")
      .eq("tg_user_id", parsed.fromId)
      .maybeSingle();

    if (adminError || !adminRow) {
      await answerSafe(parsed.callbackQueryId, "Нет доступа");
      return reply.code(200).send({ ok: true });
    }

    type OrderRow = {
      id: string;
      status: string;
      city_id: number | null;
      tg_user_id: number;
      tg_username: string | null;
      delivery_method: string;
      comment: string | null;
      total_price: unknown;
      notify_chat_id: number | null;
      notify_message_id: number | null;
    };

    const selectCols =
      "id,status,city_id,tg_user_id,tg_username,delivery_method,comment,total_price,notify_chat_id,notify_message_id";

    let order: OrderRow | null = null;

    if (action.kind === "status") {
      const { data, error } = await supabase
        .from("orders")
        .update({ status: action.status })
        .eq("id", action.orderId)
        .select(selectCols)
        .maybeSingle();

      if (error) {
        request.log.error({ err: error }, "Failed to update order status");
        await answerSafe(parsed.callbackQueryId, "Не удалось обновить заказ");
        return reply.code(200).send({ ok: true });
      }

      order = (data ?? null) as unknown as OrderRow | null;
    } else {
      const { data, error } = await supabase
        .from("orders")
        .select(selectCols)
        .eq("id", action.orderId)
        .maybeSingle();

      if (error) {
        request.log.error({ err: error }, "Failed to load order");
        await answerSafe(parsed.callbackQueryId, "Не удалось загрузить заказ");
        return reply.code(200).send({ ok: true });
      }

      order = (data ?? null) as unknown as OrderRow | null;
    }

    if (!order) {
      await answerSafe(parsed.callbackQueryId, "Заказ не найден");
      return reply.code(200).send({ ok: true });
    }

    const cityId = order.city_id;
    if (cityId === null) {
      request.log.warn({ orderId: order.id }, "Order has null city_id; skip message edit");
      await answerSafe(
        parsed.callbackQueryId,
        action.kind === "ui" ? "Ок" : "Статус обновлен",
      );
      return reply.code(200).send({ ok: true });
    }

    const { data: city, error: cityError } = await supabase
      .from("cities")
      .select("id,name,slug")
      .eq("id", cityId)
      .maybeSingle();

    if (cityError || !city) {
      request.log.error({ err: cityError, cityId }, "Failed to load city for order");
      await answerSafe(
        parsed.callbackQueryId,
        action.kind === "ui" ? "Ок" : "Статус обновлен",
      );
      return reply.code(200).send({ ok: true });
    }

    const citySlug = parseCitySlug(city.slug);
    if (!citySlug) {
      request.log.warn({ slug: city.slug }, "Unknown city slug; skip message edit");
      await answerSafe(
        parsed.callbackQueryId,
        action.kind === "ui" ? "Ок" : "Статус обновлен",
      );
      return reply.code(200).send({ ok: true });
    }

    const { data: orderItems, error: itemsError } = await supabase
      .from("order_items")
      .select("product_id,qty,unit_price")
      .eq("order_id", order.id);

    if (itemsError || !orderItems) {
      request.log.error({ err: itemsError }, "Failed to load order items");
      await answerSafe(parsed.callbackQueryId, "Не удалось загрузить позиции");
      return reply.code(200).send({ ok: true });
    }

    const productIds = orderItems
      .map((it) => it.product_id)
      .filter((id): id is string => typeof id === "string");

    const { data: products, error: prodError } = await supabase
      .from("products")
      .select("id,title")
      .in("id", productIds);

    if (prodError || !products) {
      request.log.error({ err: prodError }, "Failed to load products for order");
      await answerSafe(parsed.callbackQueryId, "Не удалось загрузить товары");
      return reply.code(200).send({ ok: true });
    }

    const titleById = new Map<string, string>();
    for (const p of products) {
      titleById.set(p.id, p.title);
    }

    const lines = orderItems.map((it) => ({
      title: titleById.get(it.product_id ?? "") ?? "Unknown",
      qty: it.qty,
      unitPrice: numberFromUnknown(it.unit_price),
    }));

    const totalPrice = numberFromUnknown(order.total_price);
    const orderStatus = parseOrderStatus(order.status);

    const telegramMessage = buildOrderTelegramMessage({
      status: orderStatus,
      actionsView:
        action.kind === "ui" && action.view === "done_confirm" && orderStatus !== "done"
          ? "done_confirm"
          : "main",
      cityName: city.name,
      citySlug,
      tgUser: { id: order.tg_user_id, username: order.tg_username },
      deliveryMethod: order.delivery_method,
      comment: order.comment,
      lines,
      totalPrice,
      orderId: order.id,
    });

    const notifyChatId = order.notify_chat_id;
    const notifyMessageId = order.notify_message_id;
    const editTarget =
      notifyChatId !== null && notifyMessageId !== null
        ? { chatId: notifyChatId, messageId: notifyMessageId }
        : parsed.message;

    if (editTarget) {
      // When order is confirmed as done, remove the message completely from the admin chat.
      // If deletion fails (e.g. missing rights), fall back to editing the message as before.
      if (action.kind === "status" && action.status === "done") {
        try {
          await deleteMessage({
            botToken: config.telegram.botToken,
            chatId: editTarget.chatId,
            messageId: editTarget.messageId,
          });
        } catch (e) {
          request.log.error({ err: e }, "Failed to delete Telegram message; fallback to edit");
          try {
            await editMessageText({
              botToken: config.telegram.botToken,
              chatId: editTarget.chatId,
              messageId: editTarget.messageId,
              text: telegramMessage.text,
              replyMarkup: telegramMessage.reply_markup,
            });
          } catch (e2) {
            request.log.error({ err: e2 }, "Failed to edit Telegram message after delete failure");
          }
        }
      } else {
      try {
        await editMessageText({
          botToken: config.telegram.botToken,
          chatId: editTarget.chatId,
          messageId: editTarget.messageId,
          text: telegramMessage.text,
          replyMarkup: telegramMessage.reply_markup,
        });
      } catch (e) {
        request.log.error({ err: e }, "Failed to edit Telegram message");
      }
      }
    }

    await answerSafe(
      parsed.callbackQueryId,
      action.kind === "ui"
        ? "Ок"
        : action.kind === "status" && action.status === "done"
          ? "Статус: Готово"
          : "Статус обновлен",
    );
    return reply.code(200).send({ ok: true });
  });
}
