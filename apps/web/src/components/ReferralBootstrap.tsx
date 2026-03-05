import { useEffect, useRef } from "react";
import { apiPost } from "../api/client";
import { useTelegram } from "../telegram/TelegramProvider";

export function ReferralBootstrap() {
  const { isTelegram, webApp } = useTelegram();
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    if (!isTelegram) return;
    if (!webApp.initData || webApp.initData.trim().length === 0) return;

    bootstrappedRef.current = true;
    apiPost<{ referralCode: string; referralLink: string; referralBound: boolean }>(
      "/api/referrals/bootstrap",
      {},
    ).catch(() => {
      // Best-effort bootstrap: do not block app UI.
    });
  }, [isTelegram, webApp.initData]);

  return null;
}
