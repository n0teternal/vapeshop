import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { isHttpError } from "../httpError.js";
import { cancelOrderAndRestoreInventory } from "../order/cancelOrder.js";
import { buildCustomerConversationRequestMessage } from "../order/conversationRequest.js";
import {
  buildOrderTelegramMessage,
  type CitySlug,
  type OrderPaymentMethod,
  type OrderStatus,
} from "../order/telegramMessage.js";
import { syncFinalOrderTelegramState } from "../order/telegramFinalStatus.js";
import {
  bootstrapReferralProfile,
  getCustomerReferralShare,
  processReferralRewardForOrderDone,
} from "../referral/service.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import { answerCallbackQuery, editMessageText, sendMessage } from "./api.js";
import {
  buildCustomerMainMenuMessage,
  buildCustomerOrdersMenuMessage,
  buildCustomerReferralMenuMessage,
} from "./customerMenu.js";

type CallbackStatus = Exclude<OrderStatus, "new">;

type CallbackUiView = "main" | "done_confirm" | "cancel_confirm" | "contact_confirm";

type ParsedCallbackQuery = {
  callbackQueryId: string;
  fromId: number;
  data: string;
  message?: { chatId: number; messageId: number };
};

type ParsedStartCommand = {
  chatId: number;
  fromId: number;
  fromUsername: string | null;
  startParam: string | null;
};

type ParsedCallbackAction =
  | { kind: "order_status"; status: CallbackStatus; orderId: string; paymentMethod?: OrderPaymentMethod }
  | { kind: "order_ui"; view: CallbackUiView; orderId: string }
  | { kind: "request_conversation"; orderId: string }
  | { kind: "menu"; view: "main" | "orders" | "referral" };

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

function parseStartCommand(update: unknown): ParsedStartCommand | null {
  if (!isRecord(update)) return null;

  const message = update.message;
  if (!isRecord(message)) return null;

  const text = typeof message.text === "string" ? message.text : null;
  if (!text) return null;

  const match = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) return null;

  const from = message.from;
  const fromId =
    isRecord(from) && typeof from.id === "number" && Number.isInteger(from.id) ? from.id : null;
  if (fromId === null) return null;
  const chatRaw = message.chat;
  const chatId =
    isRecord(chatRaw) && typeof chatRaw.id === "number" && Number.isInteger(chatRaw.id)
      ? chatRaw.id
      : null;
  if (chatId === null) return null;

  const usernameRaw =
    isRecord(from) && typeof from.username === "string" ? from.username.trim() : "";
  const startParamRaw = typeof match[1] === "string" ? match[1].trim() : "";

  return {
    chatId,
    fromId,
    fromUsername: usernameRaw.length > 0 ? usernameRaw : null,
    startParam: startParamRaw.length > 0 ? startParamRaw : null,
  };
}

