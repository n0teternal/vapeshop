import { useEffect, useRef } from "react";
import { trackProductEvent } from "../analytics/productAnalytics";
import { useAppState } from "../state/AppStateProvider";
import { useTelegram } from "../telegram/TelegramProvider";

/** Records one Mini App open for authenticated Telegram customers. */
export function ProductAnalyticsBootstrap() {
  const { state } = useAppState();
  const { isTelegram } = useTelegram();
  const trackedRef = useRef(false);

  useEffect(() => {
    if (!isTelegram || !state.city || trackedRef.current) return;

    trackedRef.current = true;
    trackProductEvent("app_open", state.city);
  }, [isTelegram, state.city]);

  return null;
}
