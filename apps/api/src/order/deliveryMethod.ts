export const DELIVERY_METHOD_PICKUP = "pickup" as const;
export const DELIVERY_METHOD_DELIVERY = "delivery" as const;
export const DELIVERY_METHOD_EXPRESS = "express" as const;

export type OrderDeliveryMethod =
  | typeof DELIVERY_METHOD_PICKUP
  | typeof DELIVERY_METHOD_DELIVERY
  | typeof DELIVERY_METHOD_EXPRESS;

export function isOrderDeliveryMethod(value: unknown): value is OrderDeliveryMethod {
  return (
    value === DELIVERY_METHOD_PICKUP ||
    value === DELIVERY_METHOD_DELIVERY ||
    value === DELIVERY_METHOD_EXPRESS
  );
}

export function isDeliveryAddressMethod(value: string): boolean {
  return value === DELIVERY_METHOD_DELIVERY || value === DELIVERY_METHOD_EXPRESS;
}

export function areDiscountsAllowedForDeliveryMethod(value: string): boolean {
  return isOrderDeliveryMethod(value);
}

export function formatDeliveryMethodLabel(value: string): string {
  if (value === DELIVERY_METHOD_PICKUP) return "Самовывоз";
  if (value === DELIVERY_METHOD_DELIVERY) return "Доставка";
  if (value === DELIVERY_METHOD_EXPRESS) return "Экспресс";
  return value;
}
