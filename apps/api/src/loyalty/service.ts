import { config } from "../config.js";
import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import { sendMessage } from "../telegram/api.js";

export const ORDER_CASHBACK_KIND = "order_cashback";
export const ORDER_POINTS_SPEND_KIND = "order_points_spend";
export const POINTS_EXPIRED_KIND = "points_expired";
export const MANUAL_POINTS_CREDIT_KIND = "manual_credit";
export const MANUAL_POINTS_DEBIT_KIND = "manual_debit";

const LOYALTY_PAGE_SIZE = 1_000;
// Temporary controlled rollout. Remove this guard when the cashback program is
// ready for every customer.
export const LOYALTY_PILOT_TG_USER_ID = 1208488286;

export function isLoyaltyPilotUser(tgUserId: number): boolean {
  return tgUserId === LOYALTY_PILOT_TG_USER_ID;
}

type LoyaltyProfileRow = {
  tg_user_id: number;
  total_spent: unknown;
  bonus_points: unknown;
  current_cashback_level: unknown;
  last_order_date: string | null;
  loyalty_expires_at: string | null;
  loyalty_notice_45_sent_at: string | null;
  loyalty_notice_59_sent_at: string | null;
};

export type LoyaltySummary = {
  totalSpent: number;
  pointsBalance: number;
  cashbackLevel: number;
  lastOrderDate: string | null;
  pointsNextExpiresAt: string | null;
};

export type LoyaltySweepResult = {
  scanned: number;
  reminded15Days: number;
  reminded1Day: number;
  expired: number;
  failed: number;
};

function asFiniteNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new HttpError(500, "DB", `Invalid numeric loyalty field ${field}`);
  }
  return parsed;
}

function asInt(value: unknown, field: string): number {
  return Math.trunc(asFiniteNumber(value, field));
}

function parseDateMs(value: string | null, field: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new HttpError(500, "DB", `Invalid date loyalty field ${field}`);
  }
  return ms;
}

function mapProfile(row: LoyaltyProfileRow): LoyaltySummary {
  return {
    totalSpent: Math.max(0, asFiniteNumber(row.total_spent, "customer_profiles.total_spent")),
    pointsBalance: Math.max(0, asInt(row.bonus_points, "customer_profiles.bonus_points")),
    cashbackLevel: Math.max(0, asInt(row.current_cashback_level, "customer_profiles.current_cashback_level")),
    lastOrderDate: row.last_order_date,
    pointsNextExpiresAt: row.loyalty_expires_at,
  };
}

function isMissingLoyaltySchema(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  return (
    code === "PGRST202" ||
    code === "PGRST204" ||
    code === "42703" ||
    code === "42883" ||
    message.includes("loyalty_") ||
    message.includes("bonus_points") ||
    message.includes("total_spent")
  );
}

function schemaError(action: string, error: { message: string }): HttpError {
  if (isMissingLoyaltySchema(error)) {
    return new HttpError(
      500,
      "DB_SCHEMA_OUTDATED",
      "Loyalty schema is outdated. Run supabase/alter_loyalty_program.sql in Supabase SQL Editor.",
    );
  }
  return new HttpError(500, "DB", `${action}: ${error.message}`);
}

async function loadProfile(tgUserId: number): Promise<LoyaltyProfileRow | null> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("customer_profiles")
    .select(
      "tg_user_id,total_spent,bonus_points,current_cashback_level,last_order_date,loyalty_expires_at,loyalty_notice_45_sent_at,loyalty_notice_59_sent_at",
    )
    .eq("tg_user_id", tgUserId)
    .maybeSingle();

  if (error) throw schemaError("Failed to load loyalty profile", error);
  return (data ?? null) as LoyaltyProfileRow | null;
}

async function expireIfDue(profile: LoyaltyProfileRow): Promise<LoyaltyProfileRow> {
  const expiresAtMs = parseDateMs(profile.loyalty_expires_at, "customer_profiles.loyalty_expires_at");
  const balance = Math.max(0, asInt(profile.bonus_points, "customer_profiles.bonus_points"));
  if (!expiresAtMs || expiresAtMs > Date.now() || balance <= 0) return profile;

  await expireLoyaltyPoints(profile.tg_user_id);
  return (await loadProfile(profile.tg_user_id)) ?? profile;
}

export async function getLoyaltySummary(tgUserId: number): Promise<LoyaltySummary> {
  const profile = await loadProfile(tgUserId);
  if (!profile) {
    return {
      totalSpent: 0,
      pointsBalance: 0,
      cashbackLevel: 0,
      lastOrderDate: null,
      pointsNextExpiresAt: null,
    };
  }
  return mapProfile(await expireIfDue(profile));
}

