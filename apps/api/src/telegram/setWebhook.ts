import { config } from "../config.js";

type TelegramApiOk<T> = { ok: true; result: T; description?: string };
type TelegramApiErr = { ok: false; description?: string; error_code?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function callTelegram<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const url = `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => null)) as unknown;
  const parsed: TelegramApiOk<T> | TelegramApiErr =
    isRecord(json) && typeof json.ok === "boolean" ? (json as any) : { ok: false };

  if (!res.ok || parsed.ok === false) {
    const description = parsed.ok === false ? parsed.description ?? "Telegram API error" : "HTTP error";
    const code =
      parsed.ok === false && typeof parsed.error_code === "number" ? parsed.error_code : res.status;
    throw new Error(`${method} failed: ${code} ${description}`);
  }

  return parsed.result;
}

async function main(): Promise<void> {
  const webhookUrl = config.telegram.publicWebhookUrl;
  if (!webhookUrl) {
    throw new Error("PUBLIC_WEBHOOK_URL is not set");
  }

  const isHttps = webhookUrl.startsWith("https://");
  if (!isHttps) {
    // Telegram allows http only in a few special cases (self-hosted/test). For production it must be https.
    // We allow it here for local development, but print a loud warning.
    // eslint-disable-next-line no-console
    console.warn(`WARNING: PUBLIC_WEBHOOK_URL is not https: ${webhookUrl}`);
  }

  await callTelegram<boolean>("setWebhook", {
    url: webhookUrl,
    secret_token: config.telegram.webhookSecret,
    drop_pending_updates: true,
  });

  const info = await callTelegram<unknown>("getWebhookInfo", {});
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(info, null, 2));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

