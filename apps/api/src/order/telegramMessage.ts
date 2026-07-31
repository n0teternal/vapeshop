import type { TelegramReplyMarkup } from "../telegram/api.js";
import {
  buildConversationRequestButton,
  buildConversationRequestConfirmButton,
} from "./conversationRequest.js";
import { parseOrderComment } from "./orderComment.js";

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
  promotionDiscountAmount?: number;
  couponCode?: string | null;
  couponDiscountAmount?: number;
  pointsDiscountAmount?: number;
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

function formatDeliveryDateLabel(value: string): string {
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${day}.${month}.${year}`;
}

function formatAdminAddress(value: string): string {
  return value
    .replace(/^Россия,\s*/i, "")
    .replace(/^Амурская область,\s*/i, "")
    .replace(/^Благовещенск,\s*/i, "")
    .trim();
}

function buildCommentPart(comment: string | null): string {
  if (!comment) return "";

  const parsed = parseOrderComment(comment);
  const lines: string[] = [];
  if (parsed.phone) {
    lines.push(`Телефон: ${escapeHtml(parsed.phone)}`);
  }
  if (parsed.address) {
    lines.push(`Адрес: ${escapeHtml(formatAdminAddress(parsed.address))}`);
  }
  if (parsed.deliveryDate) {
    lines.push(`Дата доставки: ${escapeHtml(formatDeliveryDateLabel(parsed.deliveryDate))}`);
  }
  if (parsed.deliveryTimeSlot) {
    lines.push(`Время доставки: ${escapeHtml(parsed.deliveryTimeSlot)}`);
  }
  if (parsed.comment) {
    lines.push(`Комментарий: ${escapeHtml(parsed.comment)}`);
  }

  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

function buildOrderBody(params: OrderMessageBaseParams): string {
  const cityLine = `${escapeHtml(params.cityName)} (${params.citySlug.toUpperCase()})`;
  const normalizedUsername = normalizeTelegramUsername(params.tgUser.username);
  const userLine = normalizedUsername
    ? `@${escapeHtml(normalizedUsername)} (${params.tgUser.id})`
    : params.tgUser.id > 0
      ? `${params.tgUser.id}`
      : "Гость";

  const itemsLines = params.lines
    .map((line) => `• ${escapeHtml(line.title)} ×${line.qty} — ${formatRub(line.unitPrice)}`)
    .join("\n");

  const paymentPart = params.paymentMethod
    ? `\n\u041e\u043f\u043b\u0430\u0442\u0430: <b>${escapeHtml(formatOrderPaymentMethodLabel(params.paymentMethod))}</b>`
    : "";

  const discountLines: string[] = [];
  const promotionDiscountAmount = Math.max(
    0,
    Math.trunc(params.promotionDiscountAmount ?? 0),
  );
  const pointsDiscountAmount = Math.max(0, Math.trunc(params.pointsDiscountAmount ?? 0));
  if (promotionDiscountAmount > 0) {
    discountLines.push(`\u0410\u043a\u0446\u0438\u044f: -${formatRub(promotionDiscountAmount)}`);
  }
  const couponDiscountAmount = Math.max(0, Math.trunc(params.couponDiscountAmount ?? 0));
  if (couponDiscountAmount > 0) {
    const code = params.couponCode ? ` ${escapeHtml(params.couponCode)}` : "";
    discountLines.push(`Промокод${code}: -${formatRub(couponDiscountAmount)}`);
  }
  if (pointsDiscountAmount > 0) {
    discountLines.push(`\u0411\u0430\u043b\u043b\u044b: -${formatRub(pointsDiscountAmount)}`);
  }
  const discountsPart = discountLines.length > 0 ? `\n${discountLines.join("\n")}` : "";

  const commentPart = buildCommentPart(params.comment);
  const promotionBadgePart =
    promotionDiscountAmount > 0 ? `<b>\u0410\u041a\u0426\u0418\u042f!</b>\n` : "";
  const totalSuffix =
    promotionDiscountAmount > 0 || couponDiscountAmount > 0
      ? " - \u0410\u041a\u0426\u0418\u042f!"
      : params.discountApplied
        ? " - \u0421\u041a\u0418\u0414\u041a\u0410!"
        : "";

  return (
    `Город: ${cityLine}\n` +
    `Юзер: ${userLine}\n` +
    `Заказ: <b>#${escapeHtml(shortOrderId(params.orderId))}</b>\n\n` +
    promotionBadgePart +
    `<b>Позиции</b>\n` +
    `${itemsLines}${discountsPart}\n\n` +
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