export async function getPointsBalance(tgUserId: number): Promise<number> {
  return (await getLoyaltySummary(tgUserId)).pointsBalance;
}

export async function setOrderPointsSpend(params: {
  tgUserId: number;
  orderId: string;
  pointsToSpend: number;
}): Promise<{ previousPoints: number; pointsToSpend: number; balance: number }> {
  const requested = Math.max(0, Math.trunc(params.pointsToSpend));
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase.rpc("loyalty_set_order_points_spend", {
    p_tg_user_id: params.tgUserId,
    p_order_id: params.orderId,
    p_points_to_spend: requested,
  });
  if (error) {
    if (error.code === "P0001") {
      throw new HttpError(400, "NOT_ENOUGH_POINTS", "Not enough points");
    }
    throw schemaError("Failed to update points payment", error);
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new HttpError(500, "DB", "Points payment returned an empty result");
  const value = row as Record<string, unknown>;
  return {
    previousPoints: Math.max(0, asInt(value.previous_points, "loyalty_set_order_points_spend.previous_points")),
    pointsToSpend: Math.max(0, asInt(value.points_to_spend, "loyalty_set_order_points_spend.points_to_spend")),
    balance: Math.max(0, asInt(value.bonus_points, "loyalty_set_order_points_spend.bonus_points")),
  };
}

export async function spendPointsForOrder(params: {
  tgUserId: number;
  orderId: string;
  pointsToSpend: number;
}): Promise<number> {
  const result = await setOrderPointsSpend(params);
  return result.pointsToSpend;
}

export async function applyLoyaltyPointsTransaction(params: {
  tgUserId: number;
  deltaPoints: number;
  kind: string;
  orderId?: string | null;
  referralId?: number | null;
  comment?: string | null;
  resetExpiry?: boolean;
}): Promise<{ applied: boolean; balance: number; expiresAt: string | null }> {
  const deltaPoints = Math.trunc(params.deltaPoints);
  if (deltaPoints === 0) {
    throw new HttpError(400, "BAD_REQUEST", "Points delta must not be zero");
  }

  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase.rpc("loyalty_apply_points_transaction", {
    p_tg_user_id: params.tgUserId,
    p_delta_points: deltaPoints,
    p_kind: params.kind,
    p_order_id: params.orderId ?? null,
    p_referral_id: params.referralId ?? null,
    p_comment: params.comment?.trim() || null,
    p_reset_expiry: params.resetExpiry ?? false,
  });
  if (error) {
    if (error.code === "P0001") {
      throw new HttpError(400, "NOT_ENOUGH_POINTS", "Not enough points");
    }
    throw schemaError("Failed to apply loyalty transaction", error);
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new HttpError(500, "DB", "Loyalty transaction returned an empty result");
  const value = row as Record<string, unknown>;
  return {
    applied: value.applied === true,
    balance: Math.max(0, asInt(value.bonus_points, "loyalty_apply_points_transaction.bonus_points")),
    expiresAt: typeof value.loyalty_expires_at === "string" ? value.loyalty_expires_at : null,
  };
}

export async function processOrderCashback(params: {
  tgUserId: number;
  orderId: string;
  cashbackBase: number;
}): Promise<{ applied: boolean; cashbackPoints: number; cashbackPercent: number }> {
  if (!isLoyaltyPilotUser(params.tgUserId)) {
    return { applied: false, cashbackPoints: 0, cashbackPercent: 0 };
  }

  if (!Number.isFinite(params.cashbackBase) || params.cashbackBase < 0) {
    throw new HttpError(500, "DB", "Invalid cashback base for completed order");
  }

  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase.rpc("loyalty_complete_order", {
    p_tg_user_id: params.tgUserId,
    p_order_id: params.orderId,
    p_cashback_base: Math.max(0, params.cashbackBase),
  });
  if (error) throw schemaError("Failed to complete order loyalty", error);

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new HttpError(500, "DB", "Order loyalty returned an empty result");
  const value = row as Record<string, unknown>;
  return {
    applied: value.applied === true,
    cashbackPoints: Math.max(0, asInt(value.cashback_points, "loyalty_complete_order.cashback_points")),
    cashbackPercent: Math.max(0, asInt(value.cashback_percent, "loyalty_complete_order.cashback_percent")),
  };
}

export async function expireLoyaltyPoints(tgUserId: number): Promise<number> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase.rpc("loyalty_expire_points", { p_tg_user_id: tgUserId });
  if (error) throw schemaError("Failed to expire loyalty points", error);

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new HttpError(500, "DB", "Loyalty expiry returned an empty result");
  const value = row as Record<string, unknown>;
  return Math.max(0, asInt(value.expired_points, "loyalty_expire_points.expired_points"));
}

function calendarDateInTimezone(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.loyalty.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year") ?? "1970"}-${values.get("month") ?? "01"}-${values.get("day") ?? "01"}`;
}

function calendarDaysUntil(expiresAt: string, now: Date): number {
  const expiresDate = calendarDateInTimezone(new Date(expiresAt));
  const today = calendarDateInTimezone(now);
  const expiresMs = Date.parse(`${expiresDate}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  return Math.round((expiresMs - todayMs) / 86_400_000);
}

async function markReminderSent(params: {
  tgUserId: number;
  field: "loyalty_notice_45_sent_at" | "loyalty_notice_59_sent_at";
  expiresAt: string;
}): Promise<void> {
  const supabase = createServiceSupabaseClient();
  const { error } = await supabase
    .from("customer_profiles")
    .update({ [params.field]: new Date().toISOString() })
    .eq("tg_user_id", params.tgUserId)
    .eq("loyalty_expires_at", params.expiresAt)
    .is(params.field, null);
  if (error) throw schemaError("Failed to record loyalty reminder", error);
}

async function loadExpiryCandidates(): Promise<LoyaltyProfileRow[]> {
  const supabase = createServiceSupabaseClient();
  const rows: LoyaltyProfileRow[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase
      .from("customer_profiles")
      .select(
        "tg_user_id,total_spent,bonus_points,current_cashback_level,last_order_date,loyalty_expires_at,loyalty_notice_45_sent_at,loyalty_notice_59_sent_at",
      )
      .gt("bonus_points", 0)
      .eq("tg_user_id", LOYALTY_PILOT_TG_USER_ID)
      .not("loyalty_expires_at", "is", null)
      .order("loyalty_expires_at", { ascending: true })
      .range(offset, offset + LOYALTY_PAGE_SIZE - 1);
    if (error) throw schemaError("Failed to load loyalty expiry candidates", error);

    const page = (data ?? []) as LoyaltyProfileRow[];
    rows.push(...page);
    if (page.length < LOYALTY_PAGE_SIZE) break;
    offset += page.length;
  }

  return rows;
}

export async function runLoyaltyRetentionSweep(now = new Date()): Promise<LoyaltySweepResult> {
  const rows = await loadExpiryCandidates();
  const result: LoyaltySweepResult = {
    scanned: rows.length,
    reminded15Days: 0,
    reminded1Day: 0,
    expired: 0,
    failed: 0,
  };

  for (const row of rows) {
    const expiresAt = row.loyalty_expires_at;
    if (!expiresAt) continue;

    try {
      const daysUntilExpiry = calendarDaysUntil(expiresAt, now);
      if (daysUntilExpiry <= 0) {
        const expired = await expireLoyaltyPoints(row.tg_user_id);
        if (expired > 0) result.expired += 1;
        continue;
      }

      const balance = Math.max(0, asInt(row.bonus_points, "customer_profiles.bonus_points"));
      if (daysUntilExpiry === 15 && !row.loyalty_notice_45_sent_at) {
        await sendMessage({
          botToken: config.telegram.botToken,
          chatId: String(row.tg_user_id),
          text: `Привет! Твои ${balance} баллов в Smoke_Diller сгорят через 15 дней. Успей сделать заказ и сохранить свой кэшбек! 💨`,
        });
        await markReminderSent({
          tgUserId: row.tg_user_id,
          field: "loyalty_notice_45_sent_at",
          expiresAt,
        });
        result.reminded15Days += 1;
      }

      if (daysUntilExpiry === 1 && !row.loyalty_notice_59_sent_at) {
        await sendMessage({
          botToken: config.telegram.botToken,
          chatId: String(row.tg_user_id),
          text: "Внимание! Твои баллы сгорят уже завтра. Успей сделать заказ и сохранить свой кэшбек!",
        });
        await markReminderSent({
          tgUserId: row.tg_user_id,
          field: "loyalty_notice_59_sent_at",
          expiresAt,
        });
        result.reminded1Day += 1;
      }
    } catch {
      // One unreachable Telegram user must not stop expiry for everyone else.
      result.failed += 1;
    }
  }

  return result;
}
