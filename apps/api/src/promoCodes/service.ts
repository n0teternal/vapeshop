import { HttpError } from "../httpError.js";
import { normalizePromotionCategorySlug } from "../promotions/rules.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";

type PromoCodeRow = {
  code: string;
  discount_amount: unknown;
  starts_at: string;
  ends_at: string;
  max_uses: number;
  used_count: number;
  is_active: boolean;
  requires_previous_order?: boolean | null;
  category_slug?: string | null;
};

export type PromoCodePreview = {
  code: string;
  discountAmount: number;
  categorySlug: string | null;
  requiresPreviousOrder: boolean;
};

export type PromoCodeReservation = PromoCodePreview;

export type PromoCodeLine = {
  categorySlug: string | null | undefined;
  total: number;
};

export function normalizePromoCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/\s+/g, "").toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function numberFromUnknown(value: unknown, fieldName: string): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(n)) {
    throw new HttpError(500, "DB", `Invalid numeric field ${fieldName}`);
  }
  return n;
}

function isMissingPromoCodesTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; message?: unknown };
  const code = typeof maybeError.code === "string" ? maybeError.code : "";
  const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
  return (
    code === "PGRST205" ||
    code === "42P01" ||
    (message.includes("promo_codes") &&
      (message.includes("schema cache") ||
        message.includes("relation") ||
        message.includes("does not exist")))
  );
}

function isOutdatedPromoCodesSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; message?: unknown };
  const code = typeof maybeError.code === "string" ? maybeError.code : "";
  const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
  return (
    code === "PGRST204" ||
    code === "42703" ||
    ((message.includes("requires_previous_order") || message.includes("category_slug")) &&
      (message.includes("schema cache") ||
        message.includes("column") ||
        message.includes("does not exist")))
  );
}

function assertPromoCodeCanBeUsed(row: PromoCodeRow, nowMs: number): void {
  if (!row.is_active) {
    throw new HttpError(400, "PROMO_CODE_INACTIVE", "Промокод неактивен.");
  }

  const startsAtMs = new Date(row.starts_at).getTime();
  if (Number.isFinite(startsAtMs) && startsAtMs > nowMs) {
    throw new HttpError(400, "PROMO_CODE_NOT_STARTED", "Промокод еще не действует.");
  }

  const endsAtMs = new Date(row.ends_at).getTime();
  if (Number.isFinite(endsAtMs) && endsAtMs < nowMs) {
    throw new HttpError(400, "PROMO_CODE_EXPIRED", "Срок действия промокода истек.");
  }

  if (row.used_count >= row.max_uses) {
    throw new HttpError(400, "PROMO_CODE_LIMIT_REACHED", "Лимит использований промокода исчерпан.");
  }
}

function getPromoCodeCategorySlug(row: PromoCodeRow): string | null {
  const raw = row.category_slug;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return normalizePromotionCategorySlug(raw);
}

function getPromoCodeEligibleTotal(row: PromoCodeRow, orderTotal: number, lines: PromoCodeLine[]): number {
  const categorySlug = getPromoCodeCategorySlug(row);
  if (!categorySlug) return Math.max(0, Math.trunc(orderTotal));

  let eligibleTotal = 0;
  for (const line of lines) {
    const lineCategory =
      typeof line.categorySlug === "string" && line.categorySlug.trim().length > 0
        ? normalizePromotionCategorySlug(line.categorySlug)
        : null;
    if (lineCategory !== categorySlug) continue;

    const lineTotal = Math.trunc(line.total);
    if (Number.isFinite(lineTotal) && lineTotal > 0) {
      eligibleTotal += lineTotal;
    }
  }

  return eligibleTotal;
}

function getPromoDiscountAmount(row: PromoCodeRow, orderTotal: number, lines: PromoCodeLine[]): number {
  const discountAmount = Math.max(
    0,
    Math.trunc(numberFromUnknown(row.discount_amount, "promo_codes.discount_amount")),
  );
  return Math.min(
    Math.max(0, Math.trunc(orderTotal)),
    getPromoCodeEligibleTotal(row, orderTotal, lines),
    discountAmount,
  );
}

