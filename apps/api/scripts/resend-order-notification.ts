import { config } from "../src/config.js";
import {
  buildOrderTelegramMessage,
  type CitySlug,
  type OrderStatus,
} from "../src/order/telegramMessage.js";
import { sendOrderNotificationToChats } from "../src/order/sendOrderNotification.js";
import { buildNotifyTargetRecords } from "../src/order/telegramFinalStatus.js";
import { createServiceSupabaseClient } from "../src/supabase/serviceClient.js";

const TEST_ORDER_SELF_CHAT_ID = "1208488286";

type Args = {
  orderId: string;
  dryRun: boolean;
  skipDbUpdate: boolean;
};

type OrderRow = {
  id: string;
  status: string;
  city_id: number | null;
  tg_user_id: number;
  tg_username: string | null;
  delivery_method: string;
  comment: string | null;
  total_price: number;
  discount_amount: number;
  notify_chat_id: number | null;
  notify_message_id: number | null;
  notify_sent_at: string | null;
};

function parseArgs(argv: string[]): Args {
  let orderId: string | null = null;
  let dryRun = false;
  let skipDbUpdate = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--skip-db-update") {
      skipDbUpdate = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (orderId) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    orderId = arg.trim();
  }

  if (!orderId) {
    throw new Error(
      "Usage: pnpm -C apps/api tsx scripts/resend-order-notification.ts <order-id> [--dry-run] [--skip-db-update]",
    );
  }

  if (!isUuid(orderId)) {
    throw new Error(`Invalid order id: ${orderId}`);
  }

  return { orderId, dryRun, skipDbUpdate };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function parseOrderStatus(value: unknown): OrderStatus {
  if (value === "new" || value === "processing" || value === "done" || value === "cancelled") {
    return value;
  }
  return "new";
}

function parseCitySlug(value: unknown): CitySlug {
  if (value === "vvo" || value === "blg") return value;
  throw new Error(`Unsupported city slug on order: ${String(value)}`);
}

function pickTelegramChatIds(citySlug: CitySlug): string[] {
  if (citySlug === "vvo") {
    return config.telegram.chatIdsVvo ?? config.telegram.chatIdsOwner;
  }
  return config.telegram.chatIdsBlg ?? config.telegram.chatIdsOwner;
}

function pickTelegramChatIdsForOrder(params: {
  citySlug: CitySlug;
  tgUserId: number;
}): string[] {
  const selfChatId = String(params.tgUserId);
  if (selfChatId === TEST_ORDER_SELF_CHAT_ID) {
    return [selfChatId];
  }
  return pickTelegramChatIds(params.citySlug);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const supabase = createServiceSupabaseClient();

  const { data: orderData, error: orderError } = await supabase
    .from("orders")
    .select(
      "id,status,city_id,tg_user_id,tg_username,delivery_method,comment,total_price,discount_amount,notify_chat_id,notify_message_id,notify_sent_at",
    )
    .eq("id", args.orderId)
    .maybeSingle();

  if (orderError) {
    throw new Error(`Failed to load order: ${orderError.message}`);
  }
  if (!orderData) {
    throw new Error(`Order not found: ${args.orderId}`);
  }

  const order = orderData as OrderRow;
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

  const { data: orderItems, error: orderItemsError } = await supabase
    .from("order_items")
    .select("product_id,qty,unit_price")
    .eq("order_id", order.id);

  if (orderItemsError) {
    throw new Error(`Failed to load order items: ${orderItemsError.message}`);
  }
  if (!orderItems || orderItems.length === 0) {
    throw new Error(`Order ${order.id} has no order_items`);
  }

  const productIds = Array.from(
    new Set(
      orderItems
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

  const lines = orderItems.map((item) => ({
    title: item.product_id ? titleById.get(item.product_id) ?? "Unknown" : "Unknown",
    qty: item.qty,
    unitPrice: item.unit_price,
  }));

  const telegramMessage = buildOrderTelegramMessage({
    status: parseOrderStatus(order.status),
    cityName: city.name,
    citySlug,
    tgUser: { id: order.tg_user_id, username: order.tg_username },
    deliveryMethod: order.delivery_method,
    comment: order.comment,
    lines,
    totalPrice: order.total_price,
    discountApplied: order.discount_amount > 0,
    orderId: order.id,
  });

  const chatIds = pickTelegramChatIdsForOrder({
    citySlug,
    tgUserId: order.tg_user_id,
  });

  console.log(`Order: ${order.id}`);
  console.log(`Status: ${order.status}`);
  console.log(`City: ${city.name} (${citySlug})`);
  console.log(`Target chats: ${chatIds.join(", ")}`);
  if (order.notify_sent_at) {
    console.log(
      `Existing notify_*: chat_id=${order.notify_chat_id ?? "null"} message_id=${order.notify_message_id ?? "null"} sent_at=${order.notify_sent_at}`,
    );
  } else {
    console.log("Existing notify_*: null");
  }

  if (args.dryRun) {
    console.log("Dry run only. Notification was not sent.");
    return;
  }

  const notificationResult = await sendOrderNotificationToChats({
    botToken: config.telegram.botToken,
    chatIds,
    text: telegramMessage.text,
    replyMarkup: telegramMessage.reply_markup,
  });
  const sentMessages = notificationResult.sentMessages;
  const firstSent = sentMessages[0] ?? null;
  const sentCount = sentMessages.length;

  for (const sent of sentMessages) {
    console.log(`Sent to chat ${sent.chat.id}: message_id=${sent.message_id}`);
  }

  if (notificationResult.fallbackWithoutMarkupChatIds.length > 0) {
    console.log(
      `Fallback without buttons used for chats: ${notificationResult.fallbackWithoutMarkupChatIds.join(", ")}`,
    );
  }

  if (!firstSent) {
    throw new Error("Notification resend failed for all configured chats");
  }

  if (!args.skipDbUpdate) {
    const { error: updateError } = await supabase
      .from("orders")
      .update({
        notify_chat_id: firstSent.chat.id,
        notify_message_id: firstSent.message_id,
        notify_sent_at: new Date().toISOString(),
        notify_targets: buildNotifyTargetRecords(sentMessages),
      })
      .eq("id", order.id);

    if (updateError) {
      throw new Error(`Notification sent, but failed to update orders.notify_*: ${updateError.message}`);
    }
  }

  console.log(`Done. Sent ${sentCount}/${chatIds.length} notification(s).`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
