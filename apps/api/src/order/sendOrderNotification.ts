import {
  sendMessage,
  type TelegramMessage,
  type TelegramReplyMarkup,
} from "../telegram/api.js";

type LoggerLike = {
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

function logWarn(logger: LoggerLike | undefined, fields: Record<string, unknown>, message: string): void {
  if (logger?.warn) {
    logger.warn(fields, message);
    return;
  }
  console.warn(message, fields);
}

function logError(logger: LoggerLike | undefined, fields: Record<string, unknown>, message: string): void {
  if (logger?.error) {
    logger.error(fields, message);
    return;
  }
  console.error(message, fields);
}

export async function sendOrderNotificationToChats(params: {
  botToken: string;
  chatIds: string[];
  text: string;
  replyMarkup?: TelegramReplyMarkup;
  logger?: LoggerLike;
}): Promise<{
  sentMessages: TelegramMessage[];
  fallbackWithoutMarkupChatIds: string[];
}> {
  const sentMessages: TelegramMessage[] = [];
  const fallbackWithoutMarkupChatIds: string[] = [];

  for (const chatId of params.chatIds) {
    try {
      const sent = await sendMessage({
        botToken: params.botToken,
        chatId,
        text: params.text,
        ...(params.replyMarkup ? { replyMarkup: params.replyMarkup } : {}),
      });
      sentMessages.push(sent);
      continue;
    } catch (error) {
      logWarn(
        params.logger,
        { err: error, chatId },
        "Failed to notify Telegram chat with reply markup; retrying without reply markup",
      );
    }

    try {
      const sent = await sendMessage({
        botToken: params.botToken,
        chatId,
        text: params.text,
      });
      sentMessages.push(sent);
      fallbackWithoutMarkupChatIds.push(chatId);
    } catch (retryError) {
      logError(params.logger, { err: retryError, chatId }, "Failed to notify Telegram chat");
    }
  }

  return { sentMessages, fallbackWithoutMarkupChatIds };
}
