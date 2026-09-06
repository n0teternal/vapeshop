import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import XlsxPopulate from "xlsx-populate";
import { z } from "zod";
import { config } from "../config.js";
import { HttpError, isHttpError } from "../httpError.js";
import { decodeCsvBuffer } from "../import/decodeCsvBuffer.js";
import { syncFinalOrderTelegramState } from "../order/telegramFinalStatus.js";
import { parseOrderComment } from "../order/orderComment.js";
import {
  formatDeliveryMethodLabel,
  isDeliveryAddressMethod,
} from "../order/deliveryMethod.js";
import { importProductsCsv } from "../import/productsCsv.js";
import { importPromoProductsCsv } from "../import/promoProductsCsv.js";
import { normalizePromoCode } from "../promoCodes/service.js";
import {
  brandMatches,
  extractPromotionBrandLabel,
  getPromotionTypeAdminTitle,
  getPromotionTypePublicTitle,
  normalizePromotionBrandKey,
  normalizePromotionCategorySlug,
  parsePromotionRuleType,
  PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE,
  PROMOTION_TYPE_BUY_POD_GET_LIQUID_CHEAPEST_FREE,
} from "../promotions/rules.js";
import { processReferralRewardForOrderDone } from "../referral/service.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import {
  applyStaffInventoryOperation,
  listStaffMembers,
} from "../staffInventory/service.js";
import { requireAdmin } from "./requireAdmin.js";
import {
  createImagesRestorePoint,
  createProductsRestorePoint,
  listAdminChangeVersions,
  requireAdminHistoryOwner,
  restoreAdminChangeVersion,
} from "./versionHistory.js";

type ApiSuccess<T> = { ok: true; data: T };
type ApiFailure = { ok: false; error: { code: string; message: string } };

function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ApiFailure {
  return { ok: false, error: { code, message } };
}

function toNumber(value: unknown, fieldName: string): number {
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

function toCount(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function stringifyDelimitedRow(values: string[], delimiter: string): string {
  const out: string[] = [];
  for (const v of values) {
    const needsQuotes =
      v.includes("\"") || v.includes("\n") || v.includes("\r") || v.includes(delimiter);
    if (!needsQuotes) {
      out.push(v);
      continue;
    }
    out.push(`\"${v.replace(/\"/g, '\"\"')}\"`);
  }
  return out.join(delimiter);
}

function decodeSpreadsheetBuffer(buffer: Buffer): string {
  const book = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = book.SheetNames[0];
  if (!firstSheetName) {
    throw new HttpError(400, "BAD_REQUEST", "Spreadsheet is empty");
  }

  const sheet = book.Sheets[firstSheetName];
  if (!sheet) {
    throw new HttpError(400, "BAD_REQUEST", "Spreadsheet sheet is missing");
  }

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new HttpError(400, "BAD_REQUEST", "Spreadsheet has no rows");
  }

  return rows
    .map((row) => {
      const cells = Array.isArray(row)
        ? row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)))
        : [];
      return stringifyDelimitedRow(cells, ";");
    })
    .join("\n");
}

type ImportedStaffInventoryRow = {
  staffId: number;
  productId: string;
  stockQty: number;
};

function readStaffInventorySheets(buffer: Buffer): ImportedStaffInventoryRow[] {
  const book = XLSX.read(buffer, { type: "buffer" });
  const staffRows: ImportedStaffInventoryRow[] = [];

  for (const sheetName of book.SheetNames.slice(1)) {
    const sheet = book.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      raw: false,
      defval: "",
      blankrows: false,
    });
    if (rows.length === 0) continue;

    for (const row of rows) {
      const staffId = Number(String(row.staff_id ?? "").trim());
      const productId = String(row.id ?? "").trim();
      const stockQtyRaw = String(row.staff_stock_qty ?? "").trim();
      const stockQty = stockQtyRaw.length === 0 ? 0 : Number(stockQtyRaw);

      if (!Number.isSafeInteger(staffId) || staffId <= 0) {
        throw new HttpError(400, "BAD_REQUEST", `Invalid staff_id in sheet ${sheetName}`);
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId)) {
        throw new HttpError(400, "BAD_REQUEST", `Invalid product id in sheet ${sheetName}`);
      }
      if (!Number.isInteger(stockQty) || stockQty < 0) {
        throw new HttpError(400, "BAD_REQUEST", `Invalid staff_stock_qty in sheet ${sheetName}`);
      }

      staffRows.push({ staffId, productId, stockQty });
    }
  }

  return staffRows;
}

async function syncStaffInventoryFromWorkbook(params: {
  buffer: Buffer;
  cityId: number;
}): Promise<number> {
  const rows = readStaffInventorySheets(params.buffer);
  if (rows.length === 0) return 0;

  const supabase = createServiceSupabaseClient();
  const staffIds = Array.from(new Set(rows.map((row) => row.staffId)));
  const productIds = Array.from(new Set(rows.map((row) => row.productId)));
  const [{ data: staff, error: staffError }, { data: cityInventory, error: cityInventoryError }, { data: currentAllocations, error: allocationsError }] =
    await Promise.all([
      supabase.from("staff_members").select("id").in("id", staffIds),
      supabase
        .from("inventory")
        .select("product_id,stock_qty")
        .eq("city_id", params.cityId)
        .in("product_id", productIds),
      supabase
        .from("staff_inventory")
        .select("staff_id,product_id,stock_qty")
        .eq("city_id", params.cityId)
        .in("product_id", productIds),
    ]);

  if (staffError) throw new HttpError(500, "DB", `Failed to load staff: ${staffError.message}`);
  if (cityInventoryError) {
    throw new HttpError(500, "DB", `Failed to load city inventory: ${cityInventoryError.message}`);
  }
  if (allocationsError) {
    throw new HttpError(500, "DB", `Failed to load staff inventory: ${allocationsError.message}`);
  }

  if ((staff ?? []).length !== staffIds.length) {
    throw new HttpError(400, "BAD_REQUEST", "Workbook references an unknown staff member");
  }

  const cityQtyByProductId = new Map((cityInventory ?? []).map((row) => [row.product_id, row.stock_qty]));
  for (const productId of productIds) {
    if (!cityQtyByProductId.has(productId)) {
      throw new HttpError(400, "BAD_REQUEST", "Workbook references a product missing from city inventory");
    }
  }

  const importedQtyByProductId = new Map<string, number>();
  for (const row of rows) {
    importedQtyByProductId.set(row.productId, (importedQtyByProductId.get(row.productId) ?? 0) + row.stockQty);
  }
  const retainedQtyByProductId = new Map<string, number>();
  for (const allocation of currentAllocations ?? []) {
    if (staffIds.includes(allocation.staff_id)) continue;
    retainedQtyByProductId.set(
      allocation.product_id,
      (retainedQtyByProductId.get(allocation.product_id) ?? 0) + allocation.stock_qty,
    );
  }

  for (const productId of productIds) {
    const cityQty = cityQtyByProductId.get(productId);
    if (cityQty === null || cityQty === undefined) continue;
    const totalStaffQty =
      (importedQtyByProductId.get(productId) ?? 0) + (retainedQtyByProductId.get(productId) ?? 0);
    if (totalStaffQty > cityQty) {
      throw new HttpError(400, "STAFF_STOCK_EXCEEDS_CITY", "Staff stock cannot exceed city stock");
    }
  }

  const { error: upsertError } = await supabase.from("staff_inventory").upsert(
    rows.map((row) => ({
      city_id: params.cityId,
      staff_id: row.staffId,
      product_id: row.productId,
      stock_qty: row.stockQty,
    })),
    { onConflict: "staff_id,city_id,product_id" },
  );
  if (upsertError) {
    throw new HttpError(500, "DB", `Failed to import staff inventory: ${upsertError.message}`);
  }

  return rows.length;
}

function sanitizeFileName(filename: string): string {
  const base = path.basename(filename);
  // Keep Unicode letters/numbers; replace only truly unsafe filename chars.
  return base
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]+/g, "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120);
}

function inferMimeType(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".heic") return "image/heic";
  if (ext === ".avif") return "image/avif";
  return null;
}

const VERSIONED_IMAGE_CACHE_CONTROL_SECONDS = "31536000";
const DEFAULT_IMAGE_CACHE_CONTROL_SECONDS = "2592000";
const ADMIN_REPORT_PASSWORD = "q81231";
const REPORT_PAGE_SIZE = 1000;
const REPORT_CITY_SLUGS = new Set(["vvo", "blg"]);

type ListedImageFile = { name: string; size: number; updatedAt: string };
type StorageLocation = { bucket: string; prefix: string };
type PromotionRuleAdminRow = {
  id: number;
  city_id: number | null;
  type: string;
  title: string;
  category_slug: string;
  brand: string | null;
  product_ids?: string[] | null;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  created_at: string;
};

type PromoCodeAdminRow = {
  code: string;
  discount_amount: unknown;
  starts_at: string;
  ends_at: string;
  max_uses: number;
  used_count: number;
  is_active: boolean;
  requires_previous_order?: boolean | null;
  category_slug?: string | null;
  created_at: string;
};

const PROMO_CODE_ADMIN_SELECT =
  "code,discount_amount,starts_at,ends_at,max_uses,used_count,is_active,requires_previous_order,category_slug,created_at";

const PROMOTION_RULE_ADMIN_SELECT_WITH_PRODUCT_IDS =
  "id,city_id,type,title,category_slug,brand,product_ids,starts_at,ends_at,is_active,created_at";
const PROMOTION_RULE_ADMIN_SELECT_WITHOUT_PRODUCT_IDS =
  "id,city_id,type,title,category_slug,brand,starts_at,ends_at,is_active,created_at";

type ReportOrderRow = {
  id: string;
  created_at: string;
  status: string;
  city_id: number | null;
  tg_user_id: number;
  tg_username: string | null;
  delivery_method: string;
  comment: string | null;
  total_price: unknown;
  total_before_discount: unknown;
  promotion_discount_amount: unknown;
  discount_amount: unknown;
  coupon_discount_amount?: unknown;
  total_after_discount: unknown;
  coupon_id?: string | null;
};

type ReportOrderItemRow = {
  order_id: string;
  product_id: string | null;
  qty: number;
  unit_price: unknown;
};

type ReportProductRow = {
  id: string;
  title: string;
  category_slug: string;
};

type ReportCityRow = {
  id: number;
  name: string;
  slug: string;
};

type ReportLoyaltyRow = {
  id: number;
  tg_user_id: number;
  delta_points: number;
  kind: string;
  referral_id: number | null;
  order_id: string | null;
  created_at: string;
};

type ReportCouponRow = {
  id: string;
  tg_user_id: number;
  kind: string;
  value: number;
  min_order_sum: number;
  max_discount: number | null;
  source: string;
  referral_id: number | null;
  is_used: boolean;
  used_order_id: string | null;
  expires_at: string | null;
  created_at: string;
  used_at: string | null;
};

type ReportReferralRow = {
  id: number;
  inviter_tg_user_id: number;
  invitee_tg_user_id: number;
  status: string;
  qualified_order_id: string | null;
  qualified_at: string | null;
  rewarded_at: string | null;
  created_at: string;
};

type ReportProfileRow = {
  tg_user_id: number;
  referral_code: string;
  referred_by_tg_user_id: number | null;
  referral_bound_at: string | null;
  tg_username: string | null;
  created_at: string;
};

function parseStorageLocationFromBaseUrl(baseUrl: string | null): StorageLocation | null {
  if (!baseUrl) return null;

  try {
    const url = new URL(baseUrl);
    const marker = "/storage/v1/object/public/";
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex < 0) return null;

    const tail = url.pathname
      .slice(markerIndex + marker.length)
      .replace(/^\/+|\/+$/g, "");
    if (!tail) return null;

    const [bucket, ...prefixParts] = tail.split("/").map((part) => decodeURIComponent(part));
    if (!bucket) return null;

    return { bucket, prefix: prefixParts.join("/") };
  } catch {
    return null;
  }
}

function joinStoragePath(prefix: string, filename: string): string {
  return prefix ? `${prefix}/${filename}` : filename;
}

function isMissingDbObjectError(error: unknown, objectName: string): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; message?: unknown };
  const code = typeof maybeError.code === "string" ? maybeError.code : "";
  const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
  const normalizedObject = objectName.toLowerCase();
  return (
    code === "PGRST205" ||
    code === "42P01" ||
    (message.includes(normalizedObject) &&
      (message.includes("schema cache") ||
        message.includes("relation") ||
        message.includes("does not exist")))
  );
}

function isMissingColumnError(error: unknown, columnName: string): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; message?: unknown };
  const code = typeof maybeError.code === "string" ? maybeError.code : "";
  const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
  const normalizedColumn = columnName.toLowerCase();
  return (
    code === "PGRST204" ||
    code === "42703" ||
    (message.includes(normalizedColumn) &&
      (message.includes("schema cache") ||
        message.includes("column") ||
        message.includes("does not exist")))
  );
}

function isPromoCodesSchemaOutdatedError(error: unknown): boolean {
  return (
    isMissingDbObjectError(error, "promo_codes") ||
    isMissingColumnError(error, "requires_previous_order") ||
    isMissingColumnError(error, "category_slug")
  );
}

function isStorageNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { message?: unknown; statusCode?: unknown };
  const message =
    typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
  const statusCode = maybeError.statusCode;
  return message.includes("not found") || statusCode === 404 || statusCode === "404";
}

async function listLocalItemFiles(itemsDir: string): Promise<ListedImageFile[]> {
  await fs.mkdir(itemsDir, { recursive: true });
  const entries = await fs.readdir(itemsDir, { withFileTypes: true });
  const files: ListedImageFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === ".gitkeep") continue;
    const fullPath = path.join(itemsDir, name);
    const stat = await fs.stat(fullPath);
    files.push({ name, size: stat.size, updatedAt: stat.mtime.toISOString() });
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

