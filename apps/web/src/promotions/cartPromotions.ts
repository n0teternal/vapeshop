import type { CartItem } from "../state/AppStateProvider";

export const PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE =
  "buy_2_get_3_cheapest_free" as const;

export type ActivePromotionRule = {
  id: number;
  cityId: number | null;
  type: typeof PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE;
  title: string;
  categorySlug: string;
  brand: string | null;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  createdAt: string;
};

export type ActivePromotionsResponse = {
  items: ActivePromotionRule[];
};

export type CartPromotionDiscount = {
  discountAmount: number;
  freeQty: number;
  title: string | null;
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
  "pro",
  "max",
  "mini",
  "disposable",
  "disposables",
  "одноразка",
  "одноразки",
  "вкус",
]);

export function normalizePromotionCategorySlug(value: string | null | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();
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
  return normalized || "other";
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

function extractManufacturerLabel(title: string): string {
  const tokens = title
    .replaceAll("_", " ")
    .replaceAll("/", " ")
    .split(/\s+/g)
    .map((token) => token.replaceAll(/[^\p{L}\p{N}-]+/gu, ""))
    .filter((token) => token.length > 0);

  for (const token of tokens) {
    const normalized = normalizeSearchText(token);
    if (normalized.length < 2) continue;
    if (/^\d/.test(normalized)) continue;
    if (MANUFACTURER_STOP_WORDS.has(normalized)) continue;
    return token;
  }

  return "";
}

function parsePromotionBrandFilters(brand: string | null): string[] {
  if (!brand) return [];
  return brand
    .split(/[,;\n]+/g)
    .map(normalizeSearchText)
    .filter((value) => value.length > 0);
}

function brandMatches(title: string, brand: string | null): boolean {
  const normalizedBrands = parsePromotionBrandFilters(brand);
  if (normalizedBrands.length === 0) return true;

  const manufacturer = normalizeSearchText(extractManufacturerLabel(title));
  const normalizedTitle = normalizeSearchText(title);
  return normalizedBrands.some(
    (normalizedBrand) =>
      (manufacturer && manufacturer === normalizedBrand) ||
      normalizedTitle.startsWith(`${normalizedBrand} `),
  );
}

function isRuleActiveNow(rule: ActivePromotionRule, nowMs: number): boolean {
  if (!rule.isActive) return false;

  const startsAtMs = rule.startsAt ? new Date(rule.startsAt).getTime() : Number.NaN;
  if (Number.isFinite(startsAtMs) && startsAtMs > nowMs) return false;

  const endsAtMs = rule.endsAt ? new Date(rule.endsAt).getTime() : Number.NaN;
  if (Number.isFinite(endsAtMs) && endsAtMs < nowMs) return false;

  return true;
}

export function calculateCartPromotionDiscount(params: {
  cart: CartItem[];
  rules: ActivePromotionRule[];
  nowMs?: number;
}): CartPromotionDiscount {
  const consumedUnitKeys = new Set<string>();
  const nowMs = params.nowMs ?? Date.now();
  let discountAmount = 0;
  let freeQty = 0;
  let title: string | null = null;

  const activeRules = params.rules
    .filter((rule) => isRuleActiveNow(rule, nowMs))
    .sort((a, b) => {
      const citySpecificity = Number(b.cityId !== null) - Number(a.cityId !== null);
      if (citySpecificity !== 0) return citySpecificity;
      const brandSpecificity = Number(b.brand !== null) - Number(a.brand !== null);
      if (brandSpecificity !== 0) return brandSpecificity;
      return b.id - a.id;
    });

  for (const rule of activeRules) {
    if (rule.type !== PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE) continue;

    const eligibleUnits: Unit[] = [];
    for (const item of params.cart) {
      if (normalizePromotionCategorySlug(item.categorySlug) !== rule.categorySlug) continue;
      if (!brandMatches(item.title, rule.brand)) continue;

      const qty = Math.max(0, Math.trunc(item.qty));
      for (let index = 0; index < qty; index += 1) {
        const key = `${item.productId}:${index}`;
        if (consumedUnitKeys.has(key)) continue;
        eligibleUnits.push({
          key,
          productId: item.productId,
          title: item.title,
          unitPrice: item.price,
        });
      }
    }

    const ruleFreeQty = Math.floor(eligibleUnits.length / 3);
    if (ruleFreeQty <= 0) continue;

    const ruleDiscount = [...eligibleUnits]
      .sort(
        (a, b) =>
          a.unitPrice - b.unitPrice ||
          a.title.localeCompare(b.title, "ru") ||
          a.productId.localeCompare(b.productId),
      )
      .slice(0, ruleFreeQty)
      .reduce((sum, unit) => sum + unit.unitPrice, 0);

    if (ruleDiscount <= 0) continue;

    for (const unit of eligibleUnits) {
      consumedUnitKeys.add(unit.key);
    }

    discountAmount += ruleDiscount;
    freeQty += ruleFreeQty;
    title = title ?? rule.title;
  }

  return {
    discountAmount: Math.max(0, Math.trunc(discountAmount)),
    freeQty,
    title,
  };
}
