import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { apiPost } from "../api/client";
import { useCustomerAuth } from "../auth/CustomerAuthProvider";
import {
  fetchLoyaltyStatus,
  LOYALTY_STATUS_QUERY_KEY,
  LOYALTY_STATUS_STALE_TIME_MS,
} from "../lib/loyaltyStatus";
import { useTelegram } from "../telegram/TelegramProvider";

export function ReferralBootstrap() {
  const { isTelegram, webApp } = useTelegram();
  const { user: websiteUser } = useCustomerAuth();
  const queryClient = useQueryClient();
  const bootstrappedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const canBootstrapTelegram = isTelegram && webApp.initData.trim().length > 0;
    const canBootstrapWebsite = !isTelegram && websiteUser !== null;
    if (!canBootstrapTelegram && !canBootstrapWebsite) return;

    const key = canBootstrapTelegram
      ? `telegram:${webApp.initData}`
      : `website:${websiteUser?.id}`;
    if (bootstrappedKeyRef.current === key) return;
    bootstrappedKeyRef.current = key;

    // The profile card uses this exact query. Warm it while the visitor is
    // browsing the catalog, rather than only after they tap the profile tab.
    void queryClient
      .prefetchQuery({
        queryKey: LOYALTY_STATUS_QUERY_KEY,
        queryFn: fetchLoyaltyStatus,
        staleTime: LOYALTY_STATUS_STALE_TIME_MS,
      })
      .catch(() => {
        // The profile keeps its normal loading state if the background request fails.
      });

    void apiPost<{ referralCode: string; referralLink: string; referralBound: boolean }>(
      "/api/referrals/bootstrap",
      {},
    ).catch(() => {
      // Best-effort bootstrap: do not block app UI.
    });
  }, [isTelegram, queryClient, webApp.initData, websiteUser]);

  return null;
}