async function listStorageItemFiles(location: StorageLocation): Promise<ListedImageFile[]> {
  const supabase = createServiceSupabaseClient();
  const files: ListedImageFile[] = [];
  const pageSize = 1000;
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase.storage.from(location.bucket).list(location.prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });

    if (error) {
      throw new HttpError(500, "STORAGE", `Failed to list storage files: ${error.message}`);
    }

    const page = data ?? [];
    for (const entry of page) {
      if (!entry || typeof entry.name !== "string") continue;
      if (entry.name === ".gitkeep") continue;
      if (entry.id === null) continue;

      const size =
        entry.metadata && typeof entry.metadata === "object" && "size" in entry.metadata
          ? Number((entry.metadata as { size?: unknown }).size ?? 0)
          : 0;
      const updatedAt =
        typeof entry.updated_at === "string" && entry.updated_at.length > 0
          ? entry.updated_at
          : new Date(0).toISOString();

      files.push({
        name: entry.name,
        size: Number.isFinite(size) ? size : 0,
        updatedAt,
      });
    }

    if (page.length < pageSize) break;
    offset += page.length;
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

function getParamId(request: FastifyRequest): string {
  const params = request.params as unknown;
  const parsed = z.object({ id: z.string().uuid() }).safeParse(params);
  if (!parsed.success) {
    throw new HttpError(400, "BAD_REQUEST", "Invalid id");
  }
  return parsed.data.id;
}

function parseOptionalIsoDateTime(value: string | null | undefined, fieldName: string): string | null {
  if (value === undefined || value === null) return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) {
    throw new HttpError(400, "BAD_REQUEST", `${fieldName} must be a valid date`);
  }

  return date.toISOString();
}

function normalizePromotionProductIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0),
    ),
  ];
}

function isPromotionRuleActiveAt(row: PromotionRuleAdminRow, nowMs: number): boolean {
  if (!row.is_active) return false;

  const startsAtMs = row.starts_at ? new Date(row.starts_at).getTime() : Number.NaN;
  if (Number.isFinite(startsAtMs) && startsAtMs > nowMs) return false;

  const endsAtMs = row.ends_at ? new Date(row.ends_at).getTime() : Number.NaN;
  if (Number.isFinite(endsAtMs) && endsAtMs < nowMs) return false;

  return true;
}

function mapPromotionRuleForAdmin(
  row: PromotionRuleAdminRow,
  cityById?: Map<number, { name: string; slug: string }>,
  nowMs = Date.now(),
) {
  const type = parsePromotionRuleType(row.type) ?? PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE;
  const city =
    typeof row.city_id === "number" && cityById ? cityById.get(row.city_id) ?? null : null;

  return {
    id: row.id,
    cityId: row.city_id,
    citySlug: city?.slug ?? null,
    cityName: city?.name ?? null,
    type,
    adminTitle: getPromotionTypeAdminTitle(type),
    publicTitle: row.title || getPromotionTypePublicTitle(type),
    categorySlug: normalizePromotionCategorySlug(row.category_slug),
    brand: row.brand,
    productIds: normalizePromotionProductIds(row.product_ids),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isActive: isPromotionRuleActiveAt(row, nowMs),
    createdAt: row.created_at,
  };
}

function parsePromoCodeDate(value: string, fieldName: string, endOfDay: boolean): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new HttpError(400, "BAD_REQUEST", `${fieldName} is required`);
  }

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const isoValue = dateOnlyMatch
    ? `${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+10:00`
    : trimmed;
  const date = new Date(isoValue);
  if (!Number.isFinite(date.getTime())) {
    throw new HttpError(400, "BAD_REQUEST", `${fieldName} must be a valid date`);
  }

  return date.toISOString();
}

function mapPromoCodeForAdmin(row: PromoCodeAdminRow) {
  return {
    code: row.code,
    discountAmount: Math.max(0, Math.trunc(toNumber(row.discount_amount, "promo_codes.discount_amount"))),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    isActive: row.is_active,
    requiresPreviousOrder: row.requires_previous_order === true,
    categorySlug:
      typeof row.category_slug === "string" && row.category_slug.trim().length > 0
        ? normalizePromotionCategorySlug(row.category_slug)
        : null,
    createdAt: row.created_at,
  };
}

function getJoinedProduct(row: {
  products?: unknown;
}): { title?: unknown; category_slug?: unknown; is_active?: unknown } | null {
  const products = row.products;
  if (Array.isArray(products)) {
    const first = products[0];
    return typeof first === "object" && first !== null ? first : null;
  }
  return typeof products === "object" && products !== null ? products : null;
}

async function validatePromotionProductIds(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  cityId: number;
  categorySlug: string;
  brand: string | null;
  productIds: string[];
}): Promise<string[]> {
  if (params.productIds.length === 0) return [];

  const { data, error } = await params.supabase
    .from("inventory")
    .select("product_id,products!inner(title,category_slug,is_active)")
    .eq("city_id", params.cityId)
    .eq("in_stock", true)
    .eq("products.is_active", true)
    .in("product_id", params.productIds);

  if (error) {
    throw new HttpError(500, "DB", `Failed to validate promotion models: ${error.message}`);
  }

  const validIds = new Set<string>();
  for (const row of (data ?? []) as Array<{ product_id?: unknown; products?: unknown }>) {
    const productId = typeof row.product_id === "string" ? row.product_id : "";
    const product = getJoinedProduct(row);
    const title = typeof product?.title === "string" ? product.title : "";
    const categorySlug =
      typeof product?.category_slug === "string"
        ? normalizePromotionCategorySlug(product.category_slug)
        : "";

    if (!productId) continue;
    if (categorySlug !== params.categorySlug) continue;
    if (!brandMatches(title, params.brand)) continue;

    validIds.add(productId);
  }

  if (validIds.size !== params.productIds.length) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      "Selected models must belong to the selected city, category and brands",
    );
  }

  return params.productIds.filter((productId) => validIds.has(productId));
}

function moneyFromUnknown(value: unknown, fieldName: string): number {
  if (value === null || value === undefined) return 0;
  return toNumber(value, fieldName);
}

function formatReportDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("ru-RU", {
    timeZone: "Asia/Vladivostok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function reportFileDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function shortOrderId(orderId: string): string {
  return orderId.slice(0, 8).toUpperCase();
}

function cityLabel(city: ReportCityRow | undefined | null): string {
  if (!city) return "Не указан";
  return `${city.name} (${city.slug.toUpperCase()})`;
}

function customerLabel(params: {
  tgUserId: number;
  tgUsername: string | null;
  profile?: ReportProfileRow | undefined;
}): string {
  const username = params.tgUsername ?? params.profile?.tg_username ?? null;
  return username ? `@${username.replace(/^@+/, "")}` : String(params.tgUserId);
}

function categoryReportLabel(categorySlug: string | null | undefined): string {
  const normalized = normalizePromotionCategorySlug(categorySlug ?? "");
  const labels: Record<string, string> = {
    disposable: "Одноразки",
    liquid: "Жидкости",
    pod: "Pod",
    cartridge: "Картриджи",
    tobacco: "Табак",
    other: "Прочее",
  };
  return labels[normalized] ?? normalized;
}

function normalizeAddressForReport(value: string | null): string {
  return (value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/g, "")
    .toLowerCase();
}

function appendJsonSheet(
  workbook: XLSX.WorkBook,
  sheetName: string,
  rows: Array<Record<string, unknown>>,
): void {
  const data = rows.length > 0 ? rows : [{ "Нет данных": "" }];
  const worksheet = XLSX.utils.json_to_sheet(data);
  const headers = Object.keys(data[0] ?? {});

  worksheet["!cols"] = headers.map((header) => {
    const maxCellLength = data.reduce((max, row) => {
      const value = row[header];
      const text =
        value === null || value === undefined
          ? ""
          : value instanceof Date
            ? value.toISOString()
            : String(value);
      return Math.max(max, text.length);
    }, header.length);

    return { wch: Math.max(10, Math.min(54, maxCellLength + 2)) };
  });

  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
}

async function encryptWorkbookBuffer(buffer: Buffer, password: string): Promise<Buffer> {
  const workbook = await XlsxPopulate.fromDataAsync(buffer);
  const encrypted = await workbook.outputAsync({ type: "nodebuffer", password });
  if (Buffer.isBuffer(encrypted)) return encrypted;
  if (encrypted instanceof ArrayBuffer) return Buffer.from(encrypted);
  if (typeof encrypted === "string") return Buffer.from(encrypted, "binary");
  return Buffer.from(encrypted);
}

async function fetchDoneReportOrders(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
): Promise<ReportOrderRow[]> {
  const baseSelect =
    "id,created_at,status,city_id,tg_user_id,tg_username,delivery_method,comment,total_price,total_before_discount,promotion_discount_amount,discount_amount,total_after_discount";
  const selectWithCouponDiscount = `${baseSelect},coupon_id,coupon_discount_amount`;
  const selectWithCoupon =
    `${baseSelect},coupon_id`;
  const selectWithoutCoupon = baseSelect;

  let select = selectWithCouponDiscount;

  for (;;) {
    const rows: ReportOrderRow[] = [];
    let offset = 0;

    for (;;) {
      const { data, error } = await supabase
        .from("orders")
        .select(select)
        .eq("status", "done")
        .order("created_at", { ascending: false })
        .range(offset, offset + REPORT_PAGE_SIZE - 1);

      if (error) {
        if (
          select === selectWithCouponDiscount &&
          isMissingColumnError(error, "coupon_discount_amount")
        ) {
          select = selectWithCoupon;
          break;
        }
        if (
          (select === selectWithCouponDiscount || select === selectWithCoupon) &&
          isMissingColumnError(error, "coupon_id")
        ) {
          select = selectWithoutCoupon;
          break;
        }
        throw new HttpError(500, "DB", `Failed to load done orders: ${error.message}`);
      }

      const page = (data ?? []) as unknown as ReportOrderRow[];
      rows.push(...page);
      if (page.length < REPORT_PAGE_SIZE) return rows;
      offset += page.length;
    }
  }
}

async function fetchReportOrderItems(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orderIds: string[],
): Promise<ReportOrderItemRow[]> {
  const rows: ReportOrderItemRow[] = [];

  for (const part of chunk(orderIds, 300)) {
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("order_items")
        .select("order_id,product_id,qty,unit_price")
        .in("order_id", part)
        .range(offset, offset + REPORT_PAGE_SIZE - 1);

      if (error) {
        throw new HttpError(500, "DB", `Failed to load report order items: ${error.message}`);
      }

      const page = (data ?? []) as ReportOrderItemRow[];
      rows.push(...page);
      if (page.length < REPORT_PAGE_SIZE) break;
      offset += page.length;
    }
  }

  return rows;
}

async function fetchReportProducts(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  productIds: string[],
): Promise<ReportProductRow[]> {
  const rows: ReportProductRow[] = [];

  for (const part of chunk(productIds, 500)) {
    const { data, error } = await supabase
      .from("products")
      .select("id,title,category_slug")
      .in("id", part);

    if (error) {
      throw new HttpError(500, "DB", `Failed to load report products: ${error.message}`);
    }

    rows.push(...((data ?? []) as ReportProductRow[]));
  }

  return rows;
}

async function fetchReportCities(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
): Promise<ReportCityRow[]> {
  const { data, error } = await supabase
    .from("cities")
    .select("id,name,slug")
    .order("slug", { ascending: true });

  if (error) {
    throw new HttpError(500, "DB", `Failed to load report cities: ${error.message}`);
  }

  return (data ?? []) as ReportCityRow[];
}

async function fetchReportLoyaltyTransactions(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orderIds: string[],
): Promise<ReportLoyaltyRow[]> {
  const rows: ReportLoyaltyRow[] = [];

  for (const part of chunk(orderIds, 500)) {
    const { data, error } = await supabase
      .from("loyalty_transactions")
      .select("id,tg_user_id,delta_points,kind,referral_id,order_id,created_at")
      .in("order_id", part);

    if (error) {
      if (isMissingDbObjectError(error, "loyalty_transactions")) return [];
      throw new HttpError(500, "DB", `Failed to load loyalty transactions: ${error.message}`);
    }

    rows.push(...((data ?? []) as ReportLoyaltyRow[]));
  }

  return rows;
}

async function fetchReportCoupons(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  orderIds: string[];
  couponIds: string[];
}): Promise<ReportCouponRow[]> {
  const byId = new Map<string, ReportCouponRow>();
  const select =
    "id,tg_user_id,kind,value,min_order_sum,max_discount,source,referral_id,is_used,used_order_id,expires_at,created_at,used_at";

  for (const part of chunk(params.orderIds, 500)) {
    const { data, error } = await params.supabase
      .from("coupons")
      .select(select)
      .in("used_order_id", part);

    if (error) {
      if (isMissingDbObjectError(error, "coupons")) return [];
      throw new HttpError(500, "DB", `Failed to load coupons by order: ${error.message}`);
    }

    for (const row of (data ?? []) as ReportCouponRow[]) byId.set(row.id, row);
  }

  for (const part of chunk(params.couponIds, 500)) {
    if (part.length === 0) continue;
    const { data, error } = await params.supabase.from("coupons").select(select).in("id", part);

    if (error) {
      if (isMissingDbObjectError(error, "coupons")) return Array.from(byId.values());
      throw new HttpError(500, "DB", `Failed to load coupons by id: ${error.message}`);
    }

    for (const row of (data ?? []) as ReportCouponRow[]) byId.set(row.id, row);
  }

  return Array.from(byId.values());
}

async function fetchReportPromoCodes(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
): Promise<PromoCodeAdminRow[]> {
  const { data, error } = await supabase
    .from("promo_codes")
    .select(PROMO_CODE_ADMIN_SELECT)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    if (isMissingDbObjectError(error, "promo_codes")) return [];
    throw new HttpError(500, "DB", `Failed to load report promo codes: ${error.message}`);
  }

  return (data ?? []) as PromoCodeAdminRow[];
}

