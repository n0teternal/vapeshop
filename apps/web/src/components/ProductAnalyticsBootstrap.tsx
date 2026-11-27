import { useEffect, useRef } from "react";
import { trackProductEvent } from "../analytics/productAnalytics";
import { useAppState } from "../state/AppStateProvider";
import { useTelegram } from "../telegram/TelegramProvider";
import { AppFeedbackPrompt } from "./AppFeedbackPrompt";

const FEEDBACK_TEST_CUSTOMER_ID = 1208488286;
const FEEDBACK_DELAY_MS = 25_000;

/** Records one Mini App open for authenticated Telegram customers. */
export function ProductAnalyticsBootstrap() {
  const { state } = useAppState();
  const { isTelegram, webApp } = useTelegram();
  const trackedRef = useRef(false);
  const customerId = webApp.initDataUnsafe?.user?.id ?? null;

  useEffect(() => {
    if (!isTelegram || !state.city || trackedRef.current) return;

    trackedRef.current = true;
    trackProductEvent("app_open", state.city);
  }, [isTelegram, state.city]);

  if (!isTelegram || !state.city) return null;

  return (
    <AppFeedbackPrompt
      citySlug={state.city}
      delayMs={customerId === FEEDBACK_TEST_CUSTOMER_ID ? 0 : FEEDBACK_DELAY_MS}
    />
  );
}
