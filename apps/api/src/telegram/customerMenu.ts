import { config } from "../config.js";
import type { TelegramReplyMarkup } from "./api.js";

export type CustomerMenuMessage = {
  text: string;
  reply_markup: TelegramReplyMarkup;
};

export type CustomerOrderSummary = {
  id: string;
  status: "new" | "processing" | "done" | "cancelled";
  cityLabel: string;
  totalPrice: number;
  createdAt: string;
};

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatRub(value: number): string {
  return `${Math.round(value)} ₽`;
}

function formatOrderDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatOrderStatus(status: CustomerOrderSummary["status"]): string {
  if (status === "processing") return "В работе";
  if (status === "done") return "Готов";
  if (status === "cancelled") return "Отменён";
  return "Новый";
}

function getBotUsername(): string | null {
  const raw = config.telegram.botUsername?.trim().replace(/^@+/, "") ?? "";
  return raw.length > 0 ? raw : null;
}

export function getMiniAppEntryUrl(): string | null {
  const botUsername = getBotUsername();
  if (!botUsername) return null;

  const shortName = config.telegram.miniAppShortName?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  if (shortName.length > 0) {
    return `https://t.me/${botUsername}/${shortName}`;
  }

  return `https://t.me/${botUsername}`;
}

export function buildCustomerMainMenuMessage(): CustomerMenuMessage {
  const shopUrl = getMiniAppEntryUrl();

  const inlineKeyboard: TelegramReplyMarkup["inline_keyboard"] = [];
  if (shopUrl) {
    inlineKeyboard.push([{ text: "🛍 Магазин", url: shopUrl }]);
  }
  inlineKeyboard.push([{ text: "📦 Мои заказы", callback_data: "menu:orders" }]);
  inlineKeyboard.push([{ text: "👥 Пригласить друга", callback_data: "menu:referral" }]);

  return {
    text: "<b>Главное меню</b>\n\nВыберите, что открыть.",
    reply_markup: {
      inline_keyboard: inlineKeyboard,
    },
  };
}

export function buildCustomerOrdersMenuMessage(
  orders: CustomerOrderSummary[],
): CustomerMenuMessage {
  const body =
    orders.length === 0
      ? "У вас пока нет заказов."
      : orders
          .map((order) => {
            const shortId = order.id.slice(-6).toUpperCase();
            return (
              `<b>#${escapeHtml(shortId)}</b> • ${escapeHtml(formatOrderStatus(order.status))}\n` +
              `${escapeHtml(order.cityLabel)} • ${formatRub(order.totalPrice)}\n` +
              `${escapeHtml(formatOrderDate(order.createdAt))}`
            );
          })
          .join("\n\n");

  return {
    text: `<b>Мои заказы</b>\n\n${body}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Обновить", callback_data: "menu:orders" }],
        [{ text: "⬅ Главное меню", callback_data: "menu:main" }],
      ],
    },
  };
}

export function buildCustomerReferralMenuMessage(params: {
  referralLink: string;
}): CustomerMenuMessage {
  const shareText = "Рады видеть тебя в магазине SDFG!";
  const shareUrl =
    `https://t.me/share/url?url=${encodeURIComponent(params.referralLink)}` +
    `&text=${encodeURIComponent(shareText)}`;
  const shopUrl = getMiniAppEntryUrl();

  const inlineKeyboard: TelegramReplyMarkup["inline_keyboard"] = [
    [{ text: "👥 Поделиться", url: shareUrl }],
  ];

  if (shopUrl) {
    inlineKeyboard.push([{ text: "🛍 Магазин", url: shopUrl }]);
  }

  inlineKeyboard.push([{ text: "⬅ Главное меню", callback_data: "menu:main" }]);

  return {
    text:
      "<b>Пригласить друга</b>\n\n" +
      "Нажмите кнопку ниже, чтобы открыть список чатов и отправить приглашение.\n\n" +
      `<code>${escapeHtml(params.referralLink)}</code>`,
    reply_markup: {
      inline_keyboard: inlineKeyboard,
    },
  };
}
