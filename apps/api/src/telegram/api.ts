export type TelegramInlineKeyboardButton =
  | { text: string; url: string }
  | { text: string; callback_data: string }
  | { text: string; copy_text: { text: string } };

export type TelegramReplyMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

type TelegramChat = {
  id: number;
};

export type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
};

type TelegramApiOk<T> = { ok: true; result: T };
type TelegramApiErr = { ok: false; description?: string; error_code?: number };

type TelegramGetMeResult = {
  username?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTelegramResponse<T>(value: unknown): TelegramApiOk<T> | TelegramApiErr {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return { ok: false, description: "Bad Telegram response" };
  }
  return value as TelegramApiOk<T> | TelegramApiErr;
}

async function callTelegram<T>(params: {
  botToken: string;
  method: string;
  body: Record<string, unknown>;
}): Promise<T> {
  const url = `https://api.telegram.org/bot${params.botToken}/${params.method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params.body),
  });

  const json = (await res.json().catch(() => null)) as unknown;
  const parsed = parseTelegramResponse<T>(json);

  if (!res.ok || parsed.ok === false) {
    const description =
      parsed.ok === false && typeof parsed.description === "string"
        ? parsed.description
        : "Telegram API error";
    const code =
      parsed.ok === false && typeof parsed.error_code === "number"
        ? parsed.error_code
        : res.status;
    throw new Error(`Telegram ${params.method} failed: ${code} ${description}`);
  }

  return parsed.result;
}

async function callTelegramForm<T>(params: {
  botToken: string;
  method: string;
  form: FormData;
}): Promise<T> {
  const url = `https://api.telegram.org/bot${params.botToken}/${params.method}`;
  const res = await fetch(url, {
    method: "POST",
    body: params.form,
  });

  const json = (await res.json().catch(() => null)) as unknown;
  const parsed = parseTelegramResponse<T>(json);
  if (!res.ok || parsed.ok === false) {
    const description =
      parsed.ok === false && typeof parsed.description === "string"
        ? parsed.description
        : "Telegram API error";
    const code =
      parsed.ok === false && typeof parsed.error_code === "number"
        ? parsed.error_code
        : res.status;
    throw new Error(`Telegram ${params.method} failed: ${code} ${description}`);
  }
  return parsed.result;
}

export async function sendMessage(params: {
  botToken: string;
  chatId: string;
  text: string;
  replyMarkup?: TelegramReplyMarkup | undefined;
}): Promise<TelegramMessage> {
  return callTelegram<TelegramMessage>({
    botToken: params.botToken,
    method: "sendMessage",
    body: {
      chat_id: params.chatId,
      text: params.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: params.replyMarkup,
    },
  });
}

export async function sendDocument(params: {
  botToken: string;
  chatId: string;
  buffer: Buffer;
  filename: string;
  caption?: string;
}): Promise<TelegramMessage> {
  const form = new FormData();
  form.set("chat_id", params.chatId);
  form.set(
    "document",
    new Blob([new Uint8Array(params.buffer)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    params.filename,
  );
  if (params.caption) form.set("caption", params.caption);
  return callTelegramForm<TelegramMessage>({
    botToken: params.botToken,
    method: "sendDocument",
    form,
  });
}

export async function editMessageText(params: {
  botToken: string;
  chatId: number;
  messageId: number;
  text: string;
  replyMarkup?: TelegramReplyMarkup | undefined;
}): Promise<void> {
  await callTelegram<true>({
    botToken: params.botToken,
    method: "editMessageText",
    body: {
      chat_id: params.chatId,
      message_id: params.messageId,
      text: params.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: params.replyMarkup,
    },
  });
}

export async function deleteMessage(params: {
  botToken: string;
  chatId: number;
  messageId: number;
}): Promise<void> {
  await callTelegram<true>({
    botToken: params.botToken,
    method: "deleteMessage",
    body: {
      chat_id: params.chatId,
      message_id: params.messageId,
    },
  });
}

export async function answerCallbackQuery(params: {
  botToken: string;
  callbackQueryId: string;
  text: string;
  showAlert?: boolean;
}): Promise<void> {
  await callTelegram<true>({
    botToken: params.botToken,
    method: "answerCallbackQuery",
    body: {
      callback_query_id: params.callbackQueryId,
      text: params.text,
      show_alert: params.showAlert ?? false,
    },
  });
}

export async function getBotUsername(params: {
  botToken: string;
}): Promise<string | null> {
  const result = await callTelegram<TelegramGetMeResult>({
    botToken: params.botToken,
    method: "getMe",
    body: {},
  });

  const username = result.username;
  if (typeof username !== "string") return null;
  const trimmed = username.trim().replace(/^@+/, "");
  return trimmed.length > 0 ? trimmed : null;
}