async function assertPromoCodeCustomerCanUse(params: {
  row: PromoCodeRow;
  tgUserId: number | null | undefined;
}): Promise<void> {
  if (params.row.requires_previous_order !== true) return;
  const tgUserId = params.tgUserId;
  if (!tgUserId || !Number.isFinite(tgUserId) || tgUserId <= 0) {
    throw new HttpError(
      400,
      "PROMO_CODE_REQUIRES_PREVIOUS_ORDER",
      "Промокод доступен после первой покупки.",
    );
  }

  const supabase = createServiceSupabaseClient();
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("tg_user_id", tgUserId)
    .eq("status", "done");

  if (error) {
    throw new HttpError(500, "DB", `Failed to check previous orders: ${error.message}`);
  }

  if ((count ?? 0) <= 0) {
    throw new HttpError(
      400,
      "PROMO_CODE_REQUIRES_PREVIOUS_ORDER",
      "Промокод доступен после первой покупки.",
    );
  }
}

async function loadPromoCode(code: string): Promise<PromoCodeRow> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("promo_codes")
    .select(
      "code,discount_amount,starts_at,ends_at,max_uses,used_count,is_active,requires_previous_order,category_slug",
    )
    .eq("code", code)
    .maybeSingle();

  if (error) {
    if (isMissingPromoCodesTableError(error)) {
      throw new HttpError(500, "PROMO_CODES_NOT_CONFIGURED", "Таблица промокодов еще не настроена.");
    }
    if (isOutdatedPromoCodesSchemaError(error)) {
      throw new HttpError(
        500,
        "PROMO_CODES_SCHEMA_OUTDATED",
        "Схема промокодов устарела. Выполните supabase/alter_promo_codes.sql.",
      );
    }
    throw new HttpError(500, "DB", `Failed to load promo code: ${error.message}`);
  }
  if (!data) {
    throw new HttpError(400, "PROMO_CODE_NOT_FOUND", "Промокод не найден.");
  }

  return data as PromoCodeRow;
}

export async function previewPromoCode(params: {
  code: string;
  orderTotal: number;
  lines?: PromoCodeLine[];
  tgUserId?: number | null;
}): Promise<PromoCodePreview> {
  const normalizedCode = normalizePromoCode(params.code);
  if (!normalizedCode) {
    throw new HttpError(400, "BAD_REQUEST", "Введите промокод.");
  }

  const row = await loadPromoCode(normalizedCode);
  assertPromoCodeCanBeUsed(row, Date.now());
  await assertPromoCodeCustomerCanUse({ row, tgUserId: params.tgUserId });
  const discountAmount = getPromoDiscountAmount(row, params.orderTotal, params.lines ?? []);
  if (discountAmount <= 0) {
    throw new HttpError(400, "PROMO_CODE_ZERO_DISCOUNT", "Промокод не дает скидку для этой корзины.");
  }

  return {
    code: row.code,
    discountAmount,
    categorySlug: getPromoCodeCategorySlug(row),
    requiresPreviousOrder: row.requires_previous_order === true,
  };
}

export async function reservePromoCode(params: {
  code: string | null;
  orderTotal: number;
  lines?: PromoCodeLine[];
  tgUserId?: number | null;
}): Promise<PromoCodeReservation | null> {
  const normalizedCode = normalizePromoCode(params.code);
  if (!normalizedCode) return null;

  const row = await loadPromoCode(normalizedCode);
  assertPromoCodeCanBeUsed(row, Date.now());
  await assertPromoCodeCustomerCanUse({ row, tgUserId: params.tgUserId });
  const discountAmount = getPromoDiscountAmount(row, params.orderTotal, params.lines ?? []);
  if (discountAmount <= 0) {
    throw new HttpError(400, "PROMO_CODE_ZERO_DISCOUNT", "Промокод не дает скидку для этой корзины.");
  }

  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("promo_codes")
    .update({
      used_count: row.used_count + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("code", row.code)
    .eq("used_count", row.used_count)
    .lt("used_count", row.max_uses)
    .select("code")
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "DB", `Failed to reserve promo code: ${error.message}`);
  }
  if (!data) {
    throw new HttpError(409, "PROMO_CODE_CONFLICT", "Промокод только что использовали. Попробуйте еще раз.");
  }

  return {
    code: row.code,
    discountAmount,
    categorySlug: getPromoCodeCategorySlug(row),
    requiresPreviousOrder: row.requires_previous_order === true,
  };
}

export async function releasePromoCodeUsage(code: string | null | undefined): Promise<void> {
  const normalizedCode = normalizePromoCode(code);
  if (!normalizedCode) return;

  const supabase = createServiceSupabaseClient();
  const { data } = await supabase
    .from("promo_codes")
    .select("code,used_count")
    .eq("code", normalizedCode)
    .maybeSingle();

  if (!data || data.used_count <= 0) return;

  await supabase
    .from("promo_codes")
    .update({
      used_count: data.used_count - 1,
      updated_at: new Date().toISOString(),
    })
    .eq("code", normalizedCode)
    .eq("used_count", data.used_count);
}
