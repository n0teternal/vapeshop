import { HttpError } from "../httpError.js";
import type { createServiceSupabaseClient } from "../supabase/serviceClient.js";

export const PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE =
  "buy_2_get_3_cheapest_free" as const;

export type PromotionRuleType = typeof PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE;

export type PromotionRule = {
  id: number;
  cityId: number | null;
  type: PromotionRuleType;
  title: string;
  categorySlug: string;
  brand: string | null;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  createdAt: string;
};

export type PromotionLine = {
  productId: string;
  title: string;
  categorySlug: string;
  qty: number;
  unitPrice: number;
};

export type PromotionDiscountApplication = {
  ruleId: number;
  title: string;
  freeQty: number;
  discountAmount: number;
};

export type PromotionDiscountResult = {
  discountAmount: number;
  applications: PromotionDiscountApplication[];
};

type PromotionRuleRow = {
  id: number;
  city_id: number | null;
  type: string;
  title: string;
  category_slug: string;
  brand: string | null;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  created_at: string;
};

type Unit = {
  key: string;
  productId: string;
  title: string;
  unitPrice: number;
};

const MANUFACTURER_STOP_WORDS = new Set([
  "pod",
  "pods",
  "salt",
  "vape",
  "pro",
  "max",
  "mini",
  "liquid",
  "cartridge",
  "disposable",
  "disposables",
  "одноразка",
  "одноразовый",
  "одноразовая",
  "одноразки",
  "вейп",
  "вкус",
]);

const MANUFACTURER_SYNONYM_GROUPS = [
  ["CATSWILL", "catswill"],
  ["D.L.T.A.", "dlta", "d l t a"],
  ["DUAL EXTREME", "dual", "dual extreme"],
  ["Elf Bar", "elf", "elf bar"],
  ["FEDRS", "fedrs"],
  ["Fummo", "fummo"],
  ["Geekvape", "aegis", "geek", "geek vape", "geekvape"],
  ["HQD", "hqd"],
  ["Lost Mary", "lost mary", "lostmary"],
  ["ODENS", "odens"],
  ["OGGO", "oggo"],
  ["Podonki", "podonki"],
  ["Puffmi", "puffmi"],
  ["RnM", "rnm"],
  ["SMOANT", "pasito", "smoant"],
  ["Vozol", "vozol"],
  ["WAKA", "waka"],
  ["XROS", "xros"],
  ["ГРЕХ", "greh"],
] as const;

export function getPromotionTypeAdminTitle(type: PromotionRuleType): string {
  if (type === PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE) return "1+1=3";
  return type;
}

export function getPromotionTypePublicTitle(type: PromotionRuleType): string {
  if (type === PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE) {
    return "1+1 одноразка = 3-я одноразка в подарок";
  }
  return type;
}

export function parsePromotionRuleType(value: unknown): PromotionRuleType | null {
  return value === PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE ? value : null;
}

export function normalizePromotionCategorySlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "disposable" ||
    normalized === "disposables" ||
    normalized === "одноразка" ||
    normalized === "одноразки"
  ) {
    return "disposable";
  }
  if (normalized === "liquid" || normalized === "liquids") return "liquid";
  if (normalized === "pod" || normalized === "pods") return "pod";
  if (normalized === "cartridge" || normalized === "cartridges") return "cartridge";
  if (normalized === "tobacco") return "tobacco";
  return normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "other";
}

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MANUFACTURER_LABEL_ALIASES = new Map<string, string>();
for (const group of MANUFACTURER_SYNONYM_GROUPS) {
  const [canonicalLabel, ...terms] = group;
  for (const term of [canonicalLabel, ...terms]) {
    const normalized = normalizeSearchText(term);
    if (normalized) MANUFACTURER_LABEL_ALIASES.set(normalized, canonicalLabel);
  }
}

function normalizePromotionBrandLabel(value: string): string {
  const normalized = normalizeSearchText(value);
  return MANUFACTURER_LABEL_ALIASES.get(normalized) ?? value;
}

export function normalizePromotionBrandKey(value: string): string {
  return normalizeSearchText(normalizePromotionBrandLabel(value)).replaceAll(" ", "-");
}

export function extractPromotionBrandLabel(title: string): string {
  const tokens = title
    .replaceAll("_", " ")
    .replaceAll("/", " ")
    .split(/\s+/g)
    .map((token) => token.replaceAll(/[^\p{L}\p{N}-]+/gu, ""))
    .filter((token) => token.length > 0);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const normalized = normalizeSearchText(token);
    if (normalized.length < 2) continue;
    if (/^\d/.test(normalized)) continue;
    if (MANUFACTURER_STOP_WORDS.has(normalized)) continue;

    const nextNormalized = normalizeSearchText(tokens[index + 1] ?? "");
    const compoundManufacturer =
      nextNormalized.length > 0
        ? MANUFACTURER_LABEL_ALIASES.get(`${normalized} ${nextNormalized}`)
        : undefined;
    if (compoundManufacturer) {
      return compoundManufacturer;
    }

    return normalizePromotionBrandLabel(token);
  }

  return "";
}

function parsePromotionBrandFilters(brand: string | null): string[] {
  if (!brand) return [];
  return brand
    .split(/[,;\n]+/g)
    .map(normalizePromotionBrandKey)
    .filter((value) => value.length > 0);
}

