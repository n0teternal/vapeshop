import { HttpError } from "../httpError.js";
import type { Database } from "../supabase/serviceClient.js";
import type { SupabaseClient } from "@supabase/supabase-js";

export type DeliveryPricingCitySlug = "vvo" | "blg";

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
  citySlug: DeliveryPricingCitySlug;
  freeDeliveryThresholdRub: number;
  baseFeeRub: number;
  rules: DeliveryPricingRule[];
  peakSurchargeRules: DeliveryPeakSurchargeRule[];
};

export type DeliveryPricingSettingsUpdate = {
  citySlug: DeliveryPricingCitySlug;
  baseFeeRub: number;
  rules: DeliveryPricingRule[];
  peakSurchargeRules: DeliveryPeakSurchargeRule[];
};

type DeliveryPricingRow = {
  city_slug: string;
  base_fee_rub: unknown;
  rules: unknown;
  peak_surcharge_rules?: unknown;
};

const DELIVERY_PRICING_RULE_LIMIT = 12;
const DELIVERY_PEAK_SURCHARGE_RULE_LIMIT = 12;
const MAX_DELIVERY_FEE_RUB = 10_000;
const MAX_DISTANCE_KM = 100;

export const DEFAULT_BLG_DELIVERY_FEE_RUB = 150;
export const BLG_FREE_DELIVERY_THRESHOLD_RUB = 1500;

const DEFAULT_DELIVERY_PRICING_BY_CITY: Record<DeliveryPricingCitySlug, DeliveryPricingSettings> = {
  vvo: {
    citySlug: "vvo",
    freeDeliveryThresholdRub: BLG_FREE_DELIVERY_THRESHOLD_RUB,
    baseFeeRub: 0,
    rules: [],
    peakSurchargeRules: [],
  },
  blg: {
    citySlug: "blg",
    freeDeliveryThresholdRub: BLG_FREE_DELIVERY_THRESHOLD_RUB,
    baseFeeRub: DEFAULT_BLG_DELIVERY_FEE_RUB,
    rules: [],
    peakSurchargeRules: [],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberFromUnknown(value: unknown, fieldName: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(",", "."))
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, "BAD_REQUEST", `${fieldName} must be a number`);
  }

  return parsed;
}

function parseCitySlug(value: unknown): DeliveryPricingCitySlug {
  if (value === "vvo" || value === "blg") return value;
  throw new HttpError(400, "BAD_REQUEST", "citySlug must be 'vvo' | 'blg'");
}

function normalizeFeeRub(value: unknown, fieldName: string): number {
  const parsed = numberFromUnknown(value, fieldName);
  const rounded = Math.round(parsed);
  if (rounded < 0 || rounded > MAX_DELIVERY_FEE_RUB) {
    throw new HttpError(400, "BAD_REQUEST", `${fieldName} must be in range 0..10000`);
  }
  return rounded;
}

function normalizeDistanceKm(value: unknown, fieldName: string): number {
  const parsed = numberFromUnknown(value, fieldName);
  const rounded = Math.round(parsed * 10) / 10;
  if (rounded <= 0 || rounded > MAX_DISTANCE_KM) {
    throw new HttpError(400, "BAD_REQUEST", `${fieldName} must be in range 0.1..100`);
  }
  return rounded;
}

function normalizeTimeOfDay(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "BAD_REQUEST", `${fieldName} must be HH:MM`);
  }

  const trimmed = value.trim();
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (!match) {
    throw new HttpError(400, "BAD_REQUEST", `${fieldName} must be HH:MM`);
  }

  return trimmed;
}

function minutesFromTimeOfDay(value: string): number {
  const [hours, minutes] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function normalizeRules(value: unknown): DeliveryPricingRule[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "BAD_REQUEST", "rules must be an array");
  }
  if (value.length > DELIVERY_PRICING_RULE_LIMIT) {
    throw new HttpError(400, "BAD_REQUEST", `rules can contain up to ${DELIVERY_PRICING_RULE_LIMIT} items`);
  }

  const byDistance = new Map<number, DeliveryPricingRule>();
  for (const [index, rawRule] of value.entries()) {
    if (!isRecord(rawRule)) {
      throw new HttpError(400, "BAD_REQUEST", `rules[${index}] must be an object`);
    }
    const minDistanceKm = normalizeDistanceKm(rawRule.minDistanceKm, `rules[${index}].minDistanceKm`);
    const feeRub = normalizeFeeRub(rawRule.feeRub, `rules[${index}].feeRub`);
    byDistance.set(minDistanceKm, { minDistanceKm, feeRub });
  }

  return Array.from(byDistance.values()).sort((a, b) => a.minDistanceKm - b.minDistanceKm);
}

