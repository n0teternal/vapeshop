export type CashbackTier = {
  id: string;
  name: string;
  minOrderTotalRub: number;
  ratePercent: number;
};

export type CashbackProjection = {
  points: number;
  tier: CashbackTier | null;
};

export function calculateCashbackProjection(
  eligibleAmountRub: number,
  tiers: CashbackTier[],
): CashbackProjection {
  const amount = Number.isFinite(eligibleAmountRub)
    ? Math.max(0, Math.floor(eligibleAmountRub))
    : 0;
  const tier = [...tiers]
    .sort((left, right) => left.minOrderTotalRub - right.minOrderTotalRub)
    .reverse()
    .find((candidate) => amount >= candidate.minOrderTotalRub) ?? null;

  return {
    points: tier ? Math.floor((amount * tier.ratePercent) / 100) : 0,
    tier,
  };
}
