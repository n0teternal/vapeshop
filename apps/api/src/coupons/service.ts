import crypto from "node:crypto";
import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";

export type CouponLine = {
  categorySlug?: string | null | undefined;
  total: number;
};

type CouponRow = {
  id: string;
  tg_user_id: number;
  kind: string;
  value: unknown;
  min_order_sum: unknown;
  max_discount: unknown;
  source: string;
  referral_id: number | null;
  campaign_key: string | null;
  is_used: boolean;
  used_order_id: string | null;
  expires_at: string | null;
  created_at: string;
  used_at: string | null;
};

export type CouponPreview = {
  code: string;
  discountAmount: number;
  categorySlug: null;
  requiresPreviousOrder: false;
  source: "referral_first_order" | "reactivation_30d";
  label: string;
  expiresAt: string | null;
};

export type CouponReservation = CouponPreview;

const AUTOMATIC_COUPON_SOURCES = ["referral_first_order", "reactivation_30d"] as const;

function asMoney(value: unknown, field: string): number {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numberValue)) {
    throw new HttpError(500, "DB", `Invalid coupon field ${field}`);
  }
  return Math.max(0, numberValue);
}

function isCouponsSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: unknown; message?: unknown };
  const code = typeof maybe.code === "string" ? maybe.code : "";
  const message = typeof maybe.message === "string" ? maybe.message.toLowerCase() : "";
  return (
    code === "PGRST202" ||
    code === "42P01" ||
    code === "42703" ||
    message.includes("coupons") ||
    message.includes("customer_reactivation_campaigns")
  );
}

function couponSchemaError(action: string, error: { message: string }): HttpError {
  if (isCouponsSchemaError(error)) {
    return new HttpError(
      500,
      "COUPONS_SCHEMA_OUTDATED",
      "Схема персональных скидок ещё не установлена. Выполните supabase/alter_referral_reactivation.sql.",
    );
  }
  return new HttpError(500, "DB", `${action}: ${error.message}`);
}

