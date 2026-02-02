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
    webhookSecret: string;
    publicWebhookUrl: string | null;
    chatIdOwner: string;
    chatIdVvo: string | null;
    chatIdBlg: string | null;
  };
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
    host: "0.0.0.0",
    port: parsePort(),
    corsOrigins,
    supabase: {
      url: requireEnv("SUPABASE_URL"),
      serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    },
    telegram: {
      botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
      webhookSecret: requireEnv("TELEGRAM_WEBHOOK_SECRET"),
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