function normalizePeakSurchargeRules(value: unknown): DeliveryPeakSurchargeRule[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "BAD_REQUEST", "peakSurchargeRules must be an array");
  }
  if (value.length > DELIVERY_PEAK_SURCHARGE_RULE_LIMIT) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      `peakSurchargeRules can contain up to ${DELIVERY_PEAK_SURCHARGE_RULE_LIMIT} items`,
    );
  }

  const out: DeliveryPeakSurchargeRule[] = [];
  const seen = new Set<string>();
  for (const [index, rawRule] of value.entries()) {
    if (!isRecord(rawRule)) {
      throw new HttpError(400, "BAD_REQUEST", `peakSurchargeRules[${index}] must be an object`);
    }
    const startTime = normalizeTimeOfDay(rawRule.startTime, `peakSurchargeRules[${index}].startTime`);
    const endTime = normalizeTimeOfDay(rawRule.endTime, `peakSurchargeRules[${index}].endTime`);
    if (minutesFromTimeOfDay(startTime) === minutesFromTimeOfDay(endTime)) {
      throw new HttpError(
        400,
        "BAD_REQUEST",
        `peakSurchargeRules[${index}] startTime and endTime must be different`,
      );
    }

    const surchargeRub = normalizeFeeRub(rawRule.surchargeRub, `peakSurchargeRules[${index}].surchargeRub`);
    const key = `${startTime}-${endTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ startTime, endTime, surchargeRub });
  }

  return out.sort(
    (a, b) =>
      minutesFromTimeOfDay(a.startTime) - minutesFromTimeOfDay(b.startTime) ||
      minutesFromTimeOfDay(a.endTime) - minutesFromTimeOfDay(b.endTime),
  );
}

function isMissingDeliveryPricingTableError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return (
    code === "PGRST205" ||
    message.includes("delivery_pricing_settings") ||
    (message.includes("relation") && message.includes("does not exist")) ||
    message.includes("schema cache")
  );
}

function defaultDeliveryPricingSettings(citySlug: DeliveryPricingCitySlug): DeliveryPricingSettings {
  const fallback = DEFAULT_DELIVERY_PRICING_BY_CITY[citySlug];
  return {
    citySlug: fallback.citySlug,
    freeDeliveryThresholdRub: fallback.freeDeliveryThresholdRub,
    baseFeeRub: fallback.baseFeeRub,
    rules: [...fallback.rules],
    peakSurchargeRules: [...fallback.peakSurchargeRules],
  };
}

function rowToDeliveryPricingSettings(
  citySlug: DeliveryPricingCitySlug,
  row: DeliveryPricingRow | null,
): DeliveryPricingSettings {
  const fallback = defaultDeliveryPricingSettings(citySlug);
  if (!row) return fallback;

  return {
    citySlug,
    freeDeliveryThresholdRub: fallback.freeDeliveryThresholdRub,
    baseFeeRub: normalizeFeeRub(row.base_fee_rub, "delivery_pricing_settings.base_fee_rub"),
    rules: normalizeRules(row.rules),
    peakSurchargeRules: normalizePeakSurchargeRules(row.peak_surcharge_rules),
  };
}

export function parseDeliveryPricingSettingsUpdate(
  value: unknown,
): DeliveryPricingSettingsUpdate {
  if (!isRecord(value)) {
    throw new HttpError(400, "BAD_REQUEST", "body must be an object");
  }

  return {
    citySlug: parseCitySlug(value.citySlug),
    baseFeeRub: normalizeFeeRub(value.baseFeeRub, "baseFeeRub"),
    rules: normalizeRules(value.rules),
    peakSurchargeRules: normalizePeakSurchargeRules(value.peakSurchargeRules),
  };
}

export async function loadDeliveryPricingSettings(params: {
  supabase: SupabaseClient<Database>;
  citySlug: DeliveryPricingCitySlug;
}): Promise<DeliveryPricingSettings> {
  const { data, error } = await params.supabase
    .from("delivery_pricing_settings")
    .select("city_slug,base_fee_rub,rules,peak_surcharge_rules")
    .eq("city_slug", params.citySlug)
    .maybeSingle();

  if (error) {
    if (isMissingDeliveryPricingTableError(error)) {
      return defaultDeliveryPricingSettings(params.citySlug);
    }
    throw new HttpError(500, "DB", `Failed to load delivery pricing settings: ${error.message}`);
  }

  return rowToDeliveryPricingSettings(params.citySlug, (data ?? null) as DeliveryPricingRow | null);
}

export async function saveDeliveryPricingSettings(params: {
  supabase: SupabaseClient<Database>;
  update: DeliveryPricingSettingsUpdate;
}): Promise<DeliveryPricingSettings> {
  const { error } = await params.supabase
    .from("delivery_pricing_settings")
    .upsert(
      {
        city_slug: params.update.citySlug,
        base_fee_rub: params.update.baseFeeRub,
        rules: params.update.rules,
        peak_surcharge_rules: params.update.peakSurchargeRules,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "city_slug" },
    );

  if (error) {
    if (isMissingDeliveryPricingTableError(error)) {
      throw new HttpError(
        409,
        "DELIVERY_PRICING_SCHEMA_MISSING",
        "Run supabase/alter_delivery_pricing_settings.sql in Supabase SQL Editor.",
      );
    }
    throw new HttpError(500, "DB", `Failed to save delivery pricing settings: ${error.message}`);
  }

  return loadDeliveryPricingSettings({
    supabase: params.supabase,
    citySlug: params.update.citySlug,
  });
}

function getMatchedDeliveryPricingRule(params: {
  distanceKm: number | null | undefined;
  settings: DeliveryPricingSettings;
}): DeliveryPricingRule | null {
  const distanceKm = params.distanceKm;
  if (typeof distanceKm !== "number" || !Number.isFinite(distanceKm)) {
    return null;
  }

  let matchedRule: DeliveryPricingRule | null = null;
  for (const rule of params.settings.rules) {
    if (distanceKm > rule.minDistanceKm) {
      matchedRule = rule;
    }
  }

  return matchedRule;
}

function splitTimeInterval(startMinutes: number, endMinutes: number): Array<[number, number]> {
  if (startMinutes < endMinutes) return [[startMinutes, endMinutes]];
  return [
    [startMinutes, 24 * 60],
    [0, endMinutes],
  ];
}

function timeIntervalsOverlap(
  firstStartMinutes: number,
  firstEndMinutes: number,
  secondStartMinutes: number,
  secondEndMinutes: number,
): boolean {
  const firstParts = splitTimeInterval(firstStartMinutes, firstEndMinutes);
  const secondParts = splitTimeInterval(secondStartMinutes, secondEndMinutes);

  return firstParts.some(([firstStart, firstEnd]) =>
    secondParts.some(
      ([secondStart, secondEnd]) =>
        Math.max(firstStart, secondStart) < Math.min(firstEnd, secondEnd),
    ),
  );
}

function parseDeliveryTimeSlot(value: string | null | undefined): {
  startMinutes: number;
  endMinutes: number;
} | null {
  if (typeof value !== "string") return null;
  const match = /^([0-2]\d:[0-5]\d)-([0-2]\d:[0-5]\d)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const startTime = normalizeTimeOfDay(match[1], "deliveryTimeSlot.startTime");
  const endTime = normalizeTimeOfDay(match[2], "deliveryTimeSlot.endTime");
  if (startTime === endTime) return null;
  return {
    startMinutes: minutesFromTimeOfDay(startTime),
    endMinutes: minutesFromTimeOfDay(endTime),
  };
}

function calculatePeakSurchargeRub(params: {
  deliveryTimeSlot: string | null | undefined;
  settings: DeliveryPricingSettings;
}): number {
  const parsedSlot = parseDeliveryTimeSlot(params.deliveryTimeSlot);
  if (!parsedSlot) return 0;

  let surchargeRub = 0;
  for (const rule of params.settings.peakSurchargeRules) {
    if (
      timeIntervalsOverlap(
        parsedSlot.startMinutes,
        parsedSlot.endMinutes,
        minutesFromTimeOfDay(rule.startTime),
        minutesFromTimeOfDay(rule.endTime),
      )
    ) {
      surchargeRub = Math.max(surchargeRub, rule.surchargeRub);
    }
  }

  return surchargeRub;
}

export function calculateDeliveryFeeRub(params: {
  citySlug: DeliveryPricingCitySlug;
  deliveryMethod: string;
  itemsSubtotalRub: number;
  distanceKm?: number | null;
  deliveryTimeSlot?: string | null;
  settings: DeliveryPricingSettings;
}): number {
  if (params.citySlug !== "blg" || params.deliveryMethod !== "delivery") return 0;
  if (params.itemsSubtotalRub >= params.settings.freeDeliveryThresholdRub) return 0;

  const peakSurchargeRub = calculatePeakSurchargeRub({
    deliveryTimeSlot: params.deliveryTimeSlot,
    settings: params.settings,
  });

  const matchedDistanceRule = getMatchedDeliveryPricingRule({
    distanceKm: params.distanceKm,
    settings: params.settings,
  });
  if (matchedDistanceRule) {
    return matchedDistanceRule.feeRub + peakSurchargeRub;
  }

  return params.settings.baseFeeRub + peakSurchargeRub;
}