function brandMatches(title: string, brand: string | null): boolean {
  const normalizedBrands = parsePromotionBrandFilters(brand);
  if (normalizedBrands.length === 0) return true;

  const manufacturer = normalizePromotionBrandKey(extractPromotionBrandLabel(title));
  const normalizedTitle = normalizeSearchText(title);
  return normalizedBrands.some(
    (normalizedBrand) =>
      (manufacturer && manufacturer === normalizedBrand) ||
      normalizedTitle.startsWith(`${normalizedBrand.replaceAll("-", " ")} `),
  );
}

function isMissingPromotionRulesTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; message?: unknown };
  const code = typeof maybeError.code === "string" ? maybeError.code : "";
  const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
  return (
    code === "PGRST205" ||
    (message.includes("promotion_rules") && message.includes("schema cache")) ||
    (message.includes("relation") && message.includes("promotion_rules"))
  );
}

function mapPromotionRuleRow(row: PromotionRuleRow): PromotionRule | null {
  const type = parsePromotionRuleType(row.type);
  if (!type) return null;

  return {
    id: row.id,
    cityId: typeof row.city_id === "number" ? row.city_id : null,
    type,
    title: row.title || getPromotionTypePublicTitle(type),
    categorySlug: normalizePromotionCategorySlug(row.category_slug),
    brand:
      typeof row.brand === "string" && row.brand.trim().length > 0
        ? row.brand.trim()
        : null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

function isRuleActiveNow(rule: PromotionRule, nowMs: number): boolean {
  if (!rule.isActive) return false;

  const startsAtMs = rule.startsAt ? new Date(rule.startsAt).getTime() : Number.NaN;
  if (Number.isFinite(startsAtMs) && startsAtMs > nowMs) return false;

  const endsAtMs = rule.endsAt ? new Date(rule.endsAt).getTime() : Number.NaN;
  if (Number.isFinite(endsAtMs) && endsAtMs < nowMs) return false;

  return true;
}

export async function loadActivePromotionRules(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  cityId?: number | null;
  nowMs?: number;
}): Promise<PromotionRule[]> {
  const { data, error } = await params.supabase
    .from("promotion_rules")
    .select("id,city_id,type,title,category_slug,brand,starts_at,ends_at,is_active,created_at")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingPromotionRulesTableError(error)) return [];
    throw new HttpError(500, "DB", `Failed to load promotion rules: ${error.message}`);
  }

  const nowMs = params.nowMs ?? Date.now();
  const cityId = typeof params.cityId === "number" ? params.cityId : null;
  return ((data ?? []) as PromotionRuleRow[])
    .map(mapPromotionRuleRow)
    .filter((rule): rule is PromotionRule => rule !== null)
    .filter((rule) => cityId === null || rule.cityId === null || rule.cityId === cityId)
    .filter((rule) => isRuleActiveNow(rule, nowMs))
    .sort((a, b) => {
      const citySpecificity = Number(b.cityId !== null) - Number(a.cityId !== null);
      if (citySpecificity !== 0) return citySpecificity;
      const brandSpecificity = Number(b.brand !== null) - Number(a.brand !== null);
      if (brandSpecificity !== 0) return brandSpecificity;
      return b.id - a.id;
    });
}

export function calculatePromotionDiscount(params: {
  rules: PromotionRule[];
  lines: PromotionLine[];
}): PromotionDiscountResult {
  const applications: PromotionDiscountApplication[] = [];
  const consumedUnitKeys = new Set<string>();
  let discountAmount = 0;

  for (const rule of params.rules) {
    if (rule.type !== PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE) continue;

    const eligibleUnits: Unit[] = [];

    for (const line of params.lines) {
      if (normalizePromotionCategorySlug(line.categorySlug) !== rule.categorySlug) continue;
      if (!brandMatches(line.title, rule.brand)) continue;

      const qty = Math.max(0, Math.trunc(line.qty));
      for (let index = 0; index < qty; index += 1) {
        const key = `${line.productId}:${index}`;
        if (consumedUnitKeys.has(key)) continue;
        eligibleUnits.push({
          key,
          productId: line.productId,
          title: line.title,
          unitPrice: line.unitPrice,
        });
      }
    }

    const freeQty = Math.floor(eligibleUnits.length / 3);
    if (freeQty <= 0) continue;

    const sortedByPrice = [...eligibleUnits].sort(
      (a, b) =>
        a.unitPrice - b.unitPrice ||
        a.title.localeCompare(b.title, "ru") ||
        a.productId.localeCompare(b.productId),
    );
    const freeUnits = sortedByPrice.slice(0, freeQty);
    const ruleDiscount = freeUnits.reduce((sum, unit) => sum + unit.unitPrice, 0);
    if (ruleDiscount <= 0) continue;

    for (const unit of eligibleUnits) {
      consumedUnitKeys.add(unit.key);
    }

    discountAmount += ruleDiscount;
    applications.push({
      ruleId: rule.id,
      title: rule.title || getPromotionTypePublicTitle(rule.type),
      freeQty,
      discountAmount: ruleDiscount,
    });
  }

  return {
    discountAmount: Math.max(0, Math.trunc(discountAmount)),
    applications,
  };
}
