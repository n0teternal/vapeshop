import { config } from "../config.js";
import type { TelegramInlineKeyboardButton, TelegramReplyMarkup } from "../telegram/api.js";

type CitySlug = "vvo" | "blg";

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortOrderId(orderId: string): string {
  return orderId.slice(-6).toUpperCase();
}

export function hasTelegramUsername(username: string | null): boolean {
  return typeof username === "string" && username.trim().replace(/^@+/, "").length > 0;
}

export function shouldOfferConversationRequest(params: {
  tgUsername: string | null;
  status: "new" | "processing" | "done" | "cancelled";
}): boolean {
  if (params.status === "done") return false;
  return !hasTelegramUsername(params.tgUsername);
}

export function buildConversationRequestButton(orderId: string): TelegramInlineKeyboardButton {
  return {
    text: "Запросить разговор",
    callback_data: `contact_request:${orderId}`,
  };
}

export function pickOrderAdminUsername(citySlug: CitySlug): string {
  return citySlug === "blg"
    ? config.telegram.orderContactUsernameBlg
    : config.telegram.orderContactUsernameVvo;
}

export function buildCustomerConversationRequestMessage(params: {
  citySlug: CitySlug;
  orderId: string;
}): { text: string; reply_markup: TelegramReplyMarkup } {
  const adminUsername = pickOrderAdminUsername(params.citySlug);
  const orderCode = `#${shortOrderId(params.orderId)}`;
  const copyText = `Заказ ${orderCode}`;

  return {
    text:
      `С вами хочет связаться админ для выполнения заказа.\n\n` +
      `Админ: @${escapeHtml(adminUsername)}\n` +
      `Заказ: <b>${escapeHtml(orderCode)}</b>\n\n` +
      `Отправьте админу сообщение:\n` +
      `<code>${escapeHtml(copyText)}</code>`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "Написать админу", url: `https://t.me/${adminUsername}` }],
        [{ text: `Скопировать: ${copyText}`, copy_text: { text: copyText } }],
      ],
    },
  };
}
