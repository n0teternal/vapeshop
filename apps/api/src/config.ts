export type NodeEnv = "development" | "production" | "test";

export type AppConfig = {
  nodeEnv: NodeEnv;
  isDev: boolean;
  host: string;
  port: number;
  corsOrigins: string[] | null; // null => allow all (dev)
  supabase: {
    url: string;
    serviceRoleKey: string;
  };
  telegram: {
    botToken: string;
    webhookSecret: string | null;
    publicWebhookUrl: string | null;
    chatIdOwner: string;
    chatIdVvo: string | null;
    chatIdBlg: string | null;
  };
  dev: {
    adminTgUserId: number | null;
  };
};

function readEnv(key: string): string | null {
  const v = process.env[key];
  if (!v) return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function requireEnv(key: string): string {
  const v = readEnv(key);
  if (!v) {
    throw new Error(`Missing required env: ${key}`);
  }
  return v;
}

function parseIntEnv(key: string, fallback: number): number {
  const raw = readEnv(key);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid env ${key}: expected positive integer`);
  }
  return n;
}

function parseCsvEnv(key: string): string[] {
  const raw = readEnv(key);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseOptionalAdminUserId(): number | null {
  const raw = readEnv("DEV_ADMIN_TG_USER_ID");
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error("Invalid env DEV_ADMIN_TG_USER_ID: expected positive integer or 0");
  }
  if (n === 0) return null;
  return n;
}

function parseNodeEnv(): NodeEnv {
  const raw = readEnv("NODE_ENV");
  if (!raw) return "development";
  if (raw === "development" || raw === "production" || raw === "test") return raw;
  throw new Error("Invalid env NODE_ENV: expected development|production|test");
}

export const config: AppConfig = (() => {
  const nodeEnv = parseNodeEnv();
  const isDev = nodeEnv === "development";

  const corsOrigins = isDev ? null : parseCsvEnv("CORS_ORIGINS");
  if (!isDev && (corsOrigins === null || corsOrigins.length === 0)) {
    throw new Error("Missing required env: CORS_ORIGINS (comma-separated origins) for production");
  }

  const webhookSecret = isDev ? readEnv("TELEGRAM_WEBHOOK_SECRET") : requireEnv("TELEGRAM_WEBHOOK_SECRET");

  return {
    nodeEnv,
    isDev,
    host: readEnv("HOST") ?? "0.0.0.0",
    port: parseIntEnv("PORT", 8787),
    corsOrigins,
    supabase: {
      url: requireEnv("SUPABASE_URL"),
      serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    },
    telegram: {
      botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
      webhookSecret,
      publicWebhookUrl: readEnv("PUBLIC_WEBHOOK_URL"),
      chatIdOwner: requireEnv("TELEGRAM_CHAT_ID_OWNER"),
      chatIdVvo: readEnv("TELEGRAM_CHAT_ID_VVO"),
      chatIdBlg: readEnv("TELEGRAM_CHAT_ID_BLG"),
    },
    dev: {
      adminTgUserId: isDev ? parseOptionalAdminUserId() : null,
    },
  };
})();
