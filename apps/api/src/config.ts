import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

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
    botUsername: string | null;
    miniAppShortName: string | null;
    webhookSecret: string;
    publicWebhookUrl: string | null;
    chatIdsOwner: string[];
    chatIdsVvo: string[] | null;
    chatIdsBlg: string[] | null;
    chatIdsOrderStatus: string[] | null;
    orderContactUsernameVvo: string;
    orderContactUsernameBlg: string;
  };
  referrals: {
    pointsInviter: number;
    pointsInvitee: number;
    minFirstOrderTotalRub: number;
    pointsExpireAfterMonths: number;
    pointsMaxSpendPercent: number;
  };
  yandex: {
    geocoderApiKey: string | null;
    geosuggestApiKey: string | null;
  };
  productImagesBaseUrl: string | null;
  dev: {
    adminTgUserId: number | null;
  };
};

function loadEnvFromRepoRoot(): void {
  // When started via `pnpm -C apps/api dev`, cwd is `apps/api`.
  const repoRoot = path.resolve(process.cwd(), "../..");
  const envLocal = path.join(repoRoot, ".env.local");
  const envDefault = path.join(repoRoot, ".env");

  if (fs.existsSync(envLocal)) {
    dotenv.config({ path: envLocal });
    return;
  }
  if (fs.existsSync(envDefault)) {
    dotenv.config({ path: envDefault });
  }
}

loadEnvFromRepoRoot();

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

function parsePort(): number {
  const raw = readEnv("PORT");
  if (!raw) return 8787;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error("Invalid PORT");
  }
  return n;
}

function parseHost(): string {
  const raw = readEnv("HOST");
  return raw ?? "0.0.0.0";
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
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error("Invalid env DEV_ADMIN_TG_USER_ID: expected positive integer");
  }
  return n;
}

function parsePositiveIntEnv(key: string, defaultValue: number): number {
  const raw = readEnv(key);
  if (!raw) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid env ${key}: expected positive integer`);
  }
  return n;
}

function parsePercentIntEnv(key: string, defaultValue: number): number {
  const n = parsePositiveIntEnv(key, defaultValue);
  if (n > 100) {
    throw new Error(`Invalid env ${key}: expected integer in range 1..100`);
  }
  return n;
}

function parseTelegramChatIds(raw: string, envName: string): string[] {
  const ids = Array.from(
    new Set(
      raw
        .split(/[;,\s]+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );

  if (ids.length === 0) {
    throw new Error(`Invalid env ${envName}: expected at least one chat id`);
  }

  return ids;
}

function parseRequiredTelegramChatIds(key: string): string[] {
  return parseTelegramChatIds(requireEnv(key), key);
}

function parseOptionalTelegramChatIds(key: string): string[] | null {
  const raw = readEnv(key);
  if (!raw) return null;
  return parseTelegramChatIds(raw, key);
}

function parseTelegramUsernameEnv(key: string, fallbackValue: string): string {
  const raw = readEnv(key) ?? fallbackValue;
  const normalized = raw.trim().replace(/^@+/, "");
  if (normalized.length === 0) {
    throw new Error(`Invalid env ${key}: expected Telegram username`);
  }
  return normalized;
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

  return {
    nodeEnv,
    isDev,
    host: parseHost(),
    port: parsePort(),
    corsOrigins,
    supabase: {
      url: requireEnv("SUPABASE_URL"),
      serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    },
    telegram: {
      botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
      botUsername: readEnv("TELEGRAM_BOT_USERNAME"),
      miniAppShortName: readEnv("TELEGRAM_MINI_APP_SHORT_NAME"),
      webhookSecret: requireEnv("TELEGRAM_WEBHOOK_SECRET"),
      publicWebhookUrl: readEnv("PUBLIC_WEBHOOK_URL"),
      chatIdsOwner: parseRequiredTelegramChatIds("TELEGRAM_CHAT_ID_OWNER"),
      chatIdsVvo: parseOptionalTelegramChatIds("TELEGRAM_CHAT_ID_VVO"),
      chatIdsBlg: parseOptionalTelegramChatIds("TELEGRAM_CHAT_ID_BLG"),
      chatIdsOrderStatus: parseOptionalTelegramChatIds("TELEGRAM_CHAT_ID_ORDER_STATUS"),
      orderContactUsernameVvo: parseTelegramUsernameEnv(
        "TELEGRAM_ORDER_CONTACT_USERNAME_VVO",
        "sdfgshopinss",
      ),
      orderContactUsernameBlg: parseTelegramUsernameEnv(
        "TELEGRAM_ORDER_CONTACT_USERNAME_BLG",
        "Smoke_Diller_Admin",
      ),
    },
    referrals: {
      pointsInviter: parsePositiveIntEnv("REFERRAL_POINTS_INVITER", 100),
      pointsInvitee: parsePositiveIntEnv("REFERRAL_POINTS_INVITEE", 100),
      minFirstOrderTotalRub: parsePositiveIntEnv("REFERRAL_MIN_FIRST_ORDER_TOTAL", 1200),
      pointsExpireAfterMonths: parsePositiveIntEnv("REFERRAL_POINTS_EXPIRE_AFTER_MONTHS", 3),
      pointsMaxSpendPercent: parsePercentIntEnv("REFERRAL_POINTS_MAX_SPEND_PERCENT", 50),
    },
    yandex: {
      geocoderApiKey: readEnv("YANDEX_GEOCODER_API_KEY"),
      geosuggestApiKey: readEnv("YANDEX_GEOSUGGEST_API_KEY"),
    },
    productImagesBaseUrl: readEnv("PRODUCT_IMAGES_BASE_URL"),
    dev: {
      adminTgUserId: isDev ? parseOptionalAdminUserId() : null,
    },
  };
})();
