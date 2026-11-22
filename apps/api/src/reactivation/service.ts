import { config } from "../config.js";
import { createPersonalCoupon } from "../coupons/service.js";
import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import { sendMessage } from "../telegram/api.js";

const REACTIVATION_AFTER_DAYS = 30;
const REACTIVATION_COUPON_LIFETIME_MS = 3 * 86_400_000;
const PAGE_SIZE = 1_000;

type CustomerLastOrderRow = {
  tg_user_id: number;
  last_order_date: string | null;
};

type CampaignRow = {
  id: number;
  tg_user_id: number;
  last_completed_order_at: string;
  coupon_id: string;
  expires_at: string;
  send_attempts: number;
  sent_at: string | null;
  cancelled_at: string | null;
};

export type ReactivationSweepResult = {
  eligible: number;
  created: number;
  sent: number;
  cancelled: number;
  failed: number;
};

function localDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.loyalty.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) throw new Error("Unable to derive local reactivation date");
  return `${year}-${month}-${day}`;
}

function dateKeyDaysBefore(now: Date, days: number): string {
  const key = localDateKey(now);
  const dateParts = key.split("-").map(Number);
  const year = dateParts[0] ?? Number.NaN;
  const month = dateParts[1] ?? Number.NaN;
  const day = dateParts[2] ?? Number.NaN;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("Unable to calculate reactivation date");
  }
  return new Date(Date.UTC(year, month - 1, day - days)).toISOString().slice(0, 10);
}

function buildShopLink(): string | null {
  const username = config.telegram.botUsername?.trim().replace(/^@+/, "") ?? "";
  if (!username) return null;
  const miniAppShortName = config.telegram.miniAppShortName?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  return miniAppShortName
    ? `https://t.me/${username}/${miniAppShortName}`
    : `https://t.me/${username}`;
}

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "в течение 3 дней";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: config.loyalty.timezone,
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function loadEligibleCustomers(now: Date): Promise<CustomerLastOrderRow[]> {
  const supabase = createServiceSupabaseClient();
  const targetDate = dateKeyDaysBefore(now, REACTIVATION_AFTER_DAYS);
  // The broad UTC window keeps this query indexed and is intentionally wider
  // than a local calendar day. The exact business-day check below is performed
  // with the configured loyalty timezone.
  const rangeStart = new Date(now.getTime() - 32 * 86_400_000).toISOString();
  const rangeEnd = new Date(now.getTime() - 28 * 86_400_000).toISOString();
  const rows: CustomerLastOrderRow[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase
      .from("customer_profiles")
      .select("tg_user_id,last_order_date")
      .gt("tg_user_id", 0)
      .gte("last_order_date", rangeStart)
      .lt("last_order_date", rangeEnd)
      .order("tg_user_id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      throw new HttpError(500, "DB", `Failed to load reactivation candidates: ${error.message}`);
    }
    const page = (data ?? []) as CustomerLastOrderRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }

  return rows.filter((row) => {
    if (!row.last_order_date) return false;
    const lastOrder = new Date(row.last_order_date);
    return Number.isFinite(lastOrder.getTime()) && localDateKey(lastOrder) === targetDate;
  });
}

async function createCampaignForCustomer(params: {
  tgUserId: number;
  lastCompletedOrderAt: string;
  now: Date;
}): Promise<boolean> {
  const expiresAt = new Date(params.now.getTime() + REACTIVATION_COUPON_LIFETIME_MS).toISOString();
  const coupon = await createPersonalCoupon({
    tgUserId: params.tgUserId,
    source: "reactivation_30d",
    campaignKey: params.lastCompletedOrderAt,
    expiresAt,
  });
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("customer_reactivation_campaigns")
    .insert({
      tg_user_id: params.tgUserId,
      last_completed_order_at: params.lastCompletedOrderAt,
      coupon_id: coupon.id,
      expires_at: coupon.expires_at ?? expiresAt,
    })
    .select("id")
    .maybeSingle();
  if (!error && data) return true;
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "";
  if (code === "23505") return false;
  if (error) {
    throw new HttpError(500, "DB", `Failed to create reactivation campaign: ${error.message}`);
  }
  return false;
}

