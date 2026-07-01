import type { CartItem } from "../state/AppStateProvider";

export const PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE =
  "buy_2_get_3_cheapest_free" as const;
export const PROMOTION_TYPE_BUY_POD_GET_LIQUID_CHEAPEST_FREE =
  "buy_pod_get_liquid_cheapest_free" as const;

export type PromotionRuleType =
  | typeof PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE
  | typeof PROMOTION_TYPE_BUY_POD_GET_LIQUID_CHEAPEST_FREE;

export type ActivePromotionRule = {
  id: number;
  cityId: number | null;
  type: PromotionRuleType;
  title: string;
  categorySlug: string;
  brand: string | null;
  productIds?: string[];
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

const MANUFACTURER_LABEL_ALIASES = new Map<string, string>();
for (const group of MANUFACTURER_SYNONYM_GROUPS) {
  const [canonicalLabel, ...terms] = group;
  for (const term of [canonicalLabel, ...terms]) {
    const normalized = normalizeSearchText(term);
    if (normalized) MANUFACTURER_LABEL_ALIASES.set(normalized, canonicalLabel);
  }
}

function normalizeManufacturerLabel(value: string): string {
  const normalized = normalizeSearchText(value);
  return MANUFACTURER_LABEL_ALIASES.get(normalized) ?? value;
}

function normalizePromotionBrandKey(value: string): string {
  return normalizeSearchText(normalizeManufacturerLabel(value)).replaceAll(" ", "-");
}

function extractManufacturerLabel(title: string): string {
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

    return normalizeManufacturerLabel(token);
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

  const manufacturer = normalizePromotionBrandKey(extractManufacturerLabel(title));
  const normalizedTitle = normalizeSearchText(title);
  return normalizedBrands.some(
    (normalizedBrand) =>
      (manufacturer && manufacturer === normalizedBrand) ||
      normalizedTitle.startsWith(`${normalizedBrand.replaceAll("-", " ")} `),
  );
}

function getRuleProductIds(rule: ActivePromotionRule): string[] {
  return Array.isArray(rule.productIds)
    ? rule.productIds.filter((productId) => typeof productId === "string" && productId.length > 0)
    : [];
}

function productMatches(productId: string, productIds: string[]): boolean {
  return productIds.length === 0 || productIds.includes(productId);
}

function isRuleActiveNow(rule: ActivePromotionRule, nowMs: number): boolean {
  if (!rule.isActive) return false;

  const startsAtMs = rule.startsAt ? new Date(rule.startsAt).getTime() : Number.NaN;
  if (Number.isFinite(startsAtMs) && startsAtMs > nowMs) return false;

  const endsAtMs = rule.endsAt ? new Date(rule.endsAt).getTime() : Number.NaN;
  if (Number.isFinite(endsAtMs) && endsAtMs < nowMs) return false;

  return true;
}

function buildUnits(cart: CartItem[], consumedUnitKeys: Set<string>): Unit[] {
  const units: Unit[] = [];

  for (const item of cart) {
    const qty = Math.max(0, Math.trunc(item.qty));
    for (let index = 0; index < qty; index += 1) {
      const key = `${item.productId}:${index}`;
      if (consumedUnitKeys.has(key)) continue;
      units.push({
        key,
        productId: item.productId,
        title: item.title,
        unitPrice: item.price,
      });
    }
  }

  return units;
}

function sortUnitsByCheapestFirst(a: Unit, b: Unit): number {
  return (
    a.unitPrice - b.unitPrice ||
    a.title.localeCompare(b.title, "ru") ||
    a.productId.localeCompare(b.productId) ||
    a.key.localeCompare(b.key)
  );
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
      const productSpecificity =
        Number(getRuleProductIds(b).length > 0) - Number(getRuleProductIds(a).length > 0);
      if (productSpecificity !== 0) return productSpecificity;
      return b.id - a.id;
    });

  for (const rule of activeRules) {
    const ruleProductIds = getRuleProductIds(rule);

    if (rule.type === PROMOTION_TYPE_BUY_POD_GET_LIQUID_CHEAPEST_FREE) {
      const podUnits = buildUnits(
        params.cart.filter(
          (item) =>
            normalizePromotionCategorySlug(item.categorySlug) === "pod" &&
            productMatches(item.productId, ruleProductIds) &&
            brandMatches(item.title, rule.brand),
        ),
        consumedUnitKeys,
      );
      const liquidUnits = buildUnits(
        params.cart.filter(
          (item) => normalizePromotionCategorySlug(item.categorySlug) === "liquid",
        ),
        consumedUnitKeys,
      );
      const ruleFreeQty = Math.min(podUnits.length, liquidUnits.length);
      if (ruleFreeQty <= 0) continue;

      const freeUnits = [...liquidUnits]
        .sort(sortUnitsByCheapestFirst)
        .slice(0, ruleFreeQty);
      const ruleDiscount = freeUnits.reduce((sum, unit) => sum + unit.unitPrice, 0);
      if (ruleDiscount <= 0) continue;

      for (const unit of podUnits.slice(0, ruleFreeQty)) {
        consumedUnitKeys.add(unit.key);
      }
      for (const unit of freeUnits) {
        consumedUnitKeys.add(unit.key);
      }

      discountAmount += ruleDiscount;
      freeQty += ruleFreeQty;
      title = title ?? rule.title;
      continue;
    }

    if (rule.type !== PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE) continue;

    const eligibleUnits: Unit[] = [];
    for (const item of params.cart) {
      if (normalizePromotionCategorySlug(item.categorySlug) !== rule.categorySlug) continue;
      if (!productMatches(item.productId, ruleProductIds)) continue;
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
      .sort(sortUnitsByCheapestFirst)
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