export function normalizeCouponId(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function isCouponRowAvailable(row: CouponRow, nowMs: number): boolean {
  if (row.is_used) return false;
  if (!row.expires_at) return true;
  const expiresMs = Date.parse(row.expires_at);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

function calculateDiscount(row: CouponRow, orderTotal: number): number {
  const total = Math.max(0, Math.trunc(orderTotal));
  const minOrderSum = Math.max(0, Math.trunc(asMoney(row.min_order_sum, "coupons.min_order_sum")));
  if (total < minOrderSum) return 0;

  const value = asMoney(row.value, "coupons.value");
  const base = row.kind === "percent" ? Math.floor((total * value) / 100) : Math.floor(value);
  const maxDiscount = row.max_discount === null ? null : Math.floor(asMoney(row.max_discount, "coupons.max_discount"));
  return Math.max(0, Math.min(total, base, maxDiscount ?? Number.MAX_SAFE_INTEGER));
}

function sourceFromRow(row: CouponRow): CouponPreview["source"] {
  if (row.source === "referral_first_order" || row.source === "reactivation_30d") {
    return row.source;
  }
  throw new HttpError(500, "DB", `Unsupported automatic coupon source: ${row.source}`);
}

function labelFromRow(row: CouponRow): string {
  if (row.source === "referral_first_order") return "Скидка 10% по приглашению";
  return "Скидка 10% на возвращение";
}

function toPreview(row: CouponRow, orderTotal: number): CouponPreview {
  const discountAmount = calculateDiscount(row, orderTotal);
  if (discountAmount <= 0) {
    throw new HttpError(400, "COUPON_ZERO_DISCOUNT", "Персональная скидка не действует для этой корзины.");
  }

  return {
    code: row.id,
    discountAmount,
    categorySlug: null,
    requiresPreviousOrder: false,
    source: sourceFromRow(row),
    label: labelFromRow(row),
    expiresAt: row.expires_at,
  };
}

function makeCouponId(): string {
  return crypto.randomUUID();
}

async function loadCoupon(id: string): Promise<CouponRow | null> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("coupons")
    .select(
      "id,tg_user_id,kind,value,min_order_sum,max_discount,source,referral_id,campaign_key,is_used,used_order_id,expires_at,created_at,used_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw couponSchemaError("Failed to load personal coupon", error);
  return (data ?? null) as CouponRow | null;
}

async function assertReferralCouponStillFirstOrder(row: CouponRow): Promise<void> {
  if (row.source !== "referral_first_order") return;
  const supabase = createServiceSupabaseClient();
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("tg_user_id", row.tg_user_id)
    .eq("status", "done");
  if (error) throw new HttpError(500, "DB", `Failed to check first order coupon: ${error.message}`);
  if ((count ?? 0) > 0) {
    throw new HttpError(400, "COUPON_FIRST_ORDER_ONLY", "Эта скидка доступна только на первый заказ.");
  }
}

async function reserveCouponRow(params: {
  row: CouponRow;
  tgUserId: number;
  orderTotal: number;
}): Promise<CouponReservation> {
  const row = params.row;
  if (row.tg_user_id !== params.tgUserId) {
    throw new HttpError(400, "COUPON_NOT_AVAILABLE", "Персональная скидка недоступна этому пользователю.");
  }
  if (!isCouponRowAvailable(row, Date.now())) {
    throw new HttpError(400, "COUPON_NOT_AVAILABLE", "Срок действия персональной скидки истёк или она уже использована.");
  }
  await assertReferralCouponStillFirstOrder(row);
  const preview = toPreview(row, params.orderTotal);
  const nowIso = new Date().toISOString();
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("coupons")
    .update({ is_used: true, used_at: nowIso })
    .eq("id", row.id)
    .eq("tg_user_id", params.tgUserId)
    .eq("is_used", false)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .select("id")
    .maybeSingle();
  if (error) throw couponSchemaError("Failed to reserve personal coupon", error);
  if (!data) {
    throw new HttpError(409, "COUPON_CONFLICT", "Скидку только что применили в другом заказе. Обновите корзину.");
  }
  return preview;
}

export async function createPersonalCoupon(params: {
  tgUserId: number;
  source: CouponPreview["source"];
  referralId?: number | null;
  campaignKey?: string | null;
  expiresAt?: string | null;
}): Promise<CouponRow> {
  const supabase = createServiceSupabaseClient();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = makeCouponId();
    const { data, error } = await supabase
      .from("coupons")
      .insert({
        id,
        tg_user_id: params.tgUserId,
        kind: "percent",
        value: 10,
        min_order_sum: 0,
        max_discount: null,
        source: params.source,
        referral_id: params.referralId ?? null,
        campaign_key: params.campaignKey ?? null,
        expires_at: params.expiresAt ?? null,
      })
      .select(
        "id,tg_user_id,kind,value,min_order_sum,max_discount,source,referral_id,campaign_key,is_used,used_order_id,expires_at,created_at,used_at",
      )
      .maybeSingle();
    if (data) return data as CouponRow;
    const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "";
    const message = typeof (error as { message?: unknown } | null)?.message === "string" ? (error as { message: string }).message : "";
    if (code === "23505" && params.source === "referral_first_order" && params.referralId) {
      const { data: existing, error: existingError } = await supabase
        .from("coupons")
        .select(
          "id,tg_user_id,kind,value,min_order_sum,max_discount,source,referral_id,campaign_key,is_used,used_order_id,expires_at,created_at,used_at",
        )
        .eq("referral_id", params.referralId)
        .eq("source", "referral_first_order")
        .maybeSingle();
      if (existingError) throw couponSchemaError("Failed to load existing referral coupon", existingError);
      if (existing) return existing as CouponRow;
    }
    if (code === "23505" && params.source === "reactivation_30d" && params.campaignKey) {
      const { data: existing, error: existingError } = await supabase
        .from("coupons")
        .select(
          "id,tg_user_id,kind,value,min_order_sum,max_discount,source,referral_id,campaign_key,is_used,used_order_id,expires_at,created_at,used_at",
        )
        .eq("tg_user_id", params.tgUserId)
        .eq("source", "reactivation_30d")
        .eq("campaign_key", params.campaignKey)
        .maybeSingle();
      if (existingError) throw couponSchemaError("Failed to load existing reactivation coupon", existingError);
      if (existing) return existing as CouponRow;
    }
    if (code === "23505" && message.includes("coupons_pkey")) continue;
    if (error) throw couponSchemaError("Failed to create personal coupon", error);
  }
  throw new HttpError(500, "DB", "Failed to generate a personal coupon id");
}

export async function previewCoupon(params: {
  couponId: string;
  tgUserId: number;
  orderTotal: number;
}): Promise<CouponPreview | null> {
  const id = normalizeCouponId(params.couponId);
  if (!id) return null;
  const row = await loadCoupon(id);
  if (!row) return null;
  if (row.tg_user_id !== params.tgUserId) {
    throw new HttpError(400, "COUPON_NOT_AVAILABLE", "Персональная скидка недоступна этому пользователю.");
  }
  if (!isCouponRowAvailable(row, Date.now())) {
    throw new HttpError(400, "COUPON_NOT_AVAILABLE", "Срок действия персональной скидки истёк или она уже использована.");
  }
  await assertReferralCouponStillFirstOrder(row);
  return toPreview(row, params.orderTotal);
}

export async function reserveCoupon(params: {
  couponId: string;
  tgUserId: number;
  orderTotal: number;
}): Promise<CouponReservation | null> {
  const id = normalizeCouponId(params.couponId);
  if (!id) return null;
  const row = await loadCoupon(id);
  if (!row) return null;
  return reserveCouponRow({ row, tgUserId: params.tgUserId, orderTotal: params.orderTotal });
}

export async function getAutomaticCoupon(params: {
  tgUserId: number;
  orderTotal: number;
}): Promise<CouponPreview | null> {
  const supabase = createServiceSupabaseClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("coupons")
    .select(
      "id,tg_user_id,kind,value,min_order_sum,max_discount,source,referral_id,campaign_key,is_used,used_order_id,expires_at,created_at,used_at",
    )
    .eq("tg_user_id", params.tgUserId)
    .eq("is_used", false)
    .in("source", [...AUTOMATIC_COUPON_SOURCES])
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order("expires_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(8);
  if (error) throw couponSchemaError("Failed to load personal coupons", error);

  for (const candidate of (data ?? []) as CouponRow[]) {
    try {
      await assertReferralCouponStillFirstOrder(candidate);
      const preview = toPreview(candidate, params.orderTotal);
      if (preview.discountAmount > 0) return preview;
    } catch (error) {
      if (error instanceof HttpError && error.code === "COUPON_FIRST_ORDER_ONLY") continue;
      if (error instanceof HttpError && error.code === "COUPON_ZERO_DISCOUNT") continue;
      throw error;
    }
  }
  return null;
}

export async function reserveAutomaticCoupon(params: {
  tgUserId: number;
  orderTotal: number;
}): Promise<CouponReservation | null> {
  const preview = await getAutomaticCoupon(params);
  if (!preview) return null;
  return reserveCoupon({
    couponId: preview.code,
    tgUserId: params.tgUserId,
    orderTotal: params.orderTotal,
  });
}

export async function releaseCouponUsage(couponId: string | null | undefined): Promise<boolean> {
  const id = normalizeCouponId(couponId);
  if (!id) return false;
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("coupons")
    .update({ is_used: false, used_order_id: null, used_at: null })
    .eq("id", id)
    .eq("is_used", true)
    .select("id")
    .maybeSingle();
  if (error) throw couponSchemaError("Failed to release personal coupon", error);
  return Boolean(data);
}

export async function attachCouponToOrder(params: { couponId: string | null; orderId: string }): Promise<void> {
  const id = normalizeCouponId(params.couponId);
  if (!id) return;
  const supabase = createServiceSupabaseClient();
  const { error } = await supabase
    .from("coupons")
    .update({ used_order_id: params.orderId })
    .eq("id", id)
    .eq("is_used", true);
  if (error) throw couponSchemaError("Failed to attach personal coupon to order", error);
}

export async function releaseDiscountUsage(couponId: string | null | undefined): Promise<void> {
  const releasedPersonalCoupon = await releaseCouponUsage(couponId);
  if (releasedPersonalCoupon) return;
  const { releasePromoCodeUsage } = await import("../promoCodes/service.js");
  await releasePromoCodeUsage(couponId);
}