async function fetchReportReferrals(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  userIds: number[],
): Promise<ReportReferralRow[]> {
  const rows: ReportReferralRow[] = [];

  for (const part of chunk(userIds, 500)) {
    const { data, error } = await supabase
      .from("referrals")
      .select("id,inviter_tg_user_id,invitee_tg_user_id,status,qualified_order_id,qualified_at,rewarded_at,created_at")
      .in("invitee_tg_user_id", part);

    if (error) {
      if (isMissingDbObjectError(error, "referrals")) return [];
      throw new HttpError(500, "DB", `Failed to load referrals: ${error.message}`);
    }

    rows.push(...((data ?? []) as ReportReferralRow[]));
  }

  return rows;
}

async function fetchReportProfiles(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  userIds: number[],
): Promise<ReportProfileRow[]> {
  const rows: ReportProfileRow[] = [];

  for (const part of chunk(userIds, 500)) {
    const { data, error } = await supabase
      .from("customer_profiles")
      .select("tg_user_id,referral_code,referred_by_tg_user_id,referral_bound_at,tg_username,created_at")
      .in("tg_user_id", part);

    if (error) {
      if (isMissingDbObjectError(error, "customer_profiles")) return [];
      throw new HttpError(500, "DB", `Failed to load customer profiles: ${error.message}`);
    }

    rows.push(...((data ?? []) as ReportProfileRow[]));
  }

  return rows;
}

export async function buildBusinessReportWorkbook(
  options: { encrypt?: boolean } = {},
): Promise<{ buffer: Buffer; filename: string }> {
  const supabase = createServiceSupabaseClient();
  const allCities = await fetchReportCities(supabase);
  const reportCities = allCities.filter((city) => REPORT_CITY_SLUGS.has(city.slug));
  const reportCityIds = new Set(reportCities.map((city) => city.id));
  const orders = (await fetchDoneReportOrders(supabase)).filter(
    (order) => typeof order.city_id === "number" && reportCityIds.has(order.city_id),
  );
  const orderIds = orders.map((order) => order.id);
  const userIds = Array.from(new Set(orders.map((order) => order.tg_user_id)));
  const couponIds = Array.from(
    new Set(
      orders
        .map((order) => order.coupon_id)
        .filter((couponId): couponId is string => typeof couponId === "string" && couponId.length > 0),
    ),
  );

  const items = orderIds.length > 0 ? await fetchReportOrderItems(supabase, orderIds) : [];
  const productIds = Array.from(
    new Set(items.map((item) => item.product_id).filter((id): id is string => typeof id === "string")),
  );

  const [products, loyaltyRows, coupons, promoCodes, referrals] = await Promise.all([
    productIds.length > 0 ? fetchReportProducts(supabase, productIds) : Promise.resolve([]),
    orderIds.length > 0 ? fetchReportLoyaltyTransactions(supabase, orderIds) : Promise.resolve([]),
    orderIds.length > 0 || couponIds.length > 0
      ? fetchReportCoupons({ supabase, orderIds, couponIds })
      : Promise.resolve([]),
    fetchReportPromoCodes(supabase),
    userIds.length > 0 ? fetchReportReferrals(supabase, userIds) : Promise.resolve([]),
  ]);

  const referralUserIds = Array.from(
    new Set([
      ...userIds,
      ...referrals.map((referral) => referral.inviter_tg_user_id),
      ...referrals.map((referral) => referral.invitee_tg_user_id),
    ]),
  );
  const profiles =
    referralUserIds.length > 0 ? await fetchReportProfiles(supabase, referralUserIds) : [];

  const cityById = new Map(reportCities.map((city) => [city.id, city]));
  const productById = new Map(products.map((product) => [product.id, product]));
  const profileByUserId = new Map(profiles.map((profile) => [profile.tg_user_id, profile]));
  const referralByInviteeId = new Map(referrals.map((referral) => [referral.invitee_tg_user_id, referral]));
  const couponsByOrderId = new Map<string, ReportCouponRow>();
  const couponById = new Map(coupons.map((coupon) => [coupon.id, coupon]));
  for (const coupon of coupons) {
    if (coupon.used_order_id) couponsByOrderId.set(coupon.used_order_id, coupon);
  }

  const loyaltyByOrderId = new Map<string, ReportLoyaltyRow[]>();
  for (const row of loyaltyRows) {
    if (!row.order_id) continue;
    const current = loyaltyByOrderId.get(row.order_id) ?? [];
    current.push(row);
    loyaltyByOrderId.set(row.order_id, current);
  }

  const itemsByOrderId = new Map<string, ReportOrderItemRow[]>();
  for (const item of items) {
    const current = itemsByOrderId.get(item.order_id) ?? [];
    current.push(item);
    itemsByOrderId.set(item.order_id, current);
  }

  const cityStats = new Map<
    string,
    {
      city: string;
      orders: number;
      revenue: number;
      beforeDiscount: number;
      promoDiscount: number;
      couponDiscount: number;
      pointsSpent: number;
      promoOrders: number;
      couponOrders: number;
      referralOrders: number;
      qty: number;
      customers: Set<number>;
      delivery: number;
      pickup: number;
    }
  >();
  const productStats = new Map<
    string,
    {
      city: string;
      category: string;
      productId: string;
      title: string;
      qty: number;
      revenue: number;
      orders: Set<string>;
      customers: Set<number>;
    }
  >();
  const customerStats = new Map<
    number,
    {
      userId: number;
      username: string | null;
      orders: number;
      revenue: number;
      beforeDiscount: number;
      promoDiscount: number;
      couponDiscount: number;
      pointsSpent: number;
      qty: number;
      cities: Set<string>;
      addresses: Set<string>;
      firstOrderAt: string | null;
      lastOrderAt: string | null;
    }
  >();
  const addressStats = new Map<
    string,
    {
      city: string;
      address: string;
      orders: number;
      revenue: number;
      customers: Set<number>;
      lastOrderAt: string | null;
    }
  >();

  const orderRows: Array<Record<string, unknown>> = [];
  const itemRows: Array<Record<string, unknown>> = [];

  orders.forEach((order, index) => {
    const orderItems = itemsByOrderId.get(order.id) ?? [];
    const city = cityById.get(order.city_id ?? -1);
    const cityName = cityLabel(city);
    const parsedComment = parseOrderComment(order.comment);
    const totalBeforeDiscount = moneyFromUnknown(
      order.total_before_discount ?? order.total_price,
      "orders.total_before_discount",
    );
    const totalPaid = moneyFromUnknown(
      order.total_after_discount ?? order.total_price,
      "orders.total_after_discount",
    );
    const promoDiscount = moneyFromUnknown(
      order.promotion_discount_amount,
      "orders.promotion_discount_amount",
    );
    const couponDiscount = moneyFromUnknown(
      order.coupon_discount_amount ?? 0,
      "orders.coupon_discount_amount",
    );
    const pointsSpentFromOrder = moneyFromUnknown(order.discount_amount, "orders.discount_amount");
    const pointsSpentFromLedger = (loyaltyByOrderId.get(order.id) ?? [])
      .filter((row) => row.kind === "order_points_spend" && row.delta_points < 0)
      .reduce((sum, row) => sum + Math.abs(row.delta_points), 0);
    const pointsSpent = Math.max(pointsSpentFromOrder, pointsSpentFromLedger);
    const coupon = order.coupon_id
      ? couponById.get(order.coupon_id) ?? couponsByOrderId.get(order.id) ?? null
      : couponsByOrderId.get(order.id) ?? null;
    const hasCoupon = coupon !== null || Boolean(order.coupon_id) || couponDiscount > 0;
    const referral = referralByInviteeId.get(order.tg_user_id) ?? null;
    const profile = profileByUserId.get(order.tg_user_id);
    const inviterProfile =
      referral && profileByUserId.has(referral.inviter_tg_user_id)
        ? profileByUserId.get(referral.inviter_tg_user_id)
        : undefined;
    const customer = customerLabel({
      tgUserId: order.tg_user_id,
      tgUsername: order.tg_username,
      profile,
    });
    const itemQty = orderItems.reduce((sum, item) => sum + Math.max(0, Math.trunc(item.qty)), 0);
    const categories = Array.from(
      new Set(
        orderItems.map((item) =>
          categoryReportLabel(
            item.product_id ? productById.get(item.product_id)?.category_slug ?? "other" : "other",
          ),
        ),
      ),
    ).join(", ");
    const reportOrderNumber = index + 1;

    orderRows.push({
      "№": reportOrderNumber,
      "Номер заказа": shortOrderId(order.id),
      "ID заказа": order.id,
      "Дата": formatReportDate(order.created_at),
      "Дата ISO": order.created_at,
      "Город": cityName,
      "Клиент": customer,
      "tg_user_id": order.tg_user_id,
      "username": order.tg_username ? `@${order.tg_username}` : "",
      "Тип доставки": formatDeliveryMethodLabel(order.delivery_method),
      "Телефон": parsedComment.phone ?? "",
      "Адрес": parsedComment.address ?? "",
      "Дата доставки": parsedComment.deliveryDate ?? "",
      "Время доставки": parsedComment.deliveryTimeSlot ?? "",
      "Комментарий": parsedComment.comment ?? "",
      "Типы продуктов": categories,
      "Товаров, шт": itemQty,
      "Строк товаров": orderItems.length,
      "Сумма до скидок": totalBeforeDiscount,
      "Скидка 1+1/акции": promoDiscount,
      "Скидка промокода": couponDiscount,
      "Реферальные баллы списано": pointsSpent,
      "Акция использована": promoDiscount > 0 ? "да" : "нет",
      "Промокод использован": hasCoupon ? "да" : "нет",
      "Промокод/акция": hasCoupon || promoDiscount > 0 ? "да" : "нет",
      "Промокод": coupon?.id ?? order.coupon_id ?? "",
      "Промокод тип": coupon?.kind ?? "",
      "Промокод источник": coupon?.source ?? "",
      "Рефералка": referral ? "да" : "нет",
      "Статус рефералки": referral?.status ?? "",
      "Кто пригласил": referral
        ? customerLabel({
            tgUserId: referral.inviter_tg_user_id,
            tgUsername: null,
            profile: inviterProfile,
          })
        : "",
      "Итого оплачено": totalPaid,
    });

    const cityKey = city?.slug ?? "unknown";
    const cityStat = cityStats.get(cityKey) ?? {
      city: cityName,
      orders: 0,
      revenue: 0,
      beforeDiscount: 0,
      promoDiscount: 0,
      couponDiscount: 0,
      pointsSpent: 0,
      promoOrders: 0,
      couponOrders: 0,
      referralOrders: 0,
      qty: 0,
      customers: new Set<number>(),
      delivery: 0,
      pickup: 0,
    };
    cityStat.orders += 1;
    cityStat.revenue += totalPaid;
    cityStat.beforeDiscount += totalBeforeDiscount;
    cityStat.promoDiscount += promoDiscount;
    cityStat.couponDiscount += couponDiscount;
    cityStat.pointsSpent += pointsSpent;
    if (promoDiscount > 0) cityStat.promoOrders += 1;
    if (hasCoupon) cityStat.couponOrders += 1;
    if (referral) cityStat.referralOrders += 1;
    cityStat.qty += itemQty;
    cityStat.customers.add(order.tg_user_id);
    if (isDeliveryAddressMethod(order.delivery_method)) cityStat.delivery += 1;
    else cityStat.pickup += 1;
    cityStats.set(cityKey, cityStat);

    const customerStat = customerStats.get(order.tg_user_id) ?? {
      userId: order.tg_user_id,
      username: order.tg_username,
      orders: 0,
      revenue: 0,
      beforeDiscount: 0,
      promoDiscount: 0,
      couponDiscount: 0,
      pointsSpent: 0,
      qty: 0,
      cities: new Set<string>(),
      addresses: new Set<string>(),
      firstOrderAt: null,
      lastOrderAt: null,
    };
    customerStat.orders += 1;
    customerStat.revenue += totalPaid;
    customerStat.beforeDiscount += totalBeforeDiscount;
    customerStat.promoDiscount += promoDiscount;
    customerStat.couponDiscount += couponDiscount;
    customerStat.pointsSpent += pointsSpent;
    customerStat.qty += itemQty;
    customerStat.cities.add(cityName);
    if (parsedComment.address) customerStat.addresses.add(parsedComment.address);
    if (!customerStat.firstOrderAt || order.created_at < customerStat.firstOrderAt) {
      customerStat.firstOrderAt = order.created_at;
    }
    if (!customerStat.lastOrderAt || order.created_at > customerStat.lastOrderAt) {
      customerStat.lastOrderAt = order.created_at;
    }
    customerStats.set(order.tg_user_id, customerStat);

    const normalizedAddress = normalizeAddressForReport(parsedComment.address);
    if (normalizedAddress) {
      const addressKey = `${cityKey}:${normalizedAddress}`;
      const addressStat = addressStats.get(addressKey) ?? {
        city: cityName,
        address: parsedComment.address ?? normalizedAddress,
        orders: 0,
        revenue: 0,
        customers: new Set<number>(),
        lastOrderAt: null,
      };
      addressStat.orders += 1;
      addressStat.revenue += totalPaid;
      addressStat.customers.add(order.tg_user_id);
      if (!addressStat.lastOrderAt || order.created_at > addressStat.lastOrderAt) {
        addressStat.lastOrderAt = order.created_at;
      }
      addressStats.set(addressKey, addressStat);
    }

    for (const item of orderItems) {
      const product = item.product_id ? productById.get(item.product_id) : undefined;
      const qty = Math.max(0, Math.trunc(item.qty));
      const unitPrice = moneyFromUnknown(item.unit_price, "order_items.unit_price");
      const lineTotal = unitPrice * qty;
      const category = categoryReportLabel(product?.category_slug);
      const productTitle = product?.title ?? "Товар удалён";
      const productId = item.product_id ?? "";

      itemRows.push({
        "№ заказа": reportOrderNumber,
        "Номер заказа": shortOrderId(order.id),
        "ID заказа": order.id,
        "Дата": formatReportDate(order.created_at),
        "Город": cityName,
        "Клиент": customer,
        "tg_user_id": order.tg_user_id,
        "Телефон": parsedComment.phone ?? "",
        "Адрес": parsedComment.address ?? "",
        "product_id": productId,
        "Название товара": productTitle,
        "Тип продукта": category,
        "Кол-во": qty,
        "Цена за шт": unitPrice,
        "Сумма строки": lineTotal,
        "Акция в заказе": promoDiscount > 0 ? "да" : "нет",
        "Промокод в заказе": hasCoupon ? "да" : "нет",
      });

      const productKey = `${cityKey}:${productId || productTitle}`;
      const productStat = productStats.get(productKey) ?? {
        city: cityName,
        category,
        productId,
        title: productTitle,
        qty: 0,
        revenue: 0,
        orders: new Set<string>(),
        customers: new Set<number>(),
      };
      productStat.qty += qty;
      productStat.revenue += lineTotal;
      productStat.orders.add(order.id);
      productStat.customers.add(order.tg_user_id);
      productStats.set(productKey, productStat);
    }
  });

  const cityRows = Array.from(cityStats.values())
    .sort((a, b) => b.revenue - a.revenue)
    .map((stat) => ({
      "Город": stat.city,
      "Выполненных заказов": stat.orders,
      "Выручка": stat.revenue,
      "Средний чек": stat.orders > 0 ? Math.round(stat.revenue / stat.orders) : 0,
      "Сумма до скидок": stat.beforeDiscount,
      "Скидка 1+1/акции": stat.promoDiscount,
      "Скидка промокодов": stat.couponDiscount,
      "Реферальные баллы списано": stat.pointsSpent,
      "Заказов с акцией": stat.promoOrders,
      "Заказов с промокодом": stat.couponOrders,
      "Заказов от рефералов": stat.referralOrders,
      "Товаров, шт": stat.qty,
      "Уникальных клиентов": stat.customers.size,
      "Доставка": stat.delivery,
      "Самовывоз": stat.pickup,
    }));

  const productRows = Array.from(productStats.values())
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty)
    .map((stat) => ({
      "Город": stat.city,
      "Тип продукта": stat.category,
      "product_id": stat.productId,
      "Название товара": stat.title,
      "Кол-во": stat.qty,
      "Выручка по строкам": stat.revenue,
      "Заказов": stat.orders.size,
      "Уникальных клиентов": stat.customers.size,
    }));

  const customerRows = Array.from(customerStats.values())
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders)
    .map((stat) => {
      const profile = profileByUserId.get(stat.userId);
      const referral = referralByInviteeId.get(stat.userId);
      return {
        "Клиент": customerLabel({
          tgUserId: stat.userId,
          tgUsername: stat.username,
          profile,
        }),
        "tg_user_id": stat.userId,
        "username": stat.username ? `@${stat.username}` : profile?.tg_username ? `@${profile.tg_username}` : "",
        "Заказов": stat.orders,
        "Выручка": stat.revenue,
        "Средний чек": stat.orders > 0 ? Math.round(stat.revenue / stat.orders) : 0,
        "Сумма до скидок": stat.beforeDiscount,
        "Скидка 1+1/акции": stat.promoDiscount,
        "Скидка промокодов": stat.couponDiscount,
        "Реферальные баллы списано": stat.pointsSpent,
        "Товаров, шт": stat.qty,
        "Города": Array.from(stat.cities).join(", "),
        "Адреса": Array.from(stat.addresses).join(" | "),
        "Первый заказ": stat.firstOrderAt ? formatReportDate(stat.firstOrderAt) : "",
        "Последний заказ": stat.lastOrderAt ? formatReportDate(stat.lastOrderAt) : "",
        "Пришёл по рефералке": referral ? "да" : "нет",
        "Статус рефералки": referral?.status ?? "",
      };
    });

  const addressRows = Array.from(addressStats.values())
    .sort((a, b) => b.orders - a.orders || b.revenue - a.revenue)
    .map((stat) => ({
      "Город": stat.city,
      "Адрес": stat.address,
      "Заказов": stat.orders,
      "Выручка": stat.revenue,
      "Уникальных клиентов": stat.customers.size,
      "Последний заказ": stat.lastOrderAt ? formatReportDate(stat.lastOrderAt) : "",
    }));

  const referralRows = referrals.map((referral) => ({
    "referral_id": referral.id,
    "Пригласивший": customerLabel({
      tgUserId: referral.inviter_tg_user_id,
      tgUsername: null,
      profile: profileByUserId.get(referral.inviter_tg_user_id),
    }),
    "ID пригласившего": referral.inviter_tg_user_id,
    "Приглашенный": customerLabel({
      tgUserId: referral.invitee_tg_user_id,
      tgUsername: null,
      profile: profileByUserId.get(referral.invitee_tg_user_id),
    }),
    "ID приглашенного": referral.invitee_tg_user_id,
    "Статус": referral.status,
    "Квалифицированный заказ": referral.qualified_order_id ?? "",
    "Начислено": referral.rewarded_at ? "да" : "нет",
    "Дата создания": formatReportDate(referral.created_at),
    "Дата награды": referral.rewarded_at ? formatReportDate(referral.rewarded_at) : "",
  }));

  const couponRows = coupons.map((coupon) => ({
    "Промокод": coupon.id,
    "tg_user_id": coupon.tg_user_id,
    "Тип": coupon.kind,
    "Значение": coupon.value,
    "Мин. сумма": coupon.min_order_sum,
    "Макс. скидка": coupon.max_discount ?? "",
    "Источник": coupon.source,
    "referral_id": coupon.referral_id ?? "",
    "Использован": coupon.is_used ? "да" : "нет",
    "ID заказа": coupon.used_order_id ?? "",
    "Создан": formatReportDate(coupon.created_at),
    "Использован в дату": coupon.used_at ? formatReportDate(coupon.used_at) : "",
  }));

  const createdPromoCodeRows = promoCodes.map((promoCode) => ({
    "Промокод": promoCode.code,
    "Скидка": Math.max(0, Math.trunc(toNumber(promoCode.discount_amount, "promo_codes.discount_amount"))),
    "Начало": formatReportDate(promoCode.starts_at),
    "Окончание": formatReportDate(promoCode.ends_at),
    "Лимит использований": promoCode.max_uses,
    "Использовано": promoCode.used_count,
    "Осталось": Math.max(0, promoCode.max_uses - promoCode.used_count),
    "Категория": promoCode.category_slug ? categoryReportLabel(promoCode.category_slug) : "Все товары",
    "После первой покупки": promoCode.requires_previous_order ? "да" : "нет",
    "Активен": promoCode.is_active ? "да" : "нет",
    "Создан": formatReportDate(promoCode.created_at),
  }));

  const workbook = XLSX.utils.book_new();
  appendJsonSheet(workbook, "Заказы", orderRows);
  appendJsonSheet(workbook, "Позиции", itemRows);
  appendJsonSheet(workbook, "Города", cityRows);
  appendJsonSheet(workbook, "Товары", productRows);
  appendJsonSheet(workbook, "Клиенты", customerRows);
  appendJsonSheet(workbook, "Адреса", addressRows);
  appendJsonSheet(workbook, "Рефералка", referralRows);
  appendJsonSheet(workbook, "Промокоды", couponRows);
  appendJsonSheet(workbook, "Промокоды админ", createdPromoCodeRows);

  const plainBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
  const buffer =
    options.encrypt === false
      ? plainBuffer
      : await encryptWorkbookBuffer(plainBuffer, ADMIN_REPORT_PASSWORD);
  return {
    buffer,
    filename: `business-report-vvo-blg-done-orders-${reportFileDate()}.xlsx`,
  };
}

