import type { TelegramReplyMarkup } from "../telegram/api.js";
import {
  buildConversationRequestButton,
  buildConversationRequestConfirmButton,
} from "./conversationRequest.js";

export type OrderStatus = "new" | "processing" | "done" | "cancelled";
export type OrderPaymentMethod = "cash" | "card";

export type CitySlug = "vvo" | "blg";

export type TgUser = { id: number; username: string | null };

export type OrderLine = {
  title: string;
  qty: number;
  unitPrice: number;
};

export type TelegramOrderMessage = {
  text: string;
  reply_markup: TelegramReplyMarkup;
};

type TelegramOrderActionsView = "main" | "done_confirm" | "cancel_confirm" | "contact_confirm";

type OrderMessageBaseParams = {
  cityName: string;
  citySlug: CitySlug;
  tgUser: TgUser;
  deliveryMethod: string;
  comment: string | null;
  lines: OrderLine[];
  totalPrice: number;
  discountApplied?: boolean;
  paymentMethod?: OrderPaymentMethod;
  orderId: string;
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

export function formatOrderPaymentMethodLabel(method: OrderPaymentMethod): string {
  return method === "cash" ? "\u041d\u0430\u043b\u0438\u0447\u043d\u044b\u0435" : "\u041a\u0430\u0440\u0442\u0430";
}

function statusPrefix(status: OrderStatus): string {
  if (status === "processing") return "🟡 <b>В работе</b>\n";
  if (status === "done") return "✅ <b>Готово</b>\n";
  if (status === "cancelled") return "❌ <b>Отменён</b>\n";
  return "";
}

function editedPrefix(isEdited: boolean | undefined): string {
  return isEdited ? "✏️ <b>Изменено</b>\n" : "";
}

function shortOrderId(orderId: string): string {
  return orderId.slice(-6).toUpperCase();
}

function normalizeTelegramUsername(username: string | null): string | null {
  if (!username) return null;
  const normalized = username.trim().replace(/^@+/, "");
  return normalized.length > 0 ? normalized : null;
}

function buildOrderBody(params: OrderMessageBaseParams): string {
  const cityLine = `${escapeHtml(params.cityName)} (${params.citySlug.toUpperCase()})`;
  const normalizedUsername = normalizeTelegramUsername(params.tgUser.username);
  const userLine = normalizedUsername
    ? `@${escapeHtml(normalizedUsername)} (${params.tgUser.id})`
    : `${params.tgUser.id}`;

  const itemsLines = params.lines
    .map((line) => `• ${escapeHtml(line.title)} ×${line.qty} — ${formatRub(line.unitPrice)}`)
    .join("\n");

  const paymentPart = params.paymentMethod
    ? `\n\u041e\u043f\u043b\u0430\u0442\u0430: <b>${escapeHtml(formatOrderPaymentMethodLabel(params.paymentMethod))}</b>`
    : "";

  const commentPart = params.comment ? `\nКомментарий: ${escapeHtml(params.comment)}` : "";
  const totalSuffix = params.discountApplied ? " - СКИДКА!" : "";

  return (
    `Город: ${cityLine}\n` +
    `Юзер: ${userLine}\n` +
    `Заказ: <b>#${escapeHtml(shortOrderId(params.orderId))}</b>\n\n` +
    `<b>Позиции</b>\n` +
    `${itemsLines}\n\n` +
    `<b>Итого:</b> ${formatRub(params.totalPrice)}${totalSuffix}\n` +
    `Получение: ${escapeHtml(params.deliveryMethod)}` +
    paymentPart +
    commentPart +
    `\n\nUUID: <code>${escapeHtml(params.orderId)}</code>`
  );
}

export function buildOrderTelegramMessage(
  params: OrderMessageBaseParams & {
    status: OrderStatus;
    actionsView?: TelegramOrderActionsView;
    isEdited?: boolean;
  },
): TelegramOrderMessage {
  const actionsView: TelegramOrderActionsView = params.actionsView ?? "main";
  const hasFinalStatus = params.status === "done" || params.status === "cancelled";
  const actionPromptPrefix =
    actionsView === "done_confirm" && !hasFinalStatus
      ? "\u0412\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043f\u043e\u0441\u043e\u0431 \u043e\u043f\u043b\u0430\u0442\u044b:\n"
      : "";
  const text =
    statusPrefix(params.status) +
    editedPrefix(params.isEdited) +
    actionPromptPrefix +
    `<b>Новый заказ</b>\n` +
    buildOrderBody(params);
  const inline_keyboard =
    actionsView === "contact_confirm"
      ? [
          [buildConversationRequestConfirmButton(params.orderId)],
          [{ text: "⬅ Назад", callback_data: `ui:main:${params.orderId}` }],
        ]
      : [
          ...(!hasFinalStatus
            ? actionsView === "done_confirm"
              ? [
                  [
                    {
                      text: "\u041d\u0430\u043b\u0438\u0447\u043d\u044b\u0435",
                      callback_data: `status:done:cash:${params.orderId}`,
                    },
                    {
                      text: "\u041a\u0430\u0440\u0442\u0430",
                      callback_data: `status:done:card:${params.orderId}`,
                    },
                  ],
                  [{ text: "⬅ Назад", callback_data: `ui:main:${params.orderId}` }],
                ]
              : actionsView === "cancel_confirm"
                ? [
                    [
                      {
                        text: "Подтвердить ❌",
                        callback_data: `status:cancelled:${params.orderId}`,
                      },
                    ],
                    [{ text: "⬅ Назад", callback_data: `ui:main:${params.orderId}` }],
                  ]
                : [
                    [
                      { text: "✅ Готово", callback_data: `ui:done_confirm:${params.orderId}` },
                      { text: "❌ Отменить", callback_data: `ui:cancel_confirm:${params.orderId}` },
                    ],
                  ]
            : []),
          [buildConversationRequestButton(params.orderId)],
        ];

  return {
    text,
    reply_markup: {
      inline_keyboard,
    },
  };
}

export function buildOrderStatusTelegramText(
  params: OrderMessageBaseParams & {
    status: Extract<OrderStatus, "done" | "cancelled">;
    isEdited?: boolean;
  },
): string {
  return (
    statusPrefix(params.status) +
    editedPrefix(params.isEdited) +
    `<b>Обновление заказа</b>\n` +
    buildOrderBody(params)
  );
}
