export type CashbackTier = {
  id: "basic" | "advanced" | "vip";
  name: string;
  minOrderTotalRub: number;
  ratePercent: number;
};

export type CashbackCalculation = {
  eligibleAmountRub: number;
  points: number;
  tier: CashbackTier | null;
};

export type CashbackEligibleAmountParams = {
  itemsSubtotalRub: number;
  promotionDiscountRub: number;
  couponDiscountRub: number;
  pointsDiscountRub: number;
};

// The thresholds and rates shown in the customer loyalty cards.
export const CASHBACK_TIERS: readonly CashbackTier[] = [
  {
    id: "basic",
    name: "Базовый",
    minOrderTotalRub: 3_000,
    ratePercent: 3,
  },
  {
    id: "advanced",
    name: "Продвинутый",
    minOrderTotalRub: 5_000,
    ratePercent: 5,
  },
  {
    id: "vip",
    name: "VIP",
    minOrderTotalRub: 10_000,
    ratePercent: 7,
  },
];

function normalizeRub(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

export function calculateCashbackEligibleAmount(params: CashbackEligibleAmountParams): number {
  return Math.max(
    0,
    normalizeAmount(params.itemsSubtotalRub) -
      normalizeAmount(params.promotionDiscountRub) -
      normalizeAmount(params.couponDiscountRub) -
      normalizeAmount(params.pointsDiscountRub),
  );
}

export function calculateOrderCashback(eligibleAmountRub: number): CashbackCalculation {
  const normalizedAmount = normalizeRub(eligibleAmountRub);
  const tier = [...CASHBACK_TIERS]
    .reverse()
    .find((candidate) => normalizedAmount >= candidate.minOrderTotalRub) ?? null;

  return {
    eligibleAmountRub: normalizedAmount,
    points: tier ? Math.floor((normalizedAmount * tier.ratePercent) / 100) : 0,
    tier,
  };
}
