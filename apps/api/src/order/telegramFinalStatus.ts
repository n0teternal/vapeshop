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
  type OrderPaymentMethod,
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
  created_at: string;
  city_id: number | null;
  tg_user_id: number;
  tg_username: string | null;
  delivery_method: string;
  comment: string | null;
  total_price: unknown;
  discount_amount: unknown;
  promotion_discount_amount: unknown;
  coupon_id: string | null;
  coupon_discount_amount: unknown;
  notify_chat_id: number | null;
  notify_message_id: number | null;
  notify_targets: unknown;
  edited_at: string | null;
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

function parseOrderStatus(value: unknown): OrderStatus {
  if (value === "new" || value === "processing" || value === "done" || value === "cancelled") {
    return value;
  }
  return "new";
}

async function persistNotifyTargets(params: {
  orderId: string;
  targets: NotifyTarget[];
}): Promise<void> {
  const supabase = createServiceSupabaseClient();
  const dedupedTargets = dedupeNotifyTargets(params.targets);
  const firstTarget = dedupedTargets[0] ?? null;

  await supabase
    .from("orders")
    .update({
      notify_chat_id: firstTarget?.chatId ?? null,
      notify_message_id: firstTarget?.messageId ?? null,
      notify_sent_at: new Date().toISOString(),
      notify_targets: toNotifyTargetRecords(dedupedTargets),
    })
    .eq("id", params.orderId);
}

async function loadOrderContext(orderId: string): Promise<{
  order: OrderRow;
  city: { id: number; name: string; slug: string };
  citySlug: CitySlug;
  lines: Array<{ title: string; qty: number; unitPrice: number }>;
  totalPrice: number;
  discountAmount: number;
  promotionDiscountAmount: number;
  couponDiscountAmount: number;
  isEdited: boolean;
}> {
  const supabase = createServiceSupabaseClient();

  const { data: orderData, error: orderError } = await supabase
    .from("orders")
    .select(
      "id,status,created_at,city_id,tg_user_id,tg_username,delivery_method,comment,total_price,discount_amount,promotion_discount_amount,coupon_id,coupon_discount_amount,notify_chat_id,notify_message_id,notify_targets,edited_at",
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
    promotionDiscountAmount:
      order.promotion_discount_amount === null || order.promotion_discount_amount === undefined
        ? 0
        : numberFromUnknown(order.promotion_discount_amount),
    couponDiscountAmount:
      order.coupon_discount_amount === null || order.coupon_discount_amount === undefined
        ? 0
        : numberFromUnknown(order.coupon_discount_amount),
    isEdited: typeof order.edited_at === "string" && order.edited_at.trim().length > 0,
  };
}