async function loadPendingCampaigns(now: Date): Promise<CampaignRow[]> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("customer_reactivation_campaigns")
    .select("id,tg_user_id,last_completed_order_at,coupon_id,expires_at,send_attempts,sent_at,cancelled_at")
    .is("sent_at", null)
    .is("cancelled_at", null)
    .gt("expires_at", now.toISOString())
    .order("created_at", { ascending: true })
    .limit(PAGE_SIZE);
  if (error) {
    throw new HttpError(500, "DB", `Failed to load pending reactivation campaigns: ${error.message}`);
  }
  return (data ?? []) as CampaignRow[];
}

async function hasCustomerPurchasedSince(campaign: CampaignRow): Promise<boolean> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("customer_profiles")
    .select("last_order_date")
    .eq("tg_user_id", campaign.tg_user_id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "DB", `Failed to validate reactivation customer: ${error.message}`);
  }
  return Boolean(data?.last_order_date && data.last_order_date !== campaign.last_completed_order_at);
}

async function cancelCampaign(campaign: CampaignRow, now: Date): Promise<void> {
  const supabase = createServiceSupabaseClient();
  const nowIso = now.toISOString();
  const [{ error: campaignError }, { error: couponError }] = await Promise.all([
    supabase
      .from("customer_reactivation_campaigns")
      .update({ cancelled_at: nowIso })
      .eq("id", campaign.id)
      .is("cancelled_at", null),
    supabase
      .from("coupons")
      .update({ expires_at: nowIso })
      .eq("id", campaign.coupon_id)
      .eq("is_used", false),
  ]);
  if (campaignError) throw new HttpError(500, "DB", `Failed to cancel reactivation campaign: ${campaignError.message}`);
  if (couponError) throw new HttpError(500, "DB", `Failed to expire reactivation coupon: ${couponError.message}`);
}

async function sendCampaign(campaign: CampaignRow, now: Date): Promise<void> {
  const supabase = createServiceSupabaseClient();
  const attemptAt = now.toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("customer_reactivation_campaigns")
    .update({
      send_attempts: Math.max(0, Math.trunc(campaign.send_attempts)) + 1,
      last_send_attempt_at: attemptAt,
    })
    .eq("id", campaign.id)
    .is("sent_at", null)
    .is("cancelled_at", null)
    .select("id")
    .maybeSingle();
  if (claimError) throw new HttpError(500, "DB", `Failed to claim reactivation message: ${claimError.message}`);
  if (!claimed) return;

  const shopLink = buildShopLink();
  await sendMessage({
    botToken: config.telegram.botToken,
    chatId: String(campaign.tg_user_id),
    text:
      "Привет! Давно не виделись 👋\n\n" +
      "Дарим вам <b>персональную скидку 10%</b> на следующий заказ. Она применится автоматически в корзине и действует до " +
      `<b>${formatExpiry(campaign.expires_at)}</b>.`,
    replyMarkup: shopLink
      ? { inline_keyboard: [[{ text: "Открыть магазин со скидкой", url: shopLink }]] }
      : undefined,
  });

  const { error: sentError } = await supabase
    .from("customer_reactivation_campaigns")
    .update({ sent_at: new Date().toISOString() })
    .eq("id", campaign.id)
    .is("sent_at", null);
  if (sentError) throw new HttpError(500, "DB", `Failed to mark reactivation message sent: ${sentError.message}`);
}

export async function runReactivationSweep(now = new Date()): Promise<ReactivationSweepResult> {
  const result: ReactivationSweepResult = {
    eligible: 0,
    created: 0,
    sent: 0,
    cancelled: 0,
    failed: 0,
  };
  const eligible = await loadEligibleCustomers(now);
  result.eligible = eligible.length;

  for (const customer of eligible) {
    if (!customer.last_order_date) continue;
    try {
      if (await createCampaignForCustomer({
        tgUserId: customer.tg_user_id,
        lastCompletedOrderAt: customer.last_order_date,
        now,
      })) {
        result.created += 1;
      }
    } catch {
      result.failed += 1;
    }
  }

  const pending = await loadPendingCampaigns(now);
  for (const campaign of pending) {
    try {
      if (await hasCustomerPurchasedSince(campaign)) {
        await cancelCampaign(campaign, now);
        result.cancelled += 1;
        continue;
      }
      await sendCampaign(campaign, now);
      result.sent += 1;
    } catch {
      // A blocked Telegram chat should not prevent sending the rest.
      result.failed += 1;
    }
  }

  return result;
}