function getPromotionBrandLabelScore(value: string): number {
  let score = 0;
  for (const char of value) {
    if (/\p{Lu}/u.test(char)) score += 1;
  }
  if (/^[\p{Lu}\d-]+$/u.test(value)) score += 3;
  return score;
}

function isPromotionRulesProductIdsColumnError(error: {
  code?: string;
  message?: string;
  details?: string | null;
} | null): boolean {
  if (!error) return false;
  const text = `${error.code ?? ""} ${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  return (
    text.includes("product_ids") &&
    (text.includes("schema cache") || text.includes("column") || text.includes("promotion_rules"))
  );
}

function isPromotionRulesSchemaOutdatedError(error: {
  code?: string;
  message?: string;
  details?: string | null;
} | null): boolean {
  if (!error) return false;
  const text = `${error.code ?? ""} ${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  return text.includes("promotion_rules_type_check") || isPromotionRulesProductIdsColumnError(error);
}

function errorToResponse(e: unknown): { statusCode: number; body: ApiFailure } {
  if (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE"
  ) {
    return {
      statusCode: 400,
      body: fail("BAD_REQUEST", "File too large (max 5MB)"),
    };
  }

  if (isHttpError(e)) {
    return { statusCode: e.statusCode, body: fail(e.code, e.message) };
  }
  const message = e instanceof Error ? e.message : "Unexpected error";
  return { statusCode: 500, body: fail("INTERNAL", message) };
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const itemsDir = path.resolve(process.cwd(), "static", "items");

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/me",
    async (request, reply) => {
      try {
        const me = await requireAdmin(request);
        return reply.code(200).send(ok(me));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/cities",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("cities")
          .select("id,name,slug")
          .order("slug", { ascending: true });

        if (error) {
          throw new HttpError(500, "DB", `Failed to load cities: ${error.message}`);
        }

        return reply.code(200).send(ok(data ?? []));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/change-versions",
    async (request, reply) => {
      try {
        const admin = await requireAdmin(request);
        requireAdminHistoryOwner(admin.tgUserId);
        const parsed = z
          .object({
            kind: z.enum(["products", "images"]),
            citySlug: z.string().trim().min(1).max(50).optional(),
          })
          .safeParse(request.query);
        if (!parsed.success) throw new HttpError(400, "BAD_REQUEST", "Invalid history query");
        const items = await listAdminChangeVersions({
          kind: parsed.data.kind,
          citySlug: parsed.data.citySlug ?? null,
        });
        return reply.code(200).send(ok({ items }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/change-versions/:id/restore",
    async (request, reply) => {
      try {
        const admin = await requireAdmin(request);
        requireAdminHistoryOwner(admin.tgUserId);
        const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
        if (!parsed.success) throw new HttpError(400, "BAD_REQUEST", "Invalid restore point id");
        const result = await restoreAdminChangeVersion({
          id: parsed.data.id,
          tgUserId: admin.tgUserId,
          itemsDir,
        });
        return reply.code(200).send(ok(result));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/staff",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        return reply.code(200).send(ok(await listStaffMembers()));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/staff",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const parsed = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("staff_members")
          .insert({ name: parsed.data.name })
          .select("id,name,is_active")
          .single();
        if (error) throw new HttpError(500, "DB", `Failed to add staff member: ${error.message}`);

        return reply.code(201).send(ok({ id: data.id, name: data.name, isActive: data.is_active }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.put<{ Params: unknown; Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/staff/:id",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
        const body = z
          .object({
            name: z.string().trim().min(1).max(60).optional(),
            isActive: z.boolean().optional(),
          })
          .refine((value) => value.name !== undefined || value.isActive !== undefined, "No changes provided")
          .safeParse(request.body);
        if (!params.success || !body.success) {
          throw new HttpError(
            400,
            "BAD_REQUEST",
            params.error?.issues[0]?.message ?? body.error?.issues[0]?.message ?? "Invalid request",
          );
        }

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("staff_members")
          .update({
            ...(body.data.name === undefined ? {} : { name: body.data.name }),
            ...(body.data.isActive === undefined ? {} : { is_active: body.data.isActive }),
          })
          .eq("id", params.data.id)
          .select("id,name,is_active")
          .maybeSingle();
        if (error) throw new HttpError(500, "DB", `Failed to update staff member: ${error.message}`);
        if (!data) throw new HttpError(404, "NOT_FOUND", "Staff member not found");

        return reply.code(200).send(ok({ id: data.id, name: data.name, isActive: data.is_active }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Querystring: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/staff-inventory",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const parsed = z.object({ citySlug: z.string().trim().min(1).max(50) }).safeParse(request.query);
        if (!parsed.success) throw new HttpError(400, "BAD_REQUEST", "Invalid query");

        const supabase = createServiceSupabaseClient();
        const { data: city, error: cityError } = await supabase
          .from("cities")
          .select("id,name,slug")
          .eq("slug", parsed.data.citySlug)
          .maybeSingle();
        if (cityError) throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
        if (!city) throw new HttpError(404, "CITY_NOT_FOUND", "City not found");

        const [{ data: cityInventory, error: cityInventoryError }, { data: allocations, error: allocationsError }] =
          await Promise.all([
            supabase
              .from("inventory")
              .select("product_id,stock_qty")
              .eq("city_id", city.id)
              .order("product_id", { ascending: true }),
            supabase
              .from("staff_inventory")
              .select("staff_id,product_id,stock_qty")
              .eq("city_id", city.id),
          ]);
        if (cityInventoryError) {
          throw new HttpError(500, "DB", `Failed to load city inventory: ${cityInventoryError.message}`);
        }
        if (allocationsError) {
          throw new HttpError(500, "DB", `Failed to load staff inventory: ${allocationsError.message}`);
        }

        const productIds = (cityInventory ?? []).map((row) => row.product_id);
        const { data: products, error: productsError } =
          productIds.length === 0
            ? { data: [], error: null }
            : await supabase
                .from("products")
                .select("id,title,is_active")
                .in("id", productIds)
                .order("title", { ascending: true });
        if (productsError) throw new HttpError(500, "DB", `Failed to load products: ${productsError.message}`);

        const cityQtyByProductId = new Map((cityInventory ?? []).map((row) => [row.product_id, row.stock_qty]));
        const allocationsByProductId = new Map<string, Array<{ staffId: number; stockQty: number }>>();
        for (const allocation of allocations ?? []) {
          const rows = allocationsByProductId.get(allocation.product_id) ?? [];
          rows.push({ staffId: allocation.staff_id, stockQty: allocation.stock_qty });
          allocationsByProductId.set(allocation.product_id, rows);
        }

        return reply.code(200).send(
          ok({
            city,
            staff: await listStaffMembers(),
            products: (products ?? []).map((product) => ({
              id: product.id,
              title: product.title,
              isActive: product.is_active,
              cityStockQty: cityQtyByProductId.get(product.id) ?? null,
              allocations: allocationsByProductId.get(product.id) ?? [],
            })),
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.put<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/staff-inventory",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const parsed = z
          .object({
            citySlug: z.string().trim().min(1).max(50),
            staffId: z.number().int().positive(),
            productId: z.string().uuid(),
            stockQty: z.number().int().nonnegative(),
          })
          .safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const [{ data: city, error: cityError }, { data: staff, error: staffError }] = await Promise.all([
          supabase.from("cities").select("id,slug").eq("slug", parsed.data.citySlug).maybeSingle(),
          supabase.from("staff_members").select("id").eq("id", parsed.data.staffId).maybeSingle(),
        ]);
        if (cityError) throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
        if (staffError) throw new HttpError(500, "DB", `Failed to load staff member: ${staffError.message}`);
        if (!city) throw new HttpError(404, "CITY_NOT_FOUND", "City not found");
        if (!staff) throw new HttpError(404, "NOT_FOUND", "Staff member not found");

        const [{ data: cityInventory, error: cityInventoryError }, { data: allocations, error: allocationsError }] =
          await Promise.all([
            supabase
              .from("inventory")
              .select("stock_qty")
              .eq("city_id", city.id)
              .eq("product_id", parsed.data.productId)
              .maybeSingle(),
            supabase
              .from("staff_inventory")
              .select("staff_id,stock_qty")
              .eq("city_id", city.id)
              .eq("product_id", parsed.data.productId),
          ]);
        if (cityInventoryError) {
          throw new HttpError(500, "DB", `Failed to load city stock: ${cityInventoryError.message}`);
        }
        if (allocationsError) {
          throw new HttpError(500, "DB", `Failed to load staff allocations: ${allocationsError.message}`);
        }
        if (!cityInventory) throw new HttpError(404, "INVENTORY_MISSING", "City inventory row is missing");

        if (cityInventory.stock_qty !== null) {
          const otherStaffQty = (allocations ?? [])
            .filter((row) => row.staff_id !== parsed.data.staffId)
            .reduce((sum, row) => sum + row.stock_qty, 0);
          if (otherStaffQty + parsed.data.stockQty > cityInventory.stock_qty) {
            throw new HttpError(400, "STAFF_STOCK_EXCEEDS_CITY", "Staff stock cannot exceed city stock");
          }
        }

        const { error: upsertError } = await supabase.from("staff_inventory").upsert(
          {
            city_id: city.id,
            staff_id: parsed.data.staffId,
            product_id: parsed.data.productId,
            stock_qty: parsed.data.stockQty,
          },
          { onConflict: "staff_id,city_id,product_id" },
        );
        if (upsertError) {
          throw new HttpError(500, "DB", `Failed to update staff stock: ${upsertError.message}`);
        }

        return reply.code(200).send(ok(parsed.data));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/inventory-operations",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const parsed = z
          .object({
            kind: z.enum(["defect", "replacement"]),
            citySlug: z.string().trim().min(1).max(50),
            staffId: z.number().int().positive(),
            productId: z.string().uuid(),
            qty: z.number().int().positive(),
            returnedProductId: z.string().uuid().nullable().optional(),
            note: z.string().trim().max(300).nullable().optional(),
          })
          .superRefine((value, ctx) => {
            if (value.kind === "replacement" && !value.returnedProductId) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Returned defective product is required" });
            }
          })
          .safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const { data: city, error: cityError } = await supabase
          .from("cities")
          .select("id,slug")
          .eq("slug", parsed.data.citySlug)
          .maybeSingle();
        if (cityError) throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
        if (!city) throw new HttpError(404, "CITY_NOT_FOUND", "City not found");

        await applyStaffInventoryOperation({
          kind: parsed.data.kind,
          cityId: city.id,
          staffId: parsed.data.staffId,
          productId: parsed.data.productId,
          qty: parsed.data.qty,
          ...(parsed.data.returnedProductId === undefined
            ? {}
            : { returnedProductId: parsed.data.returnedProductId }),
          ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
        });

        return reply.code(201).send(ok(parsed.data));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Querystring: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/promotion-brands",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const querySchema = z.object({
          citySlug: z.string().trim().min(1).max(60),
          categorySlug: z.string().trim().min(1).max(50).optional(),
        });
        const parsedQuery = querySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          throw new HttpError(
            400,
            "BAD_REQUEST",
            parsedQuery.error.issues[0]?.message ?? "Invalid query",
          );
        }

        const supabase = createServiceSupabaseClient();
        const { data: city, error: cityError } = await supabase
          .from("cities")
          .select("id")
          .eq("slug", parsedQuery.data.citySlug)
          .maybeSingle();

        if (cityError) {
          throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
        }
        if (!city) {
          throw new HttpError(400, "CITY_NOT_FOUND", "City not found");
        }

        const categorySlug = parsedQuery.data.categorySlug
          ? normalizePromotionCategorySlug(parsedQuery.data.categorySlug)
          : null;
        let inventoryQuery = supabase
          .from("inventory")
          .select("products!inner(title,category_slug,is_active)")
          .eq("city_id", city.id)
          .eq("in_stock", true)
          .eq("products.is_active", true);

        if (categorySlug) {
          inventoryQuery = inventoryQuery.eq("products.category_slug", categorySlug);
        }

        const { data, error } = await inventoryQuery;
        if (error) {
          throw new HttpError(500, "DB", `Failed to load promotion brands: ${error.message}`);
        }

        const brands = new Map<string, { brand: string; count: number; score: number }>();
        for (const row of (data ?? []) as Array<{ products?: unknown }>) {
          const product = getJoinedProduct(row);
          const title = typeof product?.title === "string" ? product.title : "";
          const brand = extractPromotionBrandLabel(title).trim();
          const key = normalizePromotionBrandKey(brand);
          if (!key) continue;

          const score = getPromotionBrandLabelScore(brand);
          const existing = brands.get(key);
          if (existing) {
            existing.count += 1;
            if (score > existing.score) {
              existing.brand = brand;
              existing.score = score;
            }
          } else {
            brands.set(key, { brand, count: 1, score });
          }
        }

        return reply.code(200).send(
          ok({
            items: [...brands.values()]
              .map(({ brand, count }) => ({ brand, count }))
              .sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand, "ru")),
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/promotions",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const supabase = createServiceSupabaseClient();
        const now = new Date();
        const nowIso = now.toISOString();
        const nowMs = now.getTime();
        const citiesPromise = supabase.from("cities").select("id,name,slug");
        const rulesResponse = await supabase
          .from("promotion_rules")
          .select(PROMOTION_RULE_ADMIN_SELECT_WITH_PRODUCT_IDS)
          .eq("is_active", true)
          .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
          .order("created_at", { ascending: false })
          .limit(50);
        let data = rulesResponse.data as PromotionRuleAdminRow[] | null;
        let error = rulesResponse.error;

        if (error && isPromotionRulesProductIdsColumnError(error)) {
          const fallback = await supabase
            .from("promotion_rules")
            .select(PROMOTION_RULE_ADMIN_SELECT_WITHOUT_PRODUCT_IDS)
            .eq("is_active", true)
            .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
            .order("created_at", { ascending: false })
            .limit(50);
          data = fallback.data as PromotionRuleAdminRow[] | null;
          error = fallback.error;
        }

        const { data: cities, error: citiesError } = await citiesPromise;

        if (error) {
          throw new HttpError(500, "DB", `Failed to load promotion rules: ${error.message}`);
        }
        if (citiesError) {
          throw new HttpError(500, "DB", `Failed to load cities: ${citiesError.message}`);
        }

        const cityById = new Map((cities ?? []).map((city) => [city.id, { name: city.name, slug: city.slug }]));
        return reply
          .code(200)
          .send(ok({ items: (data ?? []).map((row) => mapPromotionRuleForAdmin(row, cityById, nowMs)) }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/promotions",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const schema = z.object({
          type: z.enum([
            PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE,
            PROMOTION_TYPE_BUY_POD_GET_LIQUID_CHEAPEST_FREE,
          ]),
          citySlug: z.enum(["vvo", "blg"]),
          categorySlug: z.string().trim().min(1).max(50),
          brand: z.string().trim().max(1000).nullable().optional(),
          brands: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
          productIds: z.array(z.string().uuid()).max(500).optional(),
          startsAt: z.string().trim().max(80).nullable().optional(),
          endsAt: z.string().trim().max(80).nullable().optional(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const type = parsed.data.type;
        const categorySlug =
          type === PROMOTION_TYPE_BUY_POD_GET_LIQUID_CHEAPEST_FREE
            ? "pod"
            : normalizePromotionCategorySlug(parsed.data.categorySlug);
        const startsAt = parseOptionalIsoDateTime(parsed.data.startsAt, "startsAt");
        const endsAt = parseOptionalIsoDateTime(parsed.data.endsAt, "endsAt");
        if (startsAt && endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
          throw new HttpError(400, "BAD_REQUEST", "endsAt must be after startsAt");
        }
        if (endsAt && new Date(endsAt).getTime() < Date.now()) {
          throw new HttpError(400, "BAD_REQUEST", "endsAt must be in the future");
        }

        const selectedBrands = [
          ...new Set((parsed.data.brands ?? []).map((brand) => brand.trim()).filter(Boolean)),
        ];
        const brand =
          selectedBrands.length > 0
            ? selectedBrands.join(", ")
            : typeof parsed.data.brand === "string" && parsed.data.brand.trim().length > 0
              ? parsed.data.brand.trim()
              : null;
        const requestedProductIds =
          type === PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE
            ? normalizePromotionProductIds(parsed.data.productIds)
            : [];
        if (requestedProductIds.length > 0 && selectedBrands.length === 0) {
          throw new HttpError(400, "BAD_REQUEST", "productIds require selected brands");
        }

        const supabase = createServiceSupabaseClient();
        const { data: city, error: cityError } = await supabase
          .from("cities")
          .select("id,name,slug")
          .eq("slug", parsed.data.citySlug)
          .maybeSingle();

        if (cityError) {
          throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
        }
        if (!city) {
          throw new HttpError(400, "CITY_NOT_FOUND", "City not found");
        }

        const productIds =
          requestedProductIds.length > 0
            ? await validatePromotionProductIds({
                supabase,
                cityId: city.id,
                categorySlug,
                brand,
                productIds: requestedProductIds,
              })
            : [];

        const insertPayload = {
          city_id: city.id,
          type,
          title: getPromotionTypePublicTitle(type),
          category_slug: categorySlug,
          brand,
          starts_at: startsAt,
          ends_at: endsAt,
          is_active: true,
          ...(productIds.length > 0 ? { product_ids: productIds } : {}),
        };

        const createdResponse =
          productIds.length > 0
            ? await supabase
                .from("promotion_rules")
                .insert(insertPayload)
                .select(PROMOTION_RULE_ADMIN_SELECT_WITH_PRODUCT_IDS)
                .single()
            : await supabase
                .from("promotion_rules")
                .insert(insertPayload)
                .select(PROMOTION_RULE_ADMIN_SELECT_WITHOUT_PRODUCT_IDS)
                .single();
        const data = createdResponse.data as PromotionRuleAdminRow | null;
        const error = createdResponse.error;

        if (error) {
          if (isPromotionRulesSchemaOutdatedError(error)) {
            throw new HttpError(
              500,
              "DB_SCHEMA_OUTDATED",
              "Promotion rules schema is outdated. Run supabase/alter_promotion_rules.sql in Supabase SQL Editor.",
            );
          }
          throw new HttpError(500, "DB", `Failed to create promotion rule: ${error.message}`);
        }
        if (!data) {
          throw new HttpError(500, "DB", "Failed to create promotion rule (empty response)");
        }

        return reply
          .code(200)
          .send(ok(mapPromotionRuleForAdmin(data, new Map([[city.id, { name: city.name, slug: city.slug }]]))));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/promo-codes",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const supabase = createServiceSupabaseClient();
        const nowIso = new Date().toISOString();
        const { data, error } = await supabase
          .from("promo_codes")
          .select(
            PROMO_CODE_ADMIN_SELECT,
          )
          .gte("ends_at", nowIso)
          .order("created_at", { ascending: false })
          .limit(100);

        if (error) {
          if (isPromoCodesSchemaOutdatedError(error)) {
            throw new HttpError(
              500,
              "DB_SCHEMA_OUTDATED",
              "Promo codes schema is outdated. Run supabase/alter_promo_codes.sql in Supabase SQL Editor.",
            );
          }
          throw new HttpError(500, "DB", `Failed to load promo codes: ${error.message}`);
        }

        return reply
          .code(200)
          .send(ok({ items: ((data ?? []) as PromoCodeAdminRow[]).map(mapPromoCodeForAdmin) }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/promo-codes",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const schema = z.object({
          code: z.string().trim().min(1).max(64),
          discountAmount: z.coerce.number().int().min(1).max(1_000_000),
          startsAt: z.string().trim().min(1).max(80),
          endsAt: z.string().trim().min(1).max(80),
          maxUses: z.coerce.number().int().min(1).max(100_000),
          requiresPreviousOrder: z.boolean().optional().default(false),
          categorySlug: z.string().trim().max(80).nullable().optional(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const code = normalizePromoCode(parsed.data.code);
        if (!code || !/^[A-Z0-9_-]+$/.test(code)) {
          throw new HttpError(
            400,
            "BAD_REQUEST",
            "Promo code may contain only latin letters, numbers, underscores and hyphens.",
          );
        }

        const startsAt = parsePromoCodeDate(parsed.data.startsAt, "startsAt", false);
        const endsAt = parsePromoCodeDate(parsed.data.endsAt, "endsAt", true);
        if (new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
          throw new HttpError(400, "BAD_REQUEST", "endsAt must be after startsAt");
        }
        const categorySlug =
          typeof parsed.data.categorySlug === "string" &&
          parsed.data.categorySlug.trim().length > 0
            ? normalizePromotionCategorySlug(parsed.data.categorySlug)
            : null;

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("promo_codes")
          .insert({
            code,
            discount_amount: parsed.data.discountAmount,
            starts_at: startsAt,
            ends_at: endsAt,
            max_uses: parsed.data.maxUses,
            used_count: 0,
            is_active: true,
            requires_previous_order: parsed.data.requiresPreviousOrder,
            category_slug: categorySlug,
            updated_at: new Date().toISOString(),
          })
          .select(
            PROMO_CODE_ADMIN_SELECT,
          )
          .single();

        if (error) {
          const codeText = typeof error.code === "string" ? error.code : "";
          if (codeText === "23505") {
            throw new HttpError(409, "PROMO_CODE_EXISTS", "Promo code already exists.");
          }
          if (isPromoCodesSchemaOutdatedError(error)) {
            throw new HttpError(
              500,
              "DB_SCHEMA_OUTDATED",
              "Promo codes schema is outdated. Run supabase/alter_promo_codes.sql in Supabase SQL Editor.",
            );
          }
          throw new HttpError(500, "DB", `Failed to create promo code: ${error.message}`);
        }
        if (!data) {
          throw new HttpError(500, "DB", "Failed to create promo code (empty response)");
        }

        return reply.code(200).send(ok(mapPromoCodeForAdmin(data as PromoCodeAdminRow)));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const querySchema = z.object({
          tab: z.enum(["active", "archive"]).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        });
        const parsedQuery = querySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid query");
        }

        const tab = parsedQuery.data.tab ?? "active";
        const limit = parsedQuery.data.limit ?? 120;
        const isActive = tab === "active";
        const supabase = createServiceSupabaseClient();

        const [
          { data: cities, error: citiesError },
          { data: products, error: productsError },
          { count: activeCountRaw, error: activeCountError },
          { count: archiveCountRaw, error: archiveCountError },
        ] =
          await Promise.all([
            supabase.from("cities").select("id,slug").order("slug", { ascending: true }),
            supabase
              .from("products")
              .select("id,title,description,base_price,image_url,is_active,created_at")
              .eq("is_active", isActive)
              .order("created_at", { ascending: false })
              .limit(limit),
            supabase
              .from("products")
              .select("id", { count: "exact", head: true })
              .eq("is_active", true),
            supabase
              .from("products")
              .select("id", { count: "exact", head: true })
              .eq("is_active", false),
          ]);

        if (citiesError) {
          throw new HttpError(500, "DB", `Failed to load cities: ${citiesError.message}`);
        }
        if (productsError) {
          throw new HttpError(
            500,
            "DB",
            `Failed to load products: ${productsError.message}`,
          );
        }
        if (activeCountError) {
          throw new HttpError(500, "DB", `Failed to count active products: ${activeCountError.message}`);
        }
        if (archiveCountError) {
          throw new HttpError(
            500,
            "DB",
            `Failed to count archive products: ${archiveCountError.message}`,
          );
        }

        const cityList = (cities ?? []).map((c) => ({ id: c.id, slug: c.slug }));
        const productList = products ?? [];
        const productIds = productList.map((p) => p.id);

        const { data: inventory, error: inventoryError } =
          productIds.length > 0
            ? await supabase
                .from("inventory")
                .select("product_id,city_id,in_stock,stock_qty,price_override")
                .in("product_id", productIds)
            : { data: [], error: null };

        if (inventoryError) {
          throw new HttpError(
            500,
            "DB",
            `Failed to load inventory: ${inventoryError.message}`,
          );
        }

        type InventoryRow = {
          product_id: string;
          city_id: number;
          in_stock: boolean;
          stock_qty: number | null;
          price_override: unknown;
        };
        const invList = (inventory ?? []) as unknown as InventoryRow[];
        const invByKey = new Map<string, InventoryRow>();
        for (const row of invList) {
          invByKey.set(`${row.product_id}:${row.city_id}`, row);
        }

        const result = productList.map((p) => {
          const basePrice = toNumber(p.base_price, "products.base_price");

          return {
            id: p.id,
            title: p.title,
            description: p.description,
            base_price: basePrice,
            image_url: p.image_url,
            is_active: p.is_active,
            inventory: cityList.map((c) => {
              const inv = invByKey.get(`${p.id}:${c.id}`);
              return {
                city_id: c.id,
                city_slug: c.slug,
                in_stock: inv?.in_stock ?? false,
                stock_qty: inv?.stock_qty ?? null,
                price_override:
                  inv?.price_override === null || inv?.price_override === undefined
                    ? null
                    : toNumber(inv.price_override, "inventory.price_override"),
              };
            }),
          };
        });

        const activeCount = toCount(activeCountRaw);
        const archiveCount = toCount(archiveCountRaw);

        return reply.code(200).send(
          ok({
            tab,
            limit,
            total: tab === "active" ? activeCount : archiveCount,
            activeCount,
            archiveCount,
            items: result,
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const schema = z.object({
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(10_000).nullable().optional(),
          basePrice: z.number().finite().nonnegative(),
          isActive: z.boolean().optional(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("products")
          .insert({
            title: parsed.data.title,
            description: parsed.data.description ?? null,
            base_price: parsed.data.basePrice,
            is_active: parsed.data.isActive ?? true,
          })
          .select("id,title,description,base_price,image_url,is_active,created_at")
          .single();

        if (error) {
          throw new HttpError(500, "DB", `Failed to create product: ${error.message}`);
        }
        if (!data) {
          throw new HttpError(500, "DB", "Failed to create product (empty response)");
        }

        return reply.code(200).send(
          ok({
            id: data.id,
            title: data.title,
            description: data.description,
            base_price: toNumber(data.base_price, "products.base_price"),
            image_url: data.image_url,
            is_active: data.is_active,
            created_at: data.created_at,
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.put<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products/:id",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const productId = getParamId(request);

        const schema = z.object({
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(10_000).nullable(),
          basePrice: z.number().finite().nonnegative(),
          isActive: z.boolean(),
          imageUrl: z.string().trim().url().nullable().optional(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const update: Record<string, unknown> = {
          title: parsed.data.title,
          description: parsed.data.description,
          base_price: parsed.data.basePrice,
          is_active: parsed.data.isActive,
        };
        if (Object.prototype.hasOwnProperty.call(parsed.data, "imageUrl")) {
          update.image_url = parsed.data.imageUrl ?? null;
        }

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("products")
          .update(update)
          .eq("id", productId)
          .select("id,title,description,base_price,image_url,is_active,created_at")
          .single();

        if (error) {
          throw new HttpError(500, "DB", `Failed to update product: ${error.message}`);
        }
        if (!data) {
          throw new HttpError(404, "NOT_FOUND", "Product not found");
        }

        return reply.code(200).send(
          ok({
            id: data.id,
            title: data.title,
            description: data.description,
            base_price: toNumber(data.base_price, "products.base_price"),
            image_url: data.image_url,
            is_active: data.is_active,
            created_at: data.created_at,
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products/:id/image",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const productId = getParamId(request);

        const file = await request.file();
        if (!file) {
          throw new HttpError(400, "BAD_REQUEST", "file is required");
        }

        const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
        const inferredMime = inferMimeType(file.filename ?? "");
        const mimeType =
          typeof file.mimetype === "string" && file.mimetype.trim().length > 0
            ? file.mimetype.trim().toLowerCase()
            : inferredMime;
        if (!mimeType || !allowedTypes.has(mimeType)) {
          throw new HttpError(400, "BAD_REQUEST", "Only jpeg/png/webp allowed");
        }

        const buffer = await file.toBuffer();
        const maxSize = 5 * 1024 * 1024;
        if (buffer.byteLength > maxSize) {
          throw new HttpError(400, "BAD_REQUEST", "File too large (max 5MB)");
        }

        const supabase = createServiceSupabaseClient();

        const { data: existing, error: existingError } = await supabase
          .from("products")
          .select("id")
          .eq("id", productId)
          .maybeSingle();

        if (existingError) {
          throw new HttpError(500, "DB", `Failed to load product: ${existingError.message}`);
        }
        if (!existing) {
          throw new HttpError(404, "NOT_FOUND", "Product not found");
        }

        const safeName = sanitizeFileName(file.filename);
        const objectPath = `${productId}/${Date.now()}_${safeName}`;

        const { error: uploadError } = await supabase.storage
          .from("product-images")
          .upload(objectPath, buffer, {
            contentType: mimeType,
            cacheControl: VERSIONED_IMAGE_CACHE_CONTROL_SECONDS,
            upsert: false,
          });

        if (uploadError) {
          throw new HttpError(500, "STORAGE", `Upload failed: ${uploadError.message}`);
        }

        const { data: publicData } = supabase.storage
          .from("product-images")
          .getPublicUrl(objectPath);

        const imageUrl = publicData.publicUrl;

        const { data: updated, error: updateError } = await supabase
          .from("products")
          .update({ image_url: imageUrl })
          .eq("id", productId)
          .select("id")
          .single();

        if (updateError) {
          throw new HttpError(500, "DB", `Failed to set image_url: ${updateError.message}`);
        }
        if (!updated) {
          throw new HttpError(404, "NOT_FOUND", "Product not found");
        }

        return reply.code(200).send(ok({ imageUrl }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.put<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/inventory",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const schema = z.object({
          productId: z.string().uuid(),
          citySlug: z.string().trim().min(1).max(50),
          inStock: z.boolean(),
          stockQty: z.number().int().nonnegative().nullable().optional(),
          priceOverride: z.number().finite().nonnegative().nullable().optional(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const { data: city, error: cityError } = await supabase
          .from("cities")
          .select("id,slug")
          .eq("slug", parsed.data.citySlug)
          .single();

        if (cityError) {
          throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
        }
        if (!city) {
          throw new HttpError(400, "CITY_NOT_FOUND", "City not found");
        }

        const { error } = await supabase.from("inventory").upsert(
          {
            product_id: parsed.data.productId,
            city_id: city.id,
            in_stock: parsed.data.inStock,
            stock_qty: parsed.data.stockQty ?? null,
            price_override: parsed.data.priceOverride ?? null,
          },
          { onConflict: "product_id,city_id" },
        );

        if (error) {
          throw new HttpError(500, "DB", `Failed to upsert inventory: ${error.message}`);
        }

        return reply.code(200).send(
          ok({ productId: parsed.data.productId, citySlug: parsed.data.citySlug }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  const exportProductsXlsxHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      await requireAdmin(request);
      const parsedQuery = z
        .object({
          citySlug: z.string().trim().min(1).max(50).optional(),
        })
        .safeParse(request.query);
      if (!parsedQuery.success) {
        throw new HttpError(400, "BAD_REQUEST", "Invalid query");
      }

      const supabase = createServiceSupabaseClient();
      const [{ data: cities, error: citiesError }, { data: products, error: productsError }] =
        await Promise.all([
          supabase.from("cities").select("id,slug,name").order("slug", { ascending: true }),
          supabase
            .from("products")
            .select(
              "id,title,description,category_slug,base_price,image_url,is_active,created_at",
            )
            .order("title", { ascending: true }),
        ]);

      if (citiesError) {
        throw new HttpError(500, "DB", `Failed to load cities: ${citiesError.message}`);
      }
      if (productsError) {
        throw new HttpError(500, "DB", `Failed to load products: ${productsError.message}`);
      }

      const cityList = (cities ?? []).map((c) => ({ id: c.id, slug: c.slug, name: c.name }));
      const requestedCitySlug = parsedQuery.data.citySlug?.toLowerCase() ?? null;
      const selectedCity =
        requestedCitySlug === null
          ? null
          : cityList.find((city) => city.slug.toLowerCase() === requestedCitySlug) ?? null;
      if (requestedCitySlug !== null && selectedCity === null) {
        throw new HttpError(400, "BAD_REQUEST", "Unknown citySlug");
      }
      const exportCities = selectedCity ? [selectedCity] : cityList;
      const productList = products ?? [];
      const productIds = productList.map((p) => p.id);

      type ExportInventoryRow = {
        product_id: string;
        city_id: number;
        in_stock: boolean;
        stock_qty: number | null;
        price_override: number | null;
      };
      type ExportStaffInventoryRow = {
        staff_id: number;
        product_id: string;
        stock_qty: number;
      };
      const invRows: ExportInventoryRow[] = [];
      const soldOrderItems: Array<{ product_id: string | null }> = [];
      let staffInventoryRows: ExportStaffInventoryRow[] = [];
      let staffMembers: Array<{ id: number; name: string }> = [];

      await Promise.all(
        chunk(productIds, 100).map(async (part) => {
          const { data, error } = await supabase
            .from("inventory")
            .select("product_id,city_id,in_stock,stock_qty,price_override")
            .in("product_id", part);

          if (error) {
            throw new HttpError(500, "DB", `Failed to load inventory: ${error.message}`);
          }

          invRows.push(...((data ?? []) as unknown as ExportInventoryRow[]));
        }),
      );

      if (selectedCity) {
        const [, staffInventoryResult, staffMembersResult] = await Promise.all([
          Promise.all(chunk(productIds, 100).map(async (part) => {
            const { data, error } = await supabase
              .from("order_items")
              .select("product_id,orders!inner(city_id)")
              .in("product_id", part)
              .eq("orders.city_id", selectedCity.id);

            if (error) {
              throw new HttpError(
                500,
                "DB",
                `Failed to load order history for export: ${error.message}`,
              );
            }

            soldOrderItems.push(...((data ?? []) as Array<{ product_id: string | null }>));
          })),
          supabase
            .from("staff_inventory")
            .select("staff_id,product_id,stock_qty")
            .eq("city_id", selectedCity.id),
          supabase
            .from("staff_members")
            .select("id,name")
            .eq("is_active", true)
            .order("name", { ascending: true }),
        ]);

        if (staffInventoryResult.error) {
          throw new HttpError(500, "DB", `Failed to load staff inventory for export: ${staffInventoryResult.error.message}`);
        }
        if (staffMembersResult.error) {
          throw new HttpError(500, "DB", `Failed to load staff for export: ${staffMembersResult.error.message}`);
        }
        staffInventoryRows = (staffInventoryResult.data ?? []) as ExportStaffInventoryRow[];
        staffMembers = staffMembersResult.data ?? [];
      }

      const invByKey = new Map<string, ExportInventoryRow>();
      for (const row of invRows) {
        invByKey.set(`${row.product_id}:${row.city_id}`, row);
      }
      const soldProductIdsInSelectedCity = new Set<string>();
      for (const row of (soldOrderItems ?? []) as Array<{ product_id: string | null }>) {
        if (typeof row.product_id === "string") {
          soldProductIdsInSelectedCity.add(row.product_id);
        }
      }

      const filteredProductList =
        selectedCity === null
          ? productList
          : productList.filter((product) => {
              const cityInventory = invByKey.get(`${product.id}:${selectedCity.id}`);
              if (!cityInventory) return false;
              if (cityInventory.in_stock === true) return true;
              if (typeof cityInventory.stock_qty === "number" && cityInventory.stock_qty > 0) {
                return true;
              }
              return soldProductIdsInSelectedCity.has(product.id);
            });

      const headers = [
        "id",
        "title",
        "description",
        "category_slug",
        "base_price",
        "image_url",
        "is_active",
        ...(selectedCity
          ? ["in_stock", "stock_qty", "price_override"]
          : exportCities.flatMap((c) => [
              `${c.slug}_in_stock`,
              `${c.slug}_stock_qty`,
              `${c.slug}_price_override`,
            ])),
      ];

      const aoa: Array<Array<string | number | boolean>> = [headers];

      for (const product of filteredProductList) {
        const row: Array<string | number | boolean> = [
          product.id,
          product.title,
          product.description ?? "",
          product.category_slug ?? "other",
          toNumber(product.base_price, "products.base_price"),
          product.image_url ?? "",
          product.is_active === true,
        ];

        for (const city of exportCities) {
          const inv = invByKey.get(`${product.id}:${city.id}`);
          row.push(inv?.in_stock ?? false);
          row.push(inv?.stock_qty ?? "");
          row.push(inv?.price_override ?? "");
        }

        aoa.push(row);
      }

      const sheet = XLSX.utils.aoa_to_sheet(aoa);
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, selectedCity ? "Общий" : "products");

      if (selectedCity) {
        const staffQtyByKey = new Map<string, number>();
        for (const row of staffInventoryRows) {
          staffQtyByKey.set(`${row.staff_id}:${row.product_id}`, row.stock_qty);
        }

        const usedSheetNames = new Set(book.SheetNames);
        for (const staff of staffMembers) {
          const staffHeaders = [
            "id",
            "title",
            "description",
            "category_slug",
            "base_price",
            "image_url",
            "is_active",
            "staff_id",
            "staff_stock_qty",
          ];
          const staffAoa: Array<Array<string | number | boolean>> = [staffHeaders];
          for (const product of filteredProductList) {
            staffAoa.push([
              product.id,
              product.title,
              product.description ?? "",
              product.category_slug ?? "other",
              toNumber(product.base_price, "products.base_price"),
              product.image_url ?? "",
              product.is_active === true,
              staff.id,
              staffQtyByKey.get(`${staff.id}:${product.id}`) ?? 0,
            ]);
          }

          const baseName = `Сотрудник ${staff.name}`.slice(0, 31) || `Сотрудник ${staff.id}`;
          let sheetName = baseName;
          let suffix = 2;
          while (usedSheetNames.has(sheetName)) {
            sheetName = `${baseName.slice(0, Math.max(1, 31 - String(suffix).length - 1))} ${suffix}`;
            suffix += 1;
          }
          usedSheetNames.add(sheetName);
          XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(staffAoa), sheetName);
        }
      }
      const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
      const datePart = new Date().toISOString().slice(0, 10);
      const fileName = selectedCity
        ? `products.${selectedCity.slug}.latest.${datePart}.xlsx`
        : `products.latest.${datePart}.xlsx`;

      return reply
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header("Content-Disposition", `attachment; filename=\"${fileName}\"`)
        .header("Cache-Control", "no-store")
        .code(200)
        .send(buffer);
    } catch (e) {
      const { statusCode, body } = errorToResponse(e);
      return reply.code(statusCode).send(body);
    }
  };

  app.get<{ Reply: Buffer | ApiFailure }>(
    "/api/admin/export/products.xlsx",
    exportProductsXlsxHandler,
  );

  app.get<{ Reply: Buffer | ApiFailure }>(
    "/api/admin/export/products",
    exportProductsXlsxHandler,
  );

  const exportPromoProductsXlsxHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      await requireAdmin(request);
      const parsedQuery = z
        .object({
          citySlug: z.string().trim().min(1).max(50),
        })
        .safeParse(request.query);
      if (!parsedQuery.success) {
        throw new HttpError(400, "BAD_REQUEST", "citySlug is required");
      }

      const supabase = createServiceSupabaseClient();
      const { data: city, error: cityError } = await supabase
        .from("cities")
        .select("id,slug,name")
        .eq("slug", parsedQuery.data.citySlug)
        .maybeSingle();

      if (cityError) {
        throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
      }
      if (!city) {
        throw new HttpError(400, "BAD_REQUEST", "Unknown citySlug");
      }

      const { data: inventoryRows, error: inventoryError } = await supabase
        .from("inventory")
        .select("product_id,in_stock,stock_qty,price_override")
        .eq("city_id", city.id);

      if (inventoryError) {
        throw new HttpError(500, "DB", `Failed to load city inventory: ${inventoryError.message}`);
      }

      type CityInventoryRow = {
        product_id: string;
        in_stock: boolean;
        stock_qty: number | null;
        price_override: number | null;
      };
      type ExportProductRow = {
        id: string;
        title: string;
        category_slug: string;
        base_price: unknown;
        is_active: boolean;
      };
      type ExportPromoRow = {
        product_id: string;
        old_price: unknown;
        new_price: unknown;
        sort_order: number;
        is_active: boolean;
      };

      const cityInventoryRows = (inventoryRows ?? []) as CityInventoryRow[];
      const productIds = cityInventoryRows.map((row) => row.product_id);
      const [productsResponse, promosResponse] = await Promise.all([
        productIds.length > 0
          ? supabase
              .from("products")
              .select("id,title,category_slug,base_price,is_active")
              .in("id", productIds)
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from("promo_products")
          .select("product_id,old_price,new_price,sort_order,is_active")
          .eq("city_id", city.id),
      ]);

      if (productsResponse.error) {
        throw new HttpError(500, "DB", `Failed to load products: ${productsResponse.error.message}`);
      }
      if (promosResponse.error) {
        throw new HttpError(500, "DB", `Failed to load promo products: ${promosResponse.error.message}`);
      }

      const productById = new Map<string, ExportProductRow>();
      for (const product of (productsResponse.data ?? []) as ExportProductRow[]) {
        productById.set(product.id, product);
      }

      const promoByProductId = new Map<string, ExportPromoRow>();
      for (const promo of (promosResponse.data ?? []) as ExportPromoRow[]) {
        promoByProductId.set(promo.product_id, promo);
      }

      const headers = [
        "product_id",
        "title",
        "category_slug",
        "current_price",
        "in_stock",
        "stock_qty",
        "promo_old_price",
        "promo_new_price",
        "promo_active",
        "promo_sort_order",
      ];
      const aoa: Array<Array<string | number | boolean>> = [headers];

      const sortedInventory = [...cityInventoryRows].sort((left, right) => {
        const leftTitle = productById.get(left.product_id)?.title ?? "";
        const rightTitle = productById.get(right.product_id)?.title ?? "";
        return leftTitle.localeCompare(rightTitle, "ru") || left.product_id.localeCompare(right.product_id);
      });

      for (const inv of sortedInventory) {
        const product = productById.get(inv.product_id);
        if (!product || product.is_active !== true) continue;

        const currentPrice =
          inv.price_override === null || inv.price_override === undefined
            ? toNumber(product.base_price, "products.base_price")
            : toNumber(inv.price_override, "inventory.price_override");
        const promo = promoByProductId.get(inv.product_id);

        aoa.push([
          inv.product_id,
          product.title,
          product.category_slug ?? "other",
          currentPrice,
          inv.in_stock === true,
          inv.stock_qty ?? "",
          promo && promo.is_active ? toNumber(promo.old_price, "promo_products.old_price") : "",
          promo && promo.is_active ? toNumber(promo.new_price, "promo_products.new_price") : "",
          promo?.is_active === true,
          promo?.sort_order ?? "",
        ]);
      }

      const sheet = XLSX.utils.aoa_to_sheet(aoa);
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "promo_products");
      const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
      const datePart = new Date().toISOString().slice(0, 10);
      const fileName = `promo-products.${city.slug}.latest.${datePart}.xlsx`;

      return reply
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header("Content-Disposition", `attachment; filename=\"${fileName}\"`)
        .header("Cache-Control", "no-store")
        .code(200)
        .send(buffer);
    } catch (e) {
      const { statusCode, body } = errorToResponse(e);
      return reply.code(statusCode).send(body);
    }
  };

  app.get<{ Reply: Buffer | ApiFailure }>(
    "/api/admin/export/promos.xlsx",
    exportPromoProductsXlsxHandler,
  );

  app.get<{ Reply: Buffer | ApiFailure }>(
    "/api/admin/export/promos",
    exportPromoProductsXlsxHandler,
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/import/promos",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const querySchema = z.object({
          citySlug: z.string().trim().min(1).max(50),
          encoding: z
            .enum(["auto", "utf-8", "windows-1251", "ibm866", "koi8-r"])
            .optional(),
        });
        const parsedQuery = querySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          throw new HttpError(400, "BAD_REQUEST", "citySlug is required");
        }

        const file = await request.file();
        if (!file) {
          throw new HttpError(400, "BAD_REQUEST", "file is required");
        }

        const buffer = await file.toBuffer();
        const maxSize = 5 * 1024 * 1024;
        if (buffer.byteLength > maxSize) {
          throw new HttpError(400, "BAD_REQUEST", "File too large (max 5MB)");
        }

        const fileName = (file.filename ?? "").toLowerCase();
        const mimeType = (file.mimetype ?? "").toLowerCase();
        const isSpreadsheet =
          fileName.endsWith(".xlsx") ||
          fileName.endsWith(".xls") ||
          mimeType.includes("spreadsheetml") ||
          mimeType.includes("ms-excel");

        let csvText: string;
        let encoding: string;
        if (isSpreadsheet) {
          csvText = decodeSpreadsheetBuffer(buffer);
          encoding = "xlsx";
        } else {
          const encodingMode = parsedQuery.data.encoding ?? "auto";
          const decoded = decodeCsvBuffer({
            buffer,
            forcedEncoding: encodingMode === "auto" ? null : encodingMode,
          });
          csvText = decoded.text;
          encoding = decoded.encoding;
        }

        request.log.info({ encoding, fileName, mimeType }, "Decoded imported promo products file");
        const result = await importPromoProductsCsv({
          supabase: createServiceSupabaseClient(),
          csvText,
          citySlug: parsedQuery.data.citySlug,
        });

        return reply.code(200).send(ok({ ...result, decodedEncoding: encoding }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/import/products",
    async (request, reply) => {
      try {
        const admin = await requireAdmin(request);

        const querySchema = z.object({
          citySlug: z.string().trim().min(1).max(50).optional(),
          imageMode: z.enum(["filename"]).optional(),
          encoding: z
            .enum(["auto", "utf-8", "windows-1251", "ibm866", "koi8-r"])
            .optional(),
        });
        const parsedQuery = querySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid query");
        }

        const file = await request.file();
        if (!file) {
          throw new HttpError(400, "BAD_REQUEST", "file is required");
        }

        const buffer = await file.toBuffer();
        const maxSize = 5 * 1024 * 1024;
        if (buffer.byteLength > maxSize) {
          throw new HttpError(400, "BAD_REQUEST", "File too large (max 5MB)");
        }

        const fileName = (file.filename ?? "").toLowerCase();
        const mimeType = (file.mimetype ?? "").toLowerCase();
        const isSpreadsheet =
          fileName.endsWith(".xlsx") ||
          fileName.endsWith(".xls") ||
          mimeType.includes("spreadsheetml") ||
          mimeType.includes("ms-excel");

        let csvText: string;
        let encoding: string;
        if (isSpreadsheet) {
          csvText = decodeSpreadsheetBuffer(buffer);
          encoding = "xlsx";
        } else {
          const encodingMode = parsedQuery.data.encoding ?? "auto";
          const decoded = decodeCsvBuffer({
            buffer,
            forcedEncoding: encodingMode === "auto" ? null : encodingMode,
          });
          csvText = decoded.text;
          encoding = decoded.encoding;
        }
        request.log.info({ encoding, fileName, mimeType }, "Decoded imported products file");
        const supabase = createServiceSupabaseClient();
        const useImagePrefix = parsedQuery.data.imageMode === "filename";
        if (useImagePrefix && !config.productImagesBaseUrl) {
          throw new HttpError(
            400,
            "BAD_REQUEST",
            "PRODUCT_IMAGES_BASE_URL is not configured on server",
          );
        }

        const imageFileNames = new Set<string>();
        if (useImagePrefix) {
          const localFiles = await listLocalItemFiles(itemsDir);
          for (const file of localFiles) {
            imageFileNames.add(file.name);
          }

          const storageLocation = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);
          if (storageLocation) {
            const storageFiles = await listStorageItemFiles(storageLocation);
            for (const file of storageFiles) {
              imageFileNames.add(file.name);
            }
          }
        }

        const restorePoint = await createProductsRestorePoint({
          tgUserId: admin.tgUserId,
          citySlug: parsedQuery.data.citySlug ?? null,
          label: `Перед импортом таблицы ${file.filename || "products"}`,
        });

        const result = await importProductsCsv({
          supabase,
          csvText,
          citySlug: parsedQuery.data.citySlug ?? null,
          imageBaseUrl: useImagePrefix ? config.productImagesBaseUrl : null,
          imageItemsDir: useImagePrefix ? itemsDir : null,
          imageFileNames: useImagePrefix ? imageFileNames : null,
        });

        const selectedCity = parsedQuery.data.citySlug
          ? result.cities.find((city) => city.slug.toLowerCase() === parsedQuery.data.citySlug?.toLowerCase())
          : null;
        const staffInventoryRows =
          isSpreadsheet && selectedCity ? await syncStaffInventoryFromWorkbook({ buffer, cityId: selectedCity.id }) : 0;

        return reply.code(200).send(
          ok({ ...result, decodedEncoding: encoding, staffInventoryRows, restorePoint }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/upload/items",
    async (request, reply) => {
      try {
        const admin = await requireAdmin(request);

        const files = await request.files();
        const storageLocation = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);
        const supabase = storageLocation ? createServiceSupabaseClient() : null;

        if (!storageLocation) {
          await fs.mkdir(itemsDir, { recursive: true });
        }

        const saved: Array<{ originalName: string; fileName: string; size: number }> = [];
        const errors: Array<{ originalName: string; message: string }> = [];
        let received = 0;
        let restorePoint: Awaited<ReturnType<typeof createImagesRestorePoint>> | null = null;

        for await (const file of files) {
          received += 1;
          if (!restorePoint) {
            restorePoint = await createImagesRestorePoint({
              tgUserId: admin.tgUserId,
              itemsDir,
              label: "Перед загрузкой изображений",
            });
          }
          const originalName = file.filename || `file_${Date.now()}`;
          const safeName = sanitizeFileName(originalName) || `file_${Date.now()}`;
          const inferredMime = inferMimeType(safeName);
          const mimeType =
            typeof file.mimetype === "string" && file.mimetype.trim().length > 0
              ? file.mimetype.trim().toLowerCase()
              : inferredMime ?? "application/octet-stream";

          try {
            const buffer = await file.toBuffer();
            if (storageLocation && supabase) {
              const objectPath = joinStoragePath(storageLocation.prefix, safeName);
              const { error: uploadError } = await supabase.storage
                .from(storageLocation.bucket)
                .upload(objectPath, buffer, {
                  upsert: true,
                  contentType: mimeType,
                  cacheControl: DEFAULT_IMAGE_CACHE_CONTROL_SECONDS,
                });

              if (uploadError) {
                throw new HttpError(500, "STORAGE", `Failed to save file: ${uploadError.message}`);
              }
            } else {
              const target = path.join(itemsDir, safeName);
              await fs.writeFile(target, buffer);
            }

            saved.push({ originalName, fileName: safeName, size: buffer.byteLength });
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : "Failed to save file";
            errors.push({ originalName, message });
          }
        }

        if (received === 0) {
          throw new HttpError(400, "BAD_REQUEST", "file is required");
        }

        return reply.code(200).send(
          ok({
            saved,
            errors,
            baseUrl: config.productImagesBaseUrl ?? null,
            restorePoint,
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/upload/items",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const localFiles = await listLocalItemFiles(itemsDir);
        const storageLocation = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);

        if (!storageLocation) {
          return reply
            .code(200)
            .send(ok({ files: localFiles, baseUrl: config.productImagesBaseUrl ?? null }));
        }

        const storageFiles = await listStorageItemFiles(storageLocation);
        const mergedFiles = [...localFiles];
        const existingNames = new Set(localFiles.map((file) => file.name));

        for (const file of storageFiles) {
          if (existingNames.has(file.name)) continue;
          mergedFiles.push(file);
        }

        mergedFiles.sort((a, b) => a.name.localeCompare(b.name));
        return reply
          .code(200)
          .send(ok({ files: mergedFiles, baseUrl: config.productImagesBaseUrl ?? null }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.delete<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/upload/items/:name",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const params = request.params as unknown;
        const parsed = z.object({ name: z.string().min(1) }).safeParse(params);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid filename");
        }

        const rawName = parsed.data.name;
        const safeName = sanitizeFileName(rawName);
        if (!safeName || safeName !== rawName) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid filename");
        }

        const target = path.join(itemsDir, safeName);
        const storageLocation = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);
        let deletedLocal = false;
        let deletedStorage = false;

        try {
          await fs.rm(target);
          deletedLocal = true;
        } catch (e) {
          const isLocalMissing =
            e &&
            typeof e === "object" &&
            "code" in e &&
            (e as { code?: unknown }).code === "ENOENT";
          if (!isLocalMissing) {
            throw e;
          }
        }

        if (storageLocation) {
          const objectPath = joinStoragePath(storageLocation.prefix, safeName);
          const supabase = createServiceSupabaseClient();
          const { error: removeError } = await supabase.storage
            .from(storageLocation.bucket)
            .remove([objectPath]);

          if (removeError && !isStorageNotFoundError(removeError)) {
            throw new HttpError(500, "STORAGE", `Failed to delete file: ${removeError.message}`);
          }
          if (!removeError) {
            deletedStorage = true;
          }
        }

        if (!deletedLocal && !deletedStorage) {
          const body = fail("NOT_FOUND", "File not found");
          return reply.code(404).send(body);
        }

        return reply.code(200).send(ok({ deleted: safeName }));
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "ENOENT") {
          const body = fail("NOT_FOUND", "File not found");
          return reply.code(404).send(body);
        }
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/upload/items/rename",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const schema = z.object({
          from: z.string().min(1),
          to: z.string().min(1),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid body");
        }

        const fromSafe = sanitizeFileName(parsed.data.from);
        const toSafe = sanitizeFileName(parsed.data.to);
        if (!fromSafe || !toSafe || fromSafe !== parsed.data.from || toSafe !== parsed.data.to) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid filename");
        }
        if (fromSafe === ".gitkeep" || toSafe === ".gitkeep") {
          throw new HttpError(400, "BAD_REQUEST", "Invalid filename");
        }

        const fromPath = path.join(itemsDir, fromSafe);
        const toPath = path.join(itemsDir, toSafe);
        try {
          await fs.rename(fromPath, toPath);
          return reply.code(200).send(ok({ from: fromSafe, to: toSafe }));
        } catch (e) {
          const isLocalMissing =
            e &&
            typeof e === "object" &&
            "code" in e &&
            (e as { code?: unknown }).code === "ENOENT";
          if (!isLocalMissing) {
            throw e;
          }

          const storageLocation = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);
          if (!storageLocation) {
            const body = fail("NOT_FOUND", "File not found");
            return reply.code(404).send(body);
          }

          const fromObjectPath = joinStoragePath(storageLocation.prefix, fromSafe);
          const toObjectPath = joinStoragePath(storageLocation.prefix, toSafe);
          const supabase = createServiceSupabaseClient();
          const { error: moveError } = await supabase.storage
            .from(storageLocation.bucket)
            .move(fromObjectPath, toObjectPath);

          if (moveError) {
            if (isStorageNotFoundError(moveError)) {
              const body = fail("NOT_FOUND", "File not found");
              return reply.code(404).send(body);
            }
            throw new HttpError(500, "STORAGE", `Failed to rename file: ${moveError.message}`);
          }

          return reply.code(200).send(ok({ from: fromSafe, to: toSafe }));
        }
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "ENOENT") {
          const body = fail("NOT_FOUND", "File not found");
          return reply.code(404).send(body);
        }
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Body: unknown; Reply: Buffer | ApiFailure }>(
    "/api/admin/reports/business",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const schema = z.object({
          password: z.string(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success || parsed.data.password !== ADMIN_REPORT_PASSWORD) {
          throw new HttpError(403, "FORBIDDEN", "Invalid report password");
        }

        const { buffer, filename } = await buildBusinessReportWorkbook();
        return reply
          .code(200)
          .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
          .header("Content-Disposition", `attachment; filename="${filename}"`)
          .header("Cache-Control", "no-store")
          .send(buffer);
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/orders",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const querySchema = z.object({
          status: z.enum(["new", "processing", "done"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        });

        const parsedQuery = querySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid query");
        }

        const status = parsedQuery.data.status ?? "new";
        const limit = parsedQuery.data.limit ?? 50;
        const supabase = createServiceSupabaseClient();

        const { data: orders, error: ordersError } = await supabase
          .from("orders")
          .select(
            "id,created_at,status,city_id,tg_user_id,tg_username,delivery_method,comment,total_price",
          )
          .eq("status", status)
          .order("created_at", { ascending: false })
          .limit(limit);

        if (ordersError) {
          throw new HttpError(500, "DB", `Failed to load orders: ${ordersError.message}`);
        }

        const orderList = orders ?? [];
        if (orderList.length === 0) {
          return reply.code(200).send(ok([]));
        }

        const orderIds = orderList.map((o) => o.id);
        const cityIds = Array.from(
          new Set(orderList.map((o) => o.city_id).filter((x): x is number => typeof x === "number")),
        );

        const [{ data: cities, error: citiesError }, { data: orderItems, error: orderItemsError }] =
          await Promise.all([
            cityIds.length > 0
              ? supabase.from("cities").select("id,slug").in("id", cityIds)
              : Promise.resolve({ data: [], error: null }),
            supabase
              .from("order_items")
              .select("order_id,product_id,qty,unit_price")
              .in("order_id", orderIds),
          ]);

        if (citiesError) {
          throw new HttpError(500, "DB", `Failed to load cities: ${citiesError.message}`);
        }
        if (orderItemsError) {
          throw new HttpError(
            500,
            "DB",
            `Failed to load order items: ${orderItemsError.message}`,
          );
        }

        const citySlugById = new Map((cities ?? []).map((c) => [c.id, c.slug]));

        const itemsList = (orderItems ?? []) as Array<{
          order_id: string;
          product_id: string | null;
          qty: number;
          unit_price: unknown;
        }>;

        const productIds = Array.from(
          new Set(itemsList.map((i) => i.product_id).filter((x): x is string => typeof x === "string")),
        );

        const { data: products, error: productsError } =
          productIds.length > 0
            ? await supabase.from("products").select("id,title").in("id", productIds)
            : { data: [], error: null };

        if (productsError) {
          throw new HttpError(500, "DB", `Failed to load products: ${productsError.message}`);
        }

        const titleByProductId = new Map((products ?? []).map((p) => [p.id, p.title]));

        const itemsByOrderId = new Map<
          string,
          Array<{ product_id: string | null; title: string | null; qty: number; unit_price: number }>
        >();

        for (const it of itemsList) {
          const title =
            it.product_id && titleByProductId.has(it.product_id)
              ? titleByProductId.get(it.product_id) ?? null
              : null;
          const unitPrice = toNumber(it.unit_price, "order_items.unit_price");
          const row = {
            product_id: it.product_id,
            title,
            qty: it.qty,
            unit_price: unitPrice,
          };
          const arr = itemsByOrderId.get(it.order_id) ?? [];
          arr.push(row);
          itemsByOrderId.set(it.order_id, arr);
        }

        const result = orderList.map((o) => ({
          id: o.id,
          created_at: o.created_at,
          status: o.status,
          city_id: o.city_id,
          city_slug: typeof o.city_id === "number" ? citySlugById.get(o.city_id) ?? null : null,
          tg_user_id: o.tg_user_id,
          tg_username: o.tg_username,
          delivery_method: o.delivery_method,
          comment: o.comment,
          total_price: toNumber(o.total_price, "orders.total_price"),
          items: itemsByOrderId.get(o.id) ?? [],
        }));

        return reply.code(200).send(ok(result));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.put<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/orders/:id/status",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const orderId = getParamId(request);

        const schema = z.object({
          status: z.enum(["new", "processing", "done"]),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("orders")
          .update({ status: parsed.data.status })
          .eq("id", orderId)
          .select("id,status")
          .single();

        if (error) {
          throw new HttpError(500, "DB", `Failed to update order status: ${error.message}`);
        }
        if (!data) {
          throw new HttpError(404, "NOT_FOUND", "Order not found");
        }

        if (parsed.data.status === "done") {
          try {
            await syncFinalOrderTelegramState({
              orderId: data.id,
              status: "done",
              logger: request.log,
            });
          } catch (e) {
            request.log.error(
              { err: e, orderId: data.id },
              "Failed to sync final Telegram state for done order",
            );
          }
        }

        if (parsed.data.status === "done") {
          try {
            await processReferralRewardForOrderDone({ orderId: data.id });
          } catch (e) {
            request.log.error({ err: e, orderId: data.id }, "Failed to process referral reward");
          }
        }

        return reply.code(200).send(ok({ id: data.id, status: data.status }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );
}
