import type { FastifyRequest } from "fastify";
import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import { verifyTelegramInitData } from "../telegram/verifyInitData.js";
import { config } from "../config.js";

export type AdminContext = {
  tgUserId: number;
  username: string | null;
  role: string;
};

const ADMIN_ROLE_CACHE_TTL_MS = 60_000;
const adminRoleCache = new Map<number, { role: string; expiresAt: number }>();

function getHeaderString(
  request: FastifyRequest,
  headerName: string,
): string | null {
  const value = request.headers[headerName];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function getCachedAdminRole(tgUserId: number): string | null {
  const hit = adminRoleCache.get(tgUserId);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    adminRoleCache.delete(tgUserId);
    return null;
  }
  return hit.role;
}

function setCachedAdminRole(tgUserId: number, role: string): void {
  adminRoleCache.set(tgUserId, {
    role,
    expiresAt: Date.now() + ADMIN_ROLE_CACHE_TTL_MS,
  });
}

export async function requireAdmin(request: FastifyRequest): Promise<AdminContext> {
  const isDevBypassAllowed = config.isDev;
  const isDevAdminHeaderOn = getHeaderString(request, "x-dev-admin") === "1";

  let tgUserId: number;
  let username: string | null;

  if (isDevBypassAllowed && isDevAdminHeaderOn && config.dev.adminTgUserId) {
    tgUserId = config.dev.adminTgUserId;
    username = null;
  } else {
    const initData = (getHeaderString(request, "x-telegram-init-data") ?? "").trim();
    if (!initData) {
      throw new HttpError(401, "TG_INIT_DATA_REQUIRED", "Open the mini app inside Telegram");
    }

    const verified = verifyTelegramInitData(initData, config.telegram.botToken);
    const maxAgeSeconds = 24 * 60 * 60;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds - verified.authDate > maxAgeSeconds) {
      throw new HttpError(401, "TG_INIT_DATA_EXPIRED", "initData auth_date is too old");
    }

    tgUserId = verified.user.id;
    username = verified.user.username;
  }

  const cachedRole = getCachedAdminRole(tgUserId);
  if (cachedRole) {
    return { tgUserId, username, role: cachedRole };
  }

  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("admins")
    .select("tg_user_id,role")
    .eq("tg_user_id", tgUserId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "DB", `Failed to check admin access: ${error.message}`);
  }

  if (!data) {
    adminRoleCache.delete(tgUserId);
    throw new HttpError(403, "FORBIDDEN", "Нет доступа");
  }

  setCachedAdminRole(tgUserId, data.role);
  return { tgUserId, username, role: data.role };
}