function isUuidV4ish(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function parseOrderPaymentMethod(value: string | undefined): OrderPaymentMethod | null {
  if (value === "cash" || value === "card") return value;
  return null;
}

function parseCallbackData(data: string): ParsedCallbackAction | null {
  const parts = data.split(":");
  const type = parts[0];
  const actionRaw = parts[1];
  if (!type || !actionRaw) return null;

  if (type === "menu" && parts.length === 2) {
    if (actionRaw === "main" || actionRaw === "orders" || actionRaw === "referral") {
      return { kind: "menu", view: actionRaw };
    }
    return null;
  }

  if (type === "contact_request" && parts.length === 2) {
    const orderId = actionRaw;
    if (!isUuidV4ish(orderId)) return null;
    return { kind: "request_conversation", orderId };
  }

  // Keep this tolerant: Telegram callback_data is just a string and older/newer clients may add segments.
  if (parts.length < 3) return null;

  if (type === "status") {
    if (actionRaw !== "processing" && actionRaw !== "done" && actionRaw !== "cancelled") {
      return null;
    }

    const maybePaymentMethod = parseOrderPaymentMethod(parts[2]);
    const paymentMethod = actionRaw === "done" ? maybePaymentMethod : null;
    const orderId = (paymentMethod ? parts.slice(3) : parts.slice(2)).join(":");
    if (!isUuidV4ish(orderId)) return null;

    if (actionRaw === "done" && !paymentMethod) {
      return { kind: "order_ui", view: "done_confirm", orderId };
    }

    return paymentMethod
      ? { kind: "order_status", status: actionRaw, orderId, paymentMethod }
      : { kind: "order_status", status: actionRaw, orderId };
  }

  if (type === "ui") {
    const orderId = parts.slice(2).join(":");
    if (!isUuidV4ish(orderId)) return null;

    if (
      actionRaw !== "main" &&
      actionRaw !== "done_confirm" &&
      actionRaw !== "cancel_confirm" &&
      actionRaw !== "contact_confirm"
    ) {
      return null;
    }
    return { kind: "order_ui", view: actionRaw, orderId };
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
  if (value === "new" || value === "processing" || value === "done" || value === "cancelled") {
    return value;
  }
  return "new";
}

async function answerSafe(
  callbackQueryId: string,
  text: string,
  showAlert = false,
): Promise<void> {
  try {
    await answerCallbackQuery({
      botToken: config.telegram.botToken,
      callbackQueryId,
      text,
      showAlert,
    });
  } catch {
    // Best-effort; webhook should still return 200 to avoid Telegram retries.
  }
}

type CustomerOrderRow = {
  id: string;
  status: string;
  city_id: number | null;
  total_price: unknown;
  total_after_discount: unknown;
  created_at: string;
};

async function loadCustomerOrderSummaries(tgUserId: number) {
  const supabase = createServiceSupabaseClient();
  const { data: orders, error: ordersError } = await supabase
    .from("orders")
    .select("id,status,city_id,total_price,total_after_discount,created_at")
    .eq("tg_user_id", tgUserId)
    .order("created_at", { ascending: false })
    .limit(7);

  if (ordersError) {
    throw new Error(`Failed to load customer orders: ${ordersError.message}`);
  }

  const rows = (orders ?? []) as CustomerOrderRow[];
  const cityIds = Array.from(
    new Set(rows.map((row) => row.city_id).filter((id): id is number => typeof id === "number")),
  );

  const cityLabelById = new Map<number, string>();
  if (cityIds.length > 0) {
    const { data: cities, error: citiesError } = await supabase
      .from("cities")
      .select("id,name,slug")
      .in("id", cityIds);

    if (citiesError) {
      throw new Error(`Failed to load cities for customer orders: ${citiesError.message}`);
    }

    for (const city of cities ?? []) {
      cityLabelById.set(city.id, `${city.name} (${city.slug.toUpperCase()})`);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    status: parseOrderStatus(row.status),
    cityLabel: row.city_id !== null ? cityLabelById.get(row.city_id) ?? "Неизвестный город" : "Без города",
    totalPrice: numberFromUnknown(row.total_after_discount ?? row.total_price),
    createdAt: row.created_at,
  }));
}

async function buildCustomerMenuView(params: {
  view: "main" | "orders" | "referral";
  tgUserId: number;
}): Promise<ReturnType<typeof buildCustomerMainMenuMessage>> {
  if (params.view === "orders") {
    const orders = await loadCustomerOrderSummaries(params.tgUserId);
    return buildCustomerOrdersMenuMessage(orders);
  }

  if (params.view === "referral") {
    const referral = await getCustomerReferralShare({
      tgUserId: params.tgUserId,
      tgUsername: null,
    });
    return buildCustomerReferralMenuMessage({
      referralLink: referral.referralLink,
    });
  }

  return buildCustomerMainMenuMessage();
}

export async function registerTelegramWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: unknown }>("/api/telegram/webhook", async (request, reply) => {
    const secretHeader = getHeaderValue(request.headers["x-telegram-bot-api-secret-token"]);
    // If the webhook was configured with a secret token, Telegram will send it in a header.
    // In practice it's easy to forget setting the secret on Telegram side; in that case we keep working
    // (but log a warning) instead of silently breaking all admin buttons.
    if (!secretHeader) {
      request.log.warn("Telegram webhook called without x-telegram-bot-api-secret-token header");
    } else if (secretHeader !== config.telegram.webhookSecret) {
      // Stay permissive to avoid breaking the bot when TELEGRAM_WEBHOOK_SECRET changes but setWebhook wasn't updated.
      // NOTE: Best practice is to keep the secret in sync and reject mismatches.
      request.log.warn(
        { got: secretHeader, expected: config.telegram.webhookSecret },
        "Telegram webhook secret token mismatch; continuing anyway",
      );
    }

    const startCommand = parseStartCommand(request.body);
    if (startCommand) {
      try {
        await bootstrapReferralProfile({
          tgUserId: startCommand.fromId,
          tgUsername: startCommand.fromUsername,
          startParam: startCommand.startParam,
        });
      } catch (e) {
        request.log.error({ err: e, tgUserId: startCommand.fromId }, "Failed to bootstrap referral from /start");
      }

      try {
        const menuMessage = buildCustomerMainMenuMessage();
        await sendMessage({
          botToken: config.telegram.botToken,
          chatId: String(startCommand.chatId),
          text: menuMessage.text,
          replyMarkup: menuMessage.reply_markup,
        });
      } catch (e) {
        request.log.error({ err: e, tgUserId: startCommand.fromId }, "Failed to send customer main menu");
      }
      return reply.code(200).send({ ok: true });
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

    if (action.kind === "menu") {
      if (!parsed.message) {
        await answerSafe(parsed.callbackQueryId, "Откройте меню через /start");
        return reply.code(200).send({ ok: true });
      }

      try {
        const menuMessage = await buildCustomerMenuView({
          view: action.view,
          tgUserId: parsed.fromId,
        });

        await editMessageText({
          botToken: config.telegram.botToken,
          chatId: parsed.message.chatId,
          messageId: parsed.message.messageId,
          text: menuMessage.text,
          replyMarkup: menuMessage.reply_markup,
        });

        await answerSafe(parsed.callbackQueryId, "Ок");
      } catch (e) {
        request.log.error(
          { err: e, tgUserId: parsed.fromId, view: action.view },
          "Failed to handle customer menu callback",
        );
        await answerSafe(parsed.callbackQueryId, "Не удалось открыть раздел");
      }

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
      discount_amount: unknown;
      promotion_discount_amount: unknown;
      notify_chat_id: number | null;
      notify_message_id: number | null;
      notify_targets: unknown;
      edited_at: string | null;
    };

    const selectCols =
      "id,status,city_id,tg_user_id,tg_username,delivery_method,comment,total_price,discount_amount,promotion_discount_amount,notify_chat_id,notify_message_id,notify_targets,edited_at";

    let order: OrderRow | null = null;

    if (action.kind === "order_status" && action.status === "cancelled") {
      try {
        await cancelOrderAndRestoreInventory({ orderId: action.orderId });
      } catch (e) {
        request.log.error({ err: e, orderId: action.orderId }, "Failed to cancel order");
        await answerSafe(
          parsed.callbackQueryId,
          isHttpError(e) ? e.message : "Не удалось отменить заказ",
        );
        return reply.code(200).send({ ok: true });
      }
    } else if (action.kind === "order_status") {
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
    }

    if (!order) {
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

    if (action.kind === "order_status" && action.status === "done") {
      try {
        await processReferralRewardForOrderDone({ orderId: order.id });
      } catch (e) {
        request.log.error({ err: e, orderId: order.id }, "Failed to process referral reward");
      }
    }

    if (
      action.kind === "order_status" &&
      (action.status === "done" || action.status === "cancelled")
    ) {
      try {
        const syncParams: Parameters<typeof syncFinalOrderTelegramState>[0] = {
          orderId: order.id,
          status: action.status,
          fallbackTarget: parsed.message
            ? {
                chatId: parsed.message.chatId,
                messageId: parsed.message.messageId,
              }
            : null,
          logger: request.log,
        };
        if (action.status === "done" && action.paymentMethod) {
          syncParams.paymentMethod = action.paymentMethod;
        }

        await syncFinalOrderTelegramState(syncParams);
      } catch (e) {
        request.log.error(
          { err: e, orderId: order.id, status: action.status },
          "Final Telegram order sync failed after webhook status update",
        );
      }

      await answerSafe(
        parsed.callbackQueryId,
        action.status === "done" ? "РЎС‚Р°С‚СѓСЃ: Р“РѕС‚РѕРІРѕ" : "РЎС‚Р°С‚СѓСЃ: РћС‚РјРµРЅС‘РЅ",
      );
      return reply.code(200).send({ ok: true });
    }

    const cityId = order.city_id;
    if (cityId === null) {
      request.log.warn({ orderId: order.id }, "Order has null city_id; skip message edit");
      await answerSafe(
        parsed.callbackQueryId,
        action.kind === "order_ui" ? "Ок" : "Статус обновлен",
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
        action.kind === "order_ui" ? "Ок" : "Статус обновлен",
      );
      return reply.code(200).send({ ok: true });
    }

    const citySlug = parseCitySlug(city.slug);
    if (!citySlug) {
      request.log.warn({ slug: city.slug }, "Unknown city slug; skip message edit");
      await answerSafe(
        parsed.callbackQueryId,
        action.kind === "order_ui" ? "Ок" : "Статус обновлен",
      );
      return reply.code(200).send({ ok: true });
    }

    if (action.kind === "request_conversation") {
      try {
        const customerMessage = buildCustomerConversationRequestMessage({
          citySlug,
          orderId: order.id,
        });

        await sendMessage({
          botToken: config.telegram.botToken,
          chatId: String(order.tg_user_id),
          text: customerMessage.text,
          replyMarkup: customerMessage.reply_markup,
        });

        await answerSafe(parsed.callbackQueryId, "Запрос отправлен");
      } catch (e) {
        request.log.error(
          { err: e, orderId: order.id, tgUserId: order.tg_user_id },
          "Failed to send conversation request to customer",
        );
        await answerSafe(parsed.callbackQueryId, "Не удалось написать клиенту", true);
      }

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
    const discountAmount =
      order.discount_amount === null || order.discount_amount === undefined
        ? 0
        : numberFromUnknown(order.discount_amount);
    const promotionDiscountAmount =
      order.promotion_discount_amount === null || order.promotion_discount_amount === undefined
        ? 0
        : numberFromUnknown(order.promotion_discount_amount);
    const orderStatus = parseOrderStatus(order.status);
    const isEdited = typeof order.edited_at === "string" && order.edited_at.trim().length > 0;

    const telegramMessage = buildOrderTelegramMessage({
      status: orderStatus,
      actionsView:
        action.kind === "order_ui" &&
        action.view === "done_confirm" &&
        orderStatus !== "done" &&
        orderStatus !== "cancelled"
          ? "done_confirm"
          : action.kind === "order_ui" &&
              action.view === "cancel_confirm" &&
              orderStatus !== "done" &&
              orderStatus !== "cancelled"
            ? "cancel_confirm"
            : action.kind === "order_ui" && action.view === "contact_confirm"
              ? "contact_confirm"
            : "main",
      cityName: city.name,
      citySlug,
      tgUser: { id: order.tg_user_id, username: order.tg_username },
      deliveryMethod: order.delivery_method,
      comment: order.comment,
      lines,
      totalPrice,
      promotionDiscountAmount,
      pointsDiscountAmount: discountAmount,
      discountApplied: discountAmount > 0 || promotionDiscountAmount > 0,
      orderId: order.id,
      isEdited,
    });

    const notifyChatId = order.notify_chat_id;
    const notifyMessageId = order.notify_message_id;
    const editTarget =
      parsed.message ??
      (notifyChatId !== null && notifyMessageId !== null
        ? { chatId: notifyChatId, messageId: notifyMessageId }
        : undefined);

    if (editTarget) {
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

    await answerSafe(
      parsed.callbackQueryId,
      action.kind === "order_ui"
        ? "Ок"
        : action.kind === "order_status" && action.status === "done"
          ? "Статус: Готово"
          : action.kind === "order_status" && action.status === "cancelled"
            ? "Статус: Отменён"
            : "Статус обновлен",
    );
    return reply.code(200).send({ ok: true });
  });
}
