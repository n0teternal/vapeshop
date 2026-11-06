import { apiGet } from "../api/client";

export type LoyaltyStatus = {
  pointsBalance: number;
  pointsNextExpiresAt: string | null;
  monthlySpent: number;
  cashbackLevel: number;
};

export const LOYALTY_STATUS_QUERY_KEY = ["loyalty-status"] as const;
export const LOYALTY_STATUS_STALE_TIME_MS = 60_000;

export function fetchLoyaltyStatus(): Promise<LoyaltyStatus> {
  return apiGet<LoyaltyStatus>("/api/referrals/overview?limit=1&offset=0");
}
