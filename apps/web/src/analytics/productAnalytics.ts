import { apiPost } from "../api/client";

export type ProductAnalyticsEventName =
  | "app_open"
  | "catalog_view"
  | "cart_add"
  | "checkout_view"
  | "order_created";

type CitySlug = "blg" | "vvo";

/**
 * Sends only a coarse product event. The API identifies the signed-in
 * customer; no product, address, search text, cart or Telegram profile data is
 * attached here.
 */
export function trackProductEvent(
  eventName: ProductAnalyticsEventName,
  citySlug: CitySlug | null | undefined,
): void {
  // DAU in this first iteration means Mini App DAU. Do not create failed
  // tracking requests while somebody merely browses the public website.
  if (!window.Telegram?.WebApp?.initData) return;

  void apiPost<{ recorded: true }>("/api/analytics/events", {
    eventName,
    citySlug: citySlug ?? null,
  }).catch(() => {
    // Analytics must never affect a customer's experience.
  });
}
