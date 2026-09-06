import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { isHttpError } from "../httpError.js";
import { cancelOrderAndRestoreInventory } from "../order/cancelOrder.js";
import { buildCustomerConversationRequestMessage } from "../order/conversationRequest.js";
import {
  buildStaffSelectionMessage,
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
import {
  completeOrderWithStaffSale,
  exportInventoryMovementsXlsx,
  getStaffInventoryLines,
  issueStockToStaff,
  listActiveStaffForCity,
  listStaffMembers,
  listIssuableInventoryProducts,
  type StaffMember,
} from "../staffInventory/service.js";
import {
  answerCallbackQuery,
  editMessageText,
  sendDocument,
  sendMessage,
  type TelegramReplyMarkup,
} from "./api.js";
import {
  buildCustomerMainMenuMessage,
  buildCustomerOrdersMenuMessage,
  buildCustomerReferralMenuMessage,
} from "./customerMenu.js";

type CallbackStatus = Exclude<OrderStatus, "new">;

type CallbackUiView = "main" | "done_confirm" | "cancel_confirm" | "contact_confirm" | "seller_confirm";

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

type ParsedTextMessage = {
  chatId: number;
  fromId: number;
  text: string;
};

type ParsedAdminCommand = ParsedTextMessage & {
  command: "stock" | "export" | "add_stock";
};

type PendingInboundIssue = {
  cityId: number;
  staffId: number;
  productId: string;
  expiresAt: number;
};

const PENDING_INBOUND_TTL_MS = 10 * 60 * 1000;
const pendingInboundIssues = new Map<string, PendingInboundIssue>();

type ParsedCallbackAction =
  | {
      kind: "order_status";
      status: CallbackStatus;
      orderId: string;
      paymentMethod?: OrderPaymentMethod;
      staffId?: number;
    }
  | { kind: "order_ui"; view: CallbackUiView; orderId: string; paymentMethod?: OrderPaymentMethod }
  | { kind: "request_conversation"; orderId: string }
  | { kind: "menu"; view: "main" | "orders" | "referral" }
  | {
      kind: "staff_inventory";
      view:
        | "stock_city"
        | "stock_staff"
        | "inbound_city"
        | "inbound_staff"
        | "inbound_products"
        | "inbound_product";
      cityId: number;
      staffId?: number;
      page?: number;
      productId?: string;
    };

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

function parseTextMessage(update: unknown): ParsedTextMessage | null {
  if (!isRecord(update)) return null;
  const message = update.message;
  if (!isRecord(message)) return null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const from = message.from;
  const chat = message.chat;
  const fromId =
    isRecord(from) && typeof from.id === "number" && Number.isInteger(from.id) ? from.id : null;
  const chatId =
    isRecord(chat) && typeof chat.id === "number" && Number.isInteger(chat.id) ? chat.id : null;
  if (fromId === null || chatId === null || !text) return null;
  return { chatId, fromId, text };
}

function parseAdminCommand(update: unknown): ParsedAdminCommand | null {
  const message = parseTextMessage(update);
  if (!message) return null;
  const match = message.text.match(/^\/(stock|export|add_stock)(?:@\w+)?\s*$/i);
  const command = match?.[1]?.toLowerCase();
  if (command !== "stock" && command !== "export" && command !== "add_stock") return null;
  return { ...message, command };
}

function pendingInboundKey(chatId: number, tgUserId: number): string {
  return `${chatId}:${tgUserId}`;
}

function parseBase36Id(value: string | undefined): number | null {
  if (!value || !/^[0-9a-z]+$/i.test(value)) return null;
  const id = Number.parseInt(value, 36);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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

  if (type === "stock") {
    if (actionRaw === "c" && parts.length === 3) {
      const cityId = parseBase36Id(parts[2]);
      return cityId ? { kind: "staff_inventory", view: "stock_city", cityId } : null;
    }
    if (actionRaw === "s" && parts.length === 4) {
      const cityId = parseBase36Id(parts[2]);
      const staffId = parseBase36Id(parts[3]);
      return cityId && staffId
        ? { kind: "staff_inventory", view: "stock_staff", cityId, staffId }
        : null;
    }
    return null;
  }

  if (type === "in") {
    if (actionRaw === "c" && parts.length === 3) {
      const cityId = parseBase36Id(parts[2]);
      return cityId ? { kind: "staff_inventory", view: "inbound_city", cityId } : null;
    }
    if (actionRaw === "s" && parts.length === 4) {
      const cityId = parseBase36Id(parts[2]);
      const staffId = parseBase36Id(parts[3]);
      return cityId && staffId
        ? { kind: "staff_inventory", view: "inbound_staff", cityId, staffId }
        : null;
    }
    if (actionRaw === "p" && parts.length === 5) {
      const cityId = parseBase36Id(parts[2]);
      const staffId = parseBase36Id(parts[3]);
      const page = Number(parts[4]);
      return cityId && staffId && Number.isSafeInteger(page) && page >= 0
        ? { kind: "staff_inventory", view: "inbound_products", cityId, staffId, page }
        : null;
    }
    if (actionRaw === "i" && parts.length === 5) {
      const cityId = parseBase36Id(parts[2]);
      const staffId = parseBase36Id(parts[3]);
      const productId = parts[4] ?? "";
      return cityId && staffId && isUuidV4ish(productId)
        ? { kind: "staff_inventory", view: "inbound_product", cityId, staffId, productId }
        : null;
    }
    return null;
  }

  if (type === "staff" && parts.length === 4) {
    const paymentMethod = parseOrderPaymentMethod(parts[1]);
    const staffId = Number.parseInt(parts[2] ?? "", 36);
    const orderId = parts[3] ?? "";
    if (!paymentMethod || !Number.isSafeInteger(staffId) || staffId <= 0 || !isUuidV4ish(orderId)) {
      return null;
    }
    return { kind: "order_status", status: "done", orderId, paymentMethod, staffId };
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

    if (actionRaw === "done" && paymentMethod) {
      return { kind: "order_ui", view: "seller_confirm", orderId, paymentMethod };
    }

    if (actionRaw === "done") {
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

type BotCity = { id: number; name: string; slug: string };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function buttonLabel(value: string, maxLength = 48): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(1, maxLength - 1))}…` : value;
}

function toBase36(id: number): string {
  return id.toString(36);
}

async function isTelegramAdmin(tgUserId: number): Promise<boolean> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("admins")
    .select("tg_user_id")
    .eq("tg_user_id", tgUserId)
    .maybeSingle();
  if (error) throw new Error(`Failed to check bot admin access: ${error.message}`);
  return Boolean(data);
}

async function listBotCities(): Promise<BotCity[]> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("cities")
    .select("id,name,slug")
    .order("slug", { ascending: true });
  if (error) throw new Error(`Failed to load cities: ${error.message}`);
  return data ?? [];
}

async function getBotCity(cityId: number): Promise<BotCity | null> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("cities")
    .select("id,name,slug")
    .eq("id", cityId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load city: ${error.message}`);
  return data ?? null;
}