async function isRecentCityOrder(params: {
  cityId: number;
  orderId: string;
  limit?: number;
}): Promise<boolean> {
  const supabase = createServiceSupabaseClient();
  const limit = params.limit ?? 3;
  const { data, error } = await supabase
    .from("orders")
    .select("id")
    .eq("city_id", params.cityId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load recent city orders: ${error.message}`);
  }

  return (data ?? []).some((row) => row.id === params.orderId);
}

export async function syncFinalOrderTelegramState(params: {
  orderId: string;
  status: FinalOrderStatus;
  paymentMethod?: OrderPaymentMethod;
  fallbackTarget?: NotifyTarget | null;
  skipStatusChats?: boolean;
  cancelledOrderChatsMode?: "auto" | "edit_only";
  logger?: LoggerLike;
}): Promise<void> {
  const context = await loadOrderContext(params.orderId);
  const cancelledOrderChatsMode = params.cancelledOrderChatsMode ?? "auto";
  const shouldDuplicateCancelledOrderChats =
    params.status === "cancelled"
      ? cancelledOrderChatsMode === "edit_only"
        ? false
        : !(await isRecentCityOrder({
            cityId: context.order.city_id ?? 0,
            orderId: context.order.id,
            limit: 3,
          }))
      : false;
  const shouldDeleteExistingOrderMessages =
    params.status === "done" ||
    (params.status === "cancelled" && shouldDuplicateCancelledOrderChats);

  const statusTextParams: Parameters<typeof buildOrderStatusTelegramText>[0] = {
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
    promotionDiscountAmount: context.promotionDiscountAmount,
    couponCode: context.order.coupon_id,
    couponDiscountAmount: context.couponDiscountAmount,
    pointsDiscountAmount: context.discountAmount,
    discountApplied:
      context.discountAmount > 0 ||
      context.promotionDiscountAmount > 0 ||
      context.couponDiscountAmount > 0,
    orderId: context.order.id,
    isEdited: context.isEdited,
  };
  if (params.status === "done" && params.paymentMethod) {
    statusTextParams.paymentMethod = params.paymentMethod;
  }

  const statusText = buildOrderStatusTelegramText(statusTextParams);
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
    promotionDiscountAmount: context.promotionDiscountAmount,
    couponCode: context.order.coupon_id,
    couponDiscountAmount: context.couponDiscountAmount,
    pointsDiscountAmount: context.discountAmount,
    discountApplied:
      context.discountAmount > 0 ||
      context.promotionDiscountAmount > 0 ||
      context.couponDiscountAmount > 0,
    orderId: context.order.id,
    isEdited: context.isEdited,
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

  const persistedTargets: NotifyTarget[] =
    params.status === "cancelled" && shouldDuplicateCancelledOrderChats
      ? []
      : [...notifyTargets];

  for (const target of notifyTargets) {
    if (shouldDeleteExistingOrderMessages) {
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
          params.status === "done"
            ? "Failed to delete Telegram order message; falling back to edit"
            : "Failed to delete cancelled Telegram order message before repost; falling back to edit",
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
            params.status === "done"
              ? "Failed to edit Telegram order message after delete failure"
              : "Failed to edit cancelled Telegram order message after delete failure",
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

  if (params.status === "cancelled" && cancelledOrderChatsMode === "edit_only") {
    orderChatIdsToNotify.clear();
  }

  for (const chatId of orderChatIdsToNotify) {
    const numericChatId = Number(chatId);

    if (params.status !== "cancelled") {
      if (!Number.isInteger(numericChatId)) continue;
      if (orderTargetsByChatId.has(numericChatId)) continue;
    } else if (!shouldDuplicateCancelledOrderChats) {
      if (Number.isInteger(numericChatId) && orderTargetsByChatId.has(numericChatId)) continue;
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
    await persistNotifyTargets({
      orderId: context.order.id,
      targets: persistedTargets,
    });
  } catch (error) {
    logError(
      params.logger,
      { err: error, orderId: context.order.id },
      "Failed to persist Telegram notify targets after final status sync",
    );
  }
}

export async function syncEditedOrderTelegramState(params: {
  orderId: string;
  fallbackTarget?: NotifyTarget | null;
  logger?: LoggerLike;
}): Promise<void> {
  const context = await loadOrderContext(params.orderId);
  const shouldRepostEditedOrder = !(await isRecentCityOrder({
    cityId: context.order.city_id ?? 0,
    orderId: context.order.id,
    limit: 3,
  }));

  const editedOrderMessage = buildOrderTelegramMessage({
    status: parseOrderStatus(context.order.status),
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
    promotionDiscountAmount: context.promotionDiscountAmount,
    pointsDiscountAmount: context.discountAmount,
    discountApplied: context.discountAmount > 0 || context.promotionDiscountAmount > 0,
    orderId: context.order.id,
    isEdited: true,
  });

  const notifyTargets = readNotifyTargets({
    notifyTargets: context.order.notify_targets,
    notifyChatId: context.order.notify_chat_id,
    notifyMessageId: context.order.notify_message_id,
    fallbackTarget: params.fallbackTarget ?? null,
  });
  const persistedTargets: NotifyTarget[] = shouldRepostEditedOrder ? [] : [...notifyTargets];
  const orderChatIdsToNotify = new Set<string>(pickOrderChatIds(context.citySlug));
  for (const target of notifyTargets) {
    orderChatIdsToNotify.add(String(target.chatId));
  }

  for (const target of notifyTargets) {
    if (shouldRepostEditedOrder) {
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
          "Failed to delete edited Telegram order message before repost; falling back to edit",
        );

        try {
          await editMessageText({
            botToken: config.telegram.botToken,
            chatId: target.chatId,
            messageId: target.messageId,
            text: editedOrderMessage.text,
            replyMarkup: editedOrderMessage.reply_markup,
          });
          persistedTargets.push(target);
        } catch (editError) {
          logError(
            params.logger,
            {
              err: editError,
              chatId: target.chatId,
              messageId: target.messageId,
              orderId: context.order.id,
            },
            "Failed to edit Telegram order message after delete failure during edit sync",
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
        text: editedOrderMessage.text,
        replyMarkup: editedOrderMessage.reply_markup,
      });
    } catch (error) {
      logError(
        params.logger,
        { err: error, chatId: target.chatId, messageId: target.messageId, orderId: context.order.id },
        "Failed to edit Telegram order message",
      );
    }
  }

  const existingChatIds = new Set<number>(persistedTargets.map((target) => target.chatId));
  for (const chatId of orderChatIdsToNotify) {
    const numericChatId = Number(chatId);
    if (Number.isInteger(numericChatId) && existingChatIds.has(numericChatId)) {
      continue;
    }

    try {
      const sent = await sendMessage({
        botToken: config.telegram.botToken,
        chatId,
        text: editedOrderMessage.text,
        replyMarkup: editedOrderMessage.reply_markup,
      });
      persistedTargets.push({ chatId: sent.chat.id, messageId: sent.message_id });
      existingChatIds.add(sent.chat.id);
    } catch (error) {
      logError(
        params.logger,
        { err: error, chatId, orderId: context.order.id },
        shouldRepostEditedOrder
          ? "Failed to repost edited order message"
          : "Failed to send edited order message to missing chat",
      );
    }
  }

  if (persistedTargets.length === 0) {
    logWarn(
      params.logger,
      { orderId: context.order.id },
      "No Telegram order message targets found for edited order sync",
    );
    return;
  }

  try {
    await persistNotifyTargets({
      orderId: context.order.id,
      targets: persistedTargets,
    });
  } catch (error) {
    logError(
      params.logger,
      { err: error, orderId: context.order.id },
      "Failed to persist Telegram notify targets after edited order sync",
    );
  }
}
