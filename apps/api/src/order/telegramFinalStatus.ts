import { config } from "../config.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import {
  deleteMessage,
  editMessageText,
  sendMessage,
  type TelegramMessage,
} from "../telegram/api.js";
import {
  buildOrderTelegramMessage,
  buildOrderStatusTelegramText,
  type CitySlug,
  type OrderStatus,
} from "./telegramMessage.js";

export type FinalOrderStatus = Extract<OrderStatus, "done" | "cancelled">;

export type NotifyTargetRecord = {
  chat_id: number;
  message_id: number;
};

type NotifyTarget = {
  chatId: number;
  messageId: number;
};

type LoggerLike = {
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

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
  notify_chat_id: number | null;
  notify_message_id: number | null;
  notify_targets: unknown;
};

function logError(logger: LoggerLike | undefined, fields: Record<string, unknown>, message: string): void {
  if (logger?.error) {
    logger.error(fields, message);
    return;
  }
  console.error(message, fields);
}

function logWarn(logger: LoggerLike | undefined, fields: Record<string, unknown>, message: string): void {
  if (logger?.warn) {
    logger.warn(fields, message);
    return;
  }
  console.warn(message, fields);
}

function numberFromUnknown(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Expected numeric value, got: ${String(value)}`);
}

function parseCitySlug(value: unknown): CitySlug | null {
  if (value === "vvo" || value === "blg") return value;
  return null;
}

function pickOrderChatIds(citySlug: CitySlug): string[] {
  if (citySlug === "vvo") {
    return config.telegram.chatIdsVvo ?? config.telegram.chatIdsOwner;
  }
  return config.telegram.chatIdsBlg ?? config.telegram.chatIdsOwner;
}

function dedupeNotifyTargets(targets: NotifyTarget[]): NotifyTarget[] {
  const seen = new Set<string>();
  const deduped: NotifyTarget[] = [];

  for (const target of targets) {
    const key = `${target.chatId}:${target.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(target);
  }

  return deduped;
}

function parseNotifyTargetRecord(value: unknown): NotifyTarget | null {
  if (typeof value !== "object" || value === null) return null;

  const row = value as Record<string, unknown>;
  const chatId = numberFromUnknownSafe(row.chat_id);
  const messageId = numberFromUnknownSafe(row.message_id);
  if (chatId === null || messageId === null) return null;

  return { chatId, messageId };
}