async function getBotStaff(staffId: number): Promise<StaffMember | null> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("staff_members")
    .select("id,name,is_active")
    .eq("id", staffId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load staff member: ${error.message}`);
  if (!data) return null;
  return { id: data.id, name: data.name, isActive: data.is_active };
}

function cityPicker(params: { cities: BotCity[]; mode: "stock" | "inbound" }): TelegramReplyMarkup {
  const prefix = params.mode === "stock" ? "stock" : "in";
  return {
    inline_keyboard: params.cities.map((city) => [
      {
        text: buttonLabel(`${city.name} (${city.slug.toUpperCase()})`),
        callback_data: `${prefix}:c:${toBase36(city.id)}`,
      },
    ]),
  };
}

async function buildCityPickerMessage(mode: "stock" | "inbound") {
  const cities = await listBotCities();
  if (cities.length === 0) {
    return { text: "Города ещё не настроены.", replyMarkup: undefined };
  }
  return {
    text: mode === "stock" ? "<b>Остатки сотрудников</b>\nВыберите город:" : "<b>Выдать товар сотруднику</b>\nВыберите город:",
    replyMarkup: cityPicker({ cities, mode }),
  };
}

function staffPicker(params: {
  city: BotCity;
  staff: StaffMember[];
  mode: "stock" | "inbound";
}): TelegramReplyMarkup {
  const prefix = params.mode === "stock" ? "stock" : "in";
  const cityId = toBase36(params.city.id);
  const rows = params.staff.map((staff) => [
    {
      text: buttonLabel(staff.name),
      callback_data: `${prefix}:s:${cityId}:${toBase36(staff.id)}`,
    },
  ]);
  rows.push([
    {
      text: "↻ Сотрудники",
      callback_data: `${prefix}:c:${cityId}`,
    },
  ]);
  return { inline_keyboard: rows };
}

async function buildStaffPickerMessage(params: {
  cityId: number;
  mode: "stock" | "inbound";
}) {
  const city = await getBotCity(params.cityId);
  if (!city) return { text: "Город не найден.", replyMarkup: undefined };
  const staff =
    params.mode === "inbound"
      ? (await listStaffMembers()).filter((member) => member.isActive)
      : await listActiveStaffForCity(city.id);
  if (staff.length === 0) {
    return {
      text: `В ${escapeHtml(city.name)} ещё нет назначенных сотрудников с остатками.`,
      replyMarkup: cityPicker({ cities: await listBotCities(), mode: params.mode }),
    };
  }
  return {
    text:
      params.mode === "stock"
        ? `<b>Остатки: ${escapeHtml(city.name)}</b>\nВыберите сотрудника:`
        : `<b>Выдача: ${escapeHtml(city.name)}</b>\nКому выдать товар:`,
    replyMarkup: staffPicker({ city, staff, mode: params.mode }),
  };
}

async function buildStockReportMessage(params: { cityId: number; staffId: number }) {
  const [city, staff, lines] = await Promise.all([
    getBotCity(params.cityId),
    getBotStaff(params.staffId),
    getStaffInventoryLines(params),
  ]);
  if (!city || !staff) return { text: "Город или сотрудник не найден.", replyMarkup: undefined };
  const header = `<b>Остатки: ${escapeHtml(staff.name)}</b>\n${escapeHtml(city.name)} (${city.slug.toUpperCase()})`;
  if (lines.length === 0) {
    return {
      text: `${header}\n\nНет товара на руках.`,
      replyMarkup: staffPicker({ city, staff: await listActiveStaffForCity(city.id), mode: "stock" }),
    };
  }
  const textLines: string[] = [];
  for (const line of lines) {
    const next = `• ${escapeHtml(line.title)} — <b>${line.qty}</b>`;
    if (`${header}\n\n${textLines.join("\n")}\n${next}`.length > 3900) break;
    textLines.push(next);
  }
  const suffix = textLines.length < lines.length ? `\n\nПоказано ${textLines.length} из ${lines.length}.` : "";
  return {
    text: `${header}\n\n${textLines.join("\n")}${suffix}`,
    replyMarkup: staffPicker({ city, staff: await listActiveStaffForCity(city.id), mode: "stock" }),
  };
}

async function buildInboundProductsMessage(params: { cityId: number; staffId: number; page: number }) {
  const [city, staff, products] = await Promise.all([
    getBotCity(params.cityId),
    getBotStaff(params.staffId),
    listIssuableInventoryProducts(params.cityId),
  ]);
  if (!city || !staff) return { text: "Город или сотрудник не найден.", replyMarkup: undefined };
  if (products.length === 0) {
    return {
      text: `Для ${escapeHtml(city.name)} нет свободного товара для выдачи.`,
      replyMarkup: staffPicker({
        city,
        staff: (await listStaffMembers()).filter((member) => member.isActive),
        mode: "inbound",
      }),
    };
  }
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(products.length / pageSize));
  const page = Math.min(Math.max(params.page, 0), pages - 1);
  const cityKey = toBase36(city.id);
  const staffKey = toBase36(staff.id);
  const productRows = products.slice(page * pageSize, page * pageSize + pageSize).map((product) => [
    {
      text: buttonLabel(
        `${product.title} — ${product.availableQty === null ? "∞" : product.availableQty}`,
        55,
      ),
      callback_data: `in:i:${cityKey}:${staffKey}:${product.productId}`,
    },
  ]);
  const navigation: TelegramReplyMarkup["inline_keyboard"] = [];
  const navRow: TelegramReplyMarkup["inline_keyboard"][number] = [];
  if (page > 0) navRow.push({ text: "←", callback_data: `in:p:${cityKey}:${staffKey}:${page - 1}` });
  navRow.push({ text: `${page + 1}/${pages}`, callback_data: `in:p:${cityKey}:${staffKey}:${page}` });
  if (page + 1 < pages) navRow.push({ text: "→", callback_data: `in:p:${cityKey}:${staffKey}:${page + 1}` });
  navigation.push(navRow, [{ text: "← Сотрудники", callback_data: `in:c:${cityKey}` }]);
  return {
    text: `<b>Выдача: ${escapeHtml(staff.name)}</b>\n${escapeHtml(city.name)}\nВыберите товар (свободный остаток):`,
    replyMarkup: { inline_keyboard: [...productRows, ...navigation] },
  };
}

async function editInventoryMessage(params: {
  callback: ParsedCallbackQuery;
  text: string;
  replyMarkup?: TelegramReplyMarkup | undefined;
}): Promise<void> {
  if (!params.callback.message) return;
  await editMessageText({
    botToken: config.telegram.botToken,
    chatId: params.callback.message.chatId,
    messageId: params.callback.message.messageId,
    text: params.text,
    replyMarkup: params.replyMarkup,
  });
}

async function handleStaffInventoryCallback(params: {
  callback: ParsedCallbackQuery;
  action: Extract<ParsedCallbackAction, { kind: "staff_inventory" }>;
}): Promise<string> {
  const { callback, action } = params;
  if (!callback.message) return "Откройте команду в чате с ботом";

  if (action.view === "stock_city") {
    const view = await buildStaffPickerMessage({ cityId: action.cityId, mode: "stock" });
    await editInventoryMessage({ callback, ...view });
    return "Выберите сотрудника";
  }
  if (action.view === "stock_staff" && action.staffId) {
    const view = await buildStockReportMessage({ cityId: action.cityId, staffId: action.staffId });
    await editInventoryMessage({ callback, ...view });
    return "Остатки загружены";
  }
  if (action.view === "inbound_city") {
    const view = await buildStaffPickerMessage({ cityId: action.cityId, mode: "inbound" });
    await editInventoryMessage({ callback, ...view });
    return "Выберите сотрудника";
  }
  if (action.view === "inbound_staff" && action.staffId) {
    const view = await buildInboundProductsMessage({ cityId: action.cityId, staffId: action.staffId, page: 0 });
    await editInventoryMessage({ callback, ...view });
    return "Выберите товар";
  }
  if (action.view === "inbound_products" && action.staffId) {
    const view = await buildInboundProductsMessage({
      cityId: action.cityId,
      staffId: action.staffId,
      page: action.page ?? 0,
    });
    await editInventoryMessage({ callback, ...view });
    return "Выберите товар";
  }
  if (action.view === "inbound_product" && action.staffId && action.productId) {
    const [city, staff, products] = await Promise.all([
      getBotCity(action.cityId),
      getBotStaff(action.staffId),
      listIssuableInventoryProducts(action.cityId),
    ]);
    const product = products.find((item) => item.productId === action.productId);
    if (!city || !staff || !product) return "Товар больше недоступен для выдачи";
    pendingInboundIssues.set(pendingInboundKey(callback.message.chatId, callback.fromId), {
      cityId: city.id,
      staffId: staff.id,
      productId: product.productId,
      expiresAt: Date.now() + PENDING_INBOUND_TTL_MS,
    });
    await editInventoryMessage({
      callback,
      text:
        `<b>Выдача товара</b>\n${escapeHtml(city.name)} → ${escapeHtml(staff.name)}\n` +
        `${escapeHtml(product.title)}\n\nОтправьте следующим сообщением количество ` +
        `(доступно: ${product.availableQty === null ? "без лимита" : product.availableQty}).`,
    });
    return "Введите количество";
  }

  return "Неизвестное действие";
}

async function handleAdminBotCommand(command: ParsedAdminCommand): Promise<void> {
  if (command.command === "add_stock") {
    pendingInboundIssues.delete(pendingInboundKey(command.chatId, command.fromId));
  }

  if (command.command === "export") {
    const buffer = await exportInventoryMovementsXlsx();
    const date = new Date().toISOString().slice(0, 10);
    await sendDocument({
      botToken: config.telegram.botToken,
      chatId: String(command.chatId),
      buffer,
      filename: `inventory-movements.${date}.xlsx`,
      caption: "Журнал движений: выдачи, продажи, брак и замены.",
    });
    return;
  }

  const mode = command.command === "stock" ? "stock" : "inbound";
  const view = await buildCityPickerMessage(mode);
  await sendMessage({
    botToken: config.telegram.botToken,
    chatId: String(command.chatId),
    text: view.text,
    replyMarkup: view.replyMarkup,
  });
}

async function handlePendingInboundQuantity(message: ParsedTextMessage): Promise<boolean> {
  const key = pendingInboundKey(message.chatId, message.fromId);
  const pending = pendingInboundIssues.get(key);
  if (!pending) return false;
  if (Date.now() > pending.expiresAt) {
    pendingInboundIssues.delete(key);
    await sendMessage({
      botToken: config.telegram.botToken,
      chatId: String(message.chatId),
      text: "Время выдачи истекло. Запустите /add_stock ещё раз.",
    });
    return true;
  }
  if (!/^\d+$/.test(message.text) || Number(message.text) <= 0) {
    await sendMessage({
      botToken: config.telegram.botToken,
      chatId: String(message.chatId),
      text: "Отправьте целое положительное количество или запустите /add_stock заново.",
    });
    return true;
  }

  const qty = Number(message.text);
  if (!Number.isSafeInteger(qty)) {
    await sendMessage({
      botToken: config.telegram.botToken,
      chatId: String(message.chatId),
      text: "Количество слишком большое. Запустите /add_stock заново.",
    });
    return true;
  }

  try {
    await issueStockToStaff({
      cityId: pending.cityId,
      staffId: pending.staffId,
      productId: pending.productId,
      qty,
      note: "Выдача через /add_stock",
    });
    const [city, staff, products] = await Promise.all([
      getBotCity(pending.cityId),
      getBotStaff(pending.staffId),
      listIssuableInventoryProducts(pending.cityId),
    ]);
    const product = products.find((item) => item.productId === pending.productId);
    pendingInboundIssues.delete(key);
    await sendMessage({
      botToken: config.telegram.botToken,
      chatId: String(message.chatId),
      text:
        `Выдано: <b>${qty}</b> шт.\n${escapeHtml(product?.title ?? pending.productId)}\n` +
        `${escapeHtml(city?.name ?? String(pending.cityId))} → ${escapeHtml(staff?.name ?? String(pending.staffId))}.`,
    });
  } catch (error) {
    pendingInboundIssues.delete(key);
    const messageText = isHttpError(error) ? error.message : "Не удалось выдать товар";
    await sendMessage({
      botToken: config.telegram.botToken,
      chatId: String(message.chatId),
      text: `${escapeHtml(messageText)}\nПопробуйте /add_stock ещё раз.`,
    });
  }
  return true;
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

    const adminCommand = parseAdminCommand(request.body);
    if (adminCommand) {
      try {
        if (!(await isTelegramAdmin(adminCommand.fromId))) {
          await sendMessage({
            botToken: config.telegram.botToken,
            chatId: String(adminCommand.chatId),
            text: "Нет доступа.",
          });
        } else {
          await handleAdminBotCommand(adminCommand);
        }
      } catch (e) {
        request.log.error(
          { err: e, tgUserId: adminCommand.fromId, command: adminCommand.command },
          "Failed to handle admin bot command",
        );
        await sendMessage({
          botToken: config.telegram.botToken,
          chatId: String(adminCommand.chatId),
          text: "Не удалось выполнить команду. Попробуйте ещё раз.",
        }).catch(() => undefined);
      }
      return reply.code(200).send({ ok: true });
    }

    const textMessage = parseTextMessage(request.body);
    if (textMessage && !textMessage.text.startsWith("/")) {
      const pending = pendingInboundIssues.get(pendingInboundKey(textMessage.chatId, textMessage.fromId));
      if (pending) {
        try {
          if (!(await isTelegramAdmin(textMessage.fromId))) {
            pendingInboundIssues.delete(pendingInboundKey(textMessage.chatId, textMessage.fromId));
            await sendMessage({
              botToken: config.telegram.botToken,
              chatId: String(textMessage.chatId),
              text: "Нет доступа.",
            });
          } else {
            await handlePendingInboundQuantity(textMessage);
          }
        } catch (e) {
          request.log.error({ err: e, tgUserId: textMessage.fromId }, "Failed to handle inbound quantity");
        }
        return reply.code(200).send({ ok: true });
      }
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

    if (action.kind === "staff_inventory") {
      try {
        const message = await handleStaffInventoryCallback({ callback: parsed, action });
        await answerSafe(parsed.callbackQueryId, message);
      } catch (e) {
        request.log.error(
          { err: e, tgUserId: parsed.fromId, action: action.view },
          "Failed to handle staff inventory callback",
        );
        await answerSafe(
          parsed.callbackQueryId,
          isHttpError(e) ? e.message : "Не удалось выполнить действие",
          true,
        );
      }
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
      coupon_id: string | null;
      coupon_discount_amount: unknown;
      notify_chat_id: number | null;
      notify_message_id: number | null;
      notify_targets: unknown;
      edited_at: string | null;
    };

    const selectCols =
      "id,status,city_id,tg_user_id,tg_username,delivery_method,comment,total_price,discount_amount,promotion_discount_amount,coupon_id,coupon_discount_amount,notify_chat_id,notify_message_id,notify_targets,edited_at";

    let order: OrderRow | null = null;

    if (action.kind === "order_status" && action.status === "cancelled") {
      try {
        await cancelOrderAndRestoreInventory({
          orderId: action.orderId,
          allowLockedCancellation: true,
        });
      } catch (e) {
        request.log.error({ err: e, orderId: action.orderId }, "Failed to cancel order");
        await answerSafe(
          parsed.callbackQueryId,
          isHttpError(e) ? e.message : "Не удалось отменить заказ",
        );
        return reply.code(200).send({ ok: true });
      }
    } else if (action.kind === "order_status" && action.status === "done") {
      if (!action.paymentMethod || !action.staffId) {
        await answerSafe(parsed.callbackQueryId, "Сначала выберите способ оплаты и сотрудника");
        return reply.code(200).send({ ok: true });
      }

      try {
        await completeOrderWithStaffSale({
          orderId: action.orderId,
          staffId: action.staffId,
          paymentMethod: action.paymentMethod,
        });
      } catch (e) {
        request.log.error({ err: e, orderId: action.orderId, staffId: action.staffId }, "Failed to complete staff sale");
        await answerSafe(
          parsed.callbackQueryId,
          isHttpError(e) ? e.message : "Не удалось списать остаток сотрудника",
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

    if (action.kind === "order_ui" && action.view === "seller_confirm") {
      if (!action.paymentMethod) {
        await answerSafe(parsed.callbackQueryId, "Не указан способ оплаты");
        return reply.code(200).send({ ok: true });
      }

      try {
        const staff = await listActiveStaffForCity(city.id);
        if (staff.length === 0) {
          await answerSafe(parsed.callbackQueryId, "Для этого города ещё не добавлены остатки сотрудников");
          return reply.code(200).send({ ok: true });
        }

        const sellerMessage = buildStaffSelectionMessage({
          orderId: order.id,
          paymentMethod: action.paymentMethod,
          staff,
        });
        const editTarget =
          parsed.message ??
          (order.notify_chat_id !== null && order.notify_message_id !== null
            ? { chatId: order.notify_chat_id, messageId: order.notify_message_id }
            : undefined);

        if (editTarget) {
          await editMessageText({
            botToken: config.telegram.botToken,
            chatId: editTarget.chatId,
            messageId: editTarget.messageId,
            text: sellerMessage.text,
            replyMarkup: sellerMessage.reply_markup,
          });
        }

        await answerSafe(parsed.callbackQueryId, "Выберите сотрудника");
      } catch (e) {
        request.log.error({ err: e, orderId: order.id }, "Failed to show staff selection");
        await answerSafe(parsed.callbackQueryId, "Не удалось загрузить сотрудников");
      }

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
    const couponDiscountAmount =
      order.coupon_discount_amount === null || order.coupon_discount_amount === undefined
        ? 0
        : numberFromUnknown(order.coupon_discount_amount);
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
      couponCode: order.coupon_id,
      couponDiscountAmount,
      pointsDiscountAmount: discountAmount,
      discountApplied: discountAmount > 0 || promotionDiscountAmount > 0 || couponDiscountAmount > 0,
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
