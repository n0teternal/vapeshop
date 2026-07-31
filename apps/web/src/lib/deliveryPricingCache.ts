import type { City } from "../state/AppStateProvider";

export type DeliveryPricingRule = {
  minDistanceKm: number;
  feeRub: number;
};

export type DeliveryPeakSurchargeRule = {
  startTime: string;
  endTime: string;
  surchargeRub: number;
};

export type DeliveryPricingSettings = {
  citySlug: City;
  freeDeliveryThresholdRub: number;
  baseFeeRub: number;
  rules: DeliveryPricingRule[];
  peakSurchargeRules: DeliveryPeakSurchargeRule[];
};

const DELIVERY_PRICING_CACHE_KEY_PREFIX = "vapeshop:delivery-pricing:v1:";
const DELIVERY_PRICING_CACHE_TTL_MS = 15 * 60 * 1000;

type StoredDeliveryPricingSettings = {
  settings: DeliveryPricingSettings;
  updatedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getDeliveryPricingCacheKey(citySlug: City): string {
  return `${DELIVERY_PRICING_CACHE_KEY_PREFIX}${citySlug}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDeliveryPricingRule(value: unknown): value is DeliveryPricingRule {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.minDistanceKm) &&
    value.minDistanceKm >= 0 &&
    isFiniteNumber(value.feeRub) &&
    value.feeRub >= 0
  );
}

function isDeliveryPeakSurchargeRule(
  value: unknown,
): value is DeliveryPeakSurchargeRule {
  if (!isRecord(value)) return false;
  return (
    typeof value.startTime === "string" &&
    typeof value.endTime === "string" &&
    isFiniteNumber(value.surchargeRub) &&
    value.surchargeRub >= 0
  );
}

function isDeliveryPricingSettings(value: unknown): value is DeliveryPricingSettings {
  if (!isRecord(value)) return false;
  if (value.citySlug !== "vvo" && value.citySlug !== "blg") return false;
  if (
    !isFiniteNumber(value.freeDeliveryThresholdRub) ||
    value.freeDeliveryThresholdRub < 0 ||
    !isFiniteNumber(value.baseFeeRub) ||
    value.baseFeeRub < 0 ||
    !Array.isArray(value.rules) ||
    !Array.isArray(value.peakSurchargeRules)
  ) {
    return false;
  }

  return (
    value.rules.every(isDeliveryPricingRule) &&
    value.peakSurchargeRules.every(isDeliveryPeakSurchargeRule)
  );
}

export function readCachedDeliveryPricingSettings(
  citySlug: City,
): DeliveryPricingSettings | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(getDeliveryPricingCacheKey(citySlug));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const updatedAt = parsed.updatedAt;
    const settings = parsed.settings;
    if (!isFiniteNumber(updatedAt)) return null;
    if (Date.now() - updatedAt > DELIVERY_PRICING_CACHE_TTL_MS) return null;
    if (!isDeliveryPricingSettings(settings)) return null;
    if (settings.citySlug !== citySlug) return null;

    return settings;
  } catch {
    return null;
  }
}

export function writeCachedDeliveryPricingSettings(
  settings: DeliveryPricingSettings,
): void {
  if (typeof window === "undefined") return;

  try {
    const stored: StoredDeliveryPricingSettings = {
      settings,
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(
      getDeliveryPricingCacheKey(settings.citySlug),
      JSON.stringify(stored),
    );
  } catch {
    // Cache is only a UX speed-up; the API remains the source of truth.
  }
}