function numberFromUnknownSafe(value: unknown): number | null {
  try {
    const n = numberFromUnknown(value);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export function buildNotifyTargetRecords(messages: TelegramMessage[]): NotifyTargetRecord[] {
  return dedupeNotifyTargets(
    messages.map((message) => ({
      chatId: message.chat.id,
      messageId: message.message_id,
    })),
  ).map((target) => ({
    chat_id: target.chatId,
    message_id: target.messageId,
  }));
}

export function readNotifyTargets(params: {
  notifyTargets: unknown;
  notifyChatId: number | null;
  notifyMessageId: number | null;
  fallbackTarget?: NotifyTarget | null;
}): NotifyTarget[] {
  const targets: NotifyTarget[] = [];

  if (Array.isArray(params.notifyTargets)) {
    for (const row of params.notifyTargets) {
      const parsed = parseNotifyTargetRecord(row);
      if (parsed) targets.push(parsed);
    }
  }

  if (typeof params.notifyChatId === "number" && typeof params.notifyMessageId === "number") {
    targets.push({
      chatId: params.notifyChatId,
      messageId: params.notifyMessageId,
    });
  }

  if (params.fallbackTarget) {
    targets.push(params.fallbackTarget);
  }

  return dedupeNotifyTargets(targets);
}

function toNotifyTargetRecords(targets: NotifyTarget[]): NotifyTargetRecord[] {
  return dedupeNotifyTargets(targets).map((target) => ({
    chat_id: target.chatId,
    message_id: target.messageId,
  }));
}

async function loadOrderContext(orderId: string): Promise<{
  order: OrderRow;
  city: { id: number; name: string; slug: string };
  citySlug: CitySlug;
  lines: Array<{ title: string; qty: number; unitPrice: number }>;
  totalPrice: number;
  discountAmount: number;
}> {
  const supabase = createServiceSupabaseClient();

  const { data: orderData, error: orderError } = await supabase
    .from("orders")
    .select(
      "id,status,city_id,tg_user_id,tg_username,delivery_method,comment,total_price,discount_amount,notify_chat_id,notify_message_id,notify_targets",
    )
    .eq("id", orderId)
    .maybeSingle();

  if (orderError) {
    throw new Error(`Failed to load order: ${orderError.message}`);
  }
  if (!orderData) {
    throw new Error(`Order not found: ${orderId}`);
  }

  const order = orderData as unknown as OrderRow;
  if (order.city_id === null) {
    throw new Error(`Order ${order.id} has null city_id`);
  }

  const { data: city, error: cityError } = await supabase
    .from("cities")
    .select("id,name,slug")
    .eq("id", order.city_id)
    .maybeSingle();

  if (cityError) {
    throw new Error(`Failed to load city: ${cityError.message}`);
  }
  if (!city) {
    throw new Error(`City not found for order ${order.id}: ${order.city_id}`);
  }

  const citySlug = parseCitySlug(city.slug);
  if (!citySlug) {
    throw new Error(`Unsupported city slug for order ${order.id}: ${String(city.slug)}`);
  }

  const { data: orderItems, error: orderItemsError } = await supabase
    .from("order_items")
    .select("product_id,qty,unit_price")
    .eq("order_id", order.id);

  if (orderItemsError) {
    throw new Error(`Failed to load order items: ${orderItemsError.message}`);
  }

  const productIds = Array.from(
    new Set(
      (orderItems ?? [])
        .map((item) => item.product_id)
        .filter((productId): productId is string => typeof productId === "string"),
    ),
  );

  const { data: products, error: productsError } =
    productIds.length === 0
      ? { data: [], error: null }
      : await supabase.from("products").select("id,title").in("id", productIds);

  if (productsError) {
    throw new Error(`Failed to load products: ${productsError.message}`);
  }

  const titleById = new Map<string, string>();
  for (const product of products ?? []) {
    titleById.set(product.id, product.title);
  }

  const lines = (orderItems ?? []).map((item) => ({
    title: item.product_id ? titleById.get(item.product_id) ?? "Unknown" : "Unknown",
    qty: item.qty,
    unitPrice: numberFromUnknown(item.unit_price),
  }));

  return {
    order,
    city,
    citySlug,
    lines,
    totalPrice: numberFromUnknown(order.total_price),
    discountAmount:
      order.discount_amount === null || order.discount_amount === undefined
        ? 0
        : numberFromUnknown(order.discount_amount),
  };
}

export async function syncFinalOrderTelegramState(params: {
  orderId: string;
  status: FinalOrderStatus;
  fallbackTarget?: NotifyTarget | null;
  skipStatusChats?: boolean;
  logger?: LoggerLike;
}): Promise<void> {
  const context = await loadOrderContext(params.orderId);

  const statusText = buildOrderStatusTelegramText({
    status: params.status,
    cityName: context.city.name,
    citySlug: context.citySlug,
    tgUser: {
      id: context.order.tg_user_id,
      username: context.order.tg_username,
    },
    deliveryMethod: context.order.delivery_method,
    comment: context.order.comment,
    lines: context.lines,
    totalPrice: context.totalPrice,
    discountApplied: context.discountAmount > 0,
    orderId: context.order.id,
  });
  const orderStatusMessage = buildOrderTelegramMessage({
    status: params.status,
    cityName: context.city.name,
    citySlug: context.citySlug,
    tgUser: {
      id: context.order.tg_user_id,
      username: context.order.tg_username,
    },
    deliveryMethod: context.order.delivery_method,
    comment: context.order.comment,
    lines: context.lines,
    totalPrice: context.totalPrice,
    discountApplied: context.discountAmount > 0,
    orderId: context.order.id,
  });

  if (!params.skipStatusChats && config.telegram.chatIdsOrderStatus) {
    for (const chatId of config.telegram.chatIdsOrderStatus) {
      try {
        await sendMessage({
          botToken: config.telegram.botToken,
          chatId,
          text: statusText,
          replyMarkup: orderStatusMessage.reply_markup,
        });
      } catch (error) {
        logError(
          params.logger,
          { err: error, chatId, orderId: context.order.id, status: params.status },
          "Failed to notify order status chat",
        );
      }
    }
  }

  const notifyTargets = readNotifyTargets({
    notifyTargets: context.order.notify_targets,
    notifyChatId: context.order.notify_chat_id,
    notifyMessageId: context.order.notify_message_id,
    fallbackTarget: params.fallbackTarget ?? null,
  });
  const orderChatIds = pickOrderChatIds(context.citySlug);
  const orderTargetsByChatId = new Map<number, NotifyTarget>();
  for (const target of notifyTargets) {
    if (!orderTargetsByChatId.has(target.chatId)) {
      orderTargetsByChatId.set(target.chatId, target);
    }
  }

  const persistedTargets: NotifyTarget[] = params.status === "cancelled" ? [] : [...notifyTargets];

  for (const target of notifyTargets) {
    if (params.status === "done") {
      try {
        await deleteMessage({
          botToken: config.telegram.botToken,
          chatId: target.chatId,
          messageId: target.messageId,
        });
      } catch (error) {
        logError(
          params.logger,
          { err: error, chatId: target.chatId, messageId: target.messageId, orderId: context.order.id },
          "Failed to delete Telegram order message; falling back to edit",
        );

        try {
          await editMessageText({
            botToken: config.telegram.botToken,
            chatId: target.chatId,
            messageId: target.messageId,
            text: orderStatusMessage.text,
            replyMarkup: orderStatusMessage.reply_markup,
          });
        } catch (editError) {
          logError(
            params.logger,
            {
              err: editError,
              chatId: target.chatId,
              messageId: target.messageId,
              orderId: context.order.id,
            },
            "Failed to edit Telegram order message after delete failure",
          );
        }
      }

      continue;
    }

    try {
      await editMessageText({
        botToken: config.telegram.botToken,
        chatId: target.chatId,
        messageId: target.messageId,
        text: orderStatusMessage.text,
        replyMarkup: orderStatusMessage.reply_markup,
      });
    } catch (error) {
      logError(
        params.logger,
        { err: error, chatId: target.chatId, messageId: target.messageId, orderId: context.order.id },
        "Failed to edit cancelled Telegram order message",
      );
    }
  }

  const orderChatIdsToNotify = new Set<string>(orderChatIds);
  for (const target of notifyTargets) {
    orderChatIdsToNotify.add(String(target.chatId));
  }

  for (const chatId of orderChatIdsToNotify) {
    const numericChatId = Number(chatId);

    if (params.status !== "cancelled") {
      if (!Number.isInteger(numericChatId)) continue;
      if (orderTargetsByChatId.has(numericChatId)) continue;
    }

    try {
      const sent = await sendMessage({
        botToken: config.telegram.botToken,
        chatId,
        text: orderStatusMessage.text,
        replyMarkup: orderStatusMessage.reply_markup,
      });
      persistedTargets.push({ chatId: sent.chat.id, messageId: sent.message_id });
    } catch (error) {
      logError(
        params.logger,
        { err: error, chatId, orderId: context.order.id, status: params.status },
        params.status === "cancelled"
          ? "Failed to send duplicated cancelled order message"
          : "Failed to send final order status to fallback order chat",
      );
    }
  }

  if (persistedTargets.length === 0) {
    logWarn(
      params.logger,
      { orderId: context.order.id, status: params.status },
      "No Telegram order message targets found for final status sync",
    );
    return;
  }

  try {
    const supabase = createServiceSupabaseClient();
    const dedupedTargets = dedupeNotifyTargets(persistedTargets);
    const firstTarget = dedupedTargets[0] ?? null;
    await supabase
      .from("orders")
      .update({
        notify_chat_id: firstTarget?.chatId ?? null,
        notify_message_id: firstTarget?.messageId ?? null,
        notify_sent_at: new Date().toISOString(),
        notify_targets: toNotifyTargetRecords(dedupedTargets),
      })
      .eq("id", context.order.id);
  } catch (error) {
    logError(
      params.logger,
      { err: error, orderId: context.order.id },
      "Failed to persist Telegram notify targets after final status sync",
    );
  }
}
