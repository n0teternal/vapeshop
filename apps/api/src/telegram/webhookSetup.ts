import { config } from "../config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function callTelegram(method: string, body: Record<string, unknown>): Promise<void> {
  const url = `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => null)) as unknown;
  const ok =
    isRecord(json) &&
    json.ok === true;

  if (!res.ok || !ok) {
    const desc =
      isRecord(json) && typeof json.description === "string" ? json.description : "Telegram API error";
    const code =
      isRecord(json) && typeof json.error_code === "number" ? json.error_code : res.status;
    throw new Error(`Telegram ${method} failed: ${code} ${desc}`);
  }
}

export async function ensureTelegramWebhook(): Promise<void> {
  // Auto-configure webhook in production to avoid "buttons not working" when webhook wasn't set.
  if (config.nodeEnv !== "production") return;

  const webhookUrl = config.telegram.publicWebhookUrl;
  if (!webhookUrl) return;
  if (!webhookUrl.startsWith("https://")) {
    // Telegram requires https for webhooks in production.
    return;
  }

  await callTelegram("setWebhook", {
    url: webhookUrl,
    secret_token: config.telegram.webhookSecret,
  });
}

