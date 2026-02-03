import type { TelegramReplyMarkup } from "../telegram/api.js";

export type OrderStatus = "new" | "processing" | "done";

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

type TelegramOrderActionsView = "main" | "done_confirm";

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatRub(value: number): string {
  const rounded = Math.round(value);
  return `${rounded} ₽`;
}

function statusPrefix(status: OrderStatus): string {
  if (status === "processing") return "🟡 <b>В работе</b>\n";
  if (status === "done") return "✅ <b>Готово</b>\n";
  return "";
}

function shortOrderId(orderId: string): string {
  const suffix = orderId.slice(-6);
  return suffix.toUpperCase();
}

export function buildOrderTelegramMessage(params: {
  status: OrderStatus;
  actionsView?: TelegramOrderActionsView;
  cityName: string;
  citySlug: CitySlug;
  tgUser: TgUser;
  deliveryMethod: string;
  comment: string | null;
  lines: OrderLine[];
  totalPrice: number;
  orderId: string;
}): TelegramOrderMessage {
  const actionsView: TelegramOrderActionsView = params.actionsView ?? "main";
  const cityLine = `${escapeHtml(params.cityName)} (${params.citySlug.toUpperCase()})`;
  const userLine = params.tgUser.username
    ? `@${escapeHtml(params.tgUser.username)} (${params.tgUser.id})`
    : `${params.tgUser.id}`;

  const itemsLines = params.lines
    .map((l) => `• ${escapeHtml(l.title)} ×${l.qty} — ${formatRub(l.unitPrice)}`)
    .join("\n");

  const commentPart = params.comment
    ? `\nКомментарий: ${escapeHtml(params.comment)}`
    : "";

  const text =
    statusPrefix(params.status) +
    `<b>Новый заказ</b>\n` +
    `Город: ${cityLine}\n` +
    `Юзер: ${userLine}\n` +
    `Заказ: <b>#${escapeHtml(shortOrderId(params.orderId))}</b>\n\n` +
    `<b>Позиции</b>\n` +
    `${itemsLines}\n\n` +
    `<b>Итого:</b> ${formatRub(params.totalPrice)}\n` +
    `Получение: ${escapeHtml(params.deliveryMethod)}` +
    commentPart +
    `\n\nUUID: <code>${escapeHtml(params.orderId)}</code>`;

  const reply_markup: TelegramReplyMarkup = {
    inline_keyboard: [
      ...(params.status === "done"
        ? []
        : actionsView === "done_confirm"
          ? [
              [
                {
                  text: "Подтвердить ✅",
                  callback_data: `status:done:${params.orderId}`,
                },
              ],
              [
                {
                  text: "⬅ Назад",
                  callback_data: `ui:main:${params.orderId}`,
                },
              ],
            ]
          : [
              [
                {
                  text: "✅ Готово",
                  callback_data: `ui:done_confirm:${params.orderId}`,
                },
              ],
            ]),
      [
        {
          text: "Написать клиенту",
          url: `tg://user?id=${params.tgUser.id}`,
        },
      ],
    ],
  };

  return { text, reply_markup };
}
