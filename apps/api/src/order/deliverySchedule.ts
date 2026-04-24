export type DeliveryCitySlug = "vvo" | "blg";

export const BLG_DELIVERY_TIME_SLOTS = [
  "14:00-16:00",
  "16:00-18:00",
  "18:00-20:00",
  "20:00-22:00",
  "22:00-00:00",
] as const;
export const BLG_DELIVERY_FEE_RUB = 150;
export const BLG_FREE_DELIVERY_THRESHOLD_RUB = 1500;
export const BLG_ORDER_TIME_SLOT_CUTOFF_MINUTES = 12 * 60;

export function getBlgDeliveryFeeRub(orderSubtotalRub: number): number {
  return orderSubtotalRub >= BLG_FREE_DELIVERY_THRESHOLD_RUB ? 0 : BLG_DELIVERY_FEE_RUB;
}

const CITY_UTC_OFFSET_MINUTES: Record<DeliveryCitySlug, number> = {
  vvo: 10 * 60,
  blg: 9 * 60,
};

export function getTodayIsoDateForCity(
  citySlug: DeliveryCitySlug,
  nowMs: number = Date.now(),
): string {
  const adjusted = new Date(nowMs + CITY_UTC_OFFSET_MINUTES[citySlug] * 60_000);
  const year = adjusted.getUTCFullYear();
  const month = String(adjusted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(adjusted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getNextIsoDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;

  const next = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1),
  );
  const year = next.getUTCFullYear();
  const month = String(next.getUTCMonth() + 1).padStart(2, "0");
  const day = String(next.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function getMinutesOfDayForCity(
  citySlug: DeliveryCitySlug,
  nowMs: number = Date.now(),
): number {
  const adjusted = new Date(nowMs + CITY_UTC_OFFSET_MINUTES[citySlug] * 60_000);
  return adjusted.getUTCHours() * 60 + adjusted.getUTCMinutes();
}

export function getMinDeliveryDateForCity(
  citySlug: DeliveryCitySlug,
  nowMs: number = Date.now(),
): string {
  const today = getTodayIsoDateForCity(citySlug, nowMs);
  if (citySlug !== "blg") return today;

  const hasOpenSlotsToday = BLG_DELIVERY_TIME_SLOTS.some((deliveryTimeSlot) =>
    isDeliveryTimeSlotOpen({
      citySlug,
      deliveryDate: today,
      deliveryTimeSlot,
      cutoffMinutesBeforeStart: BLG_ORDER_TIME_SLOT_CUTOFF_MINUTES,
      nowMs,
    }),
  );

  return hasOpenSlotsToday ? today : getNextIsoDate(today);
}

export function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function parseDeliveryTimeSlot(
  slot: string,
): { startMinutes: number; endMinutes: number } | null {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(slot);
  if (!match) return null;

  const startHours = Number(match[1]);
  const startMinutes = Number(match[2]);
  const endHours = Number(match[3]);
  const endMinutes = Number(match[4]);

  if (
    !Number.isInteger(startHours) ||
    !Number.isInteger(startMinutes) ||
    !Number.isInteger(endHours) ||
    !Number.isInteger(endMinutes)
  ) {
    return null;
  }

  return {
    startMinutes: startHours * 60 + startMinutes,
    endMinutes: endHours * 60 + endMinutes,
  };
}

export function isDeliveryTimeSlotOpen(params: {
  citySlug: DeliveryCitySlug;
  deliveryDate: string;
  deliveryTimeSlot: string;
  cutoffMinutesBeforeStart?: number;
  nowMs?: number;
}): boolean {
  if (params.citySlug !== "blg") return true;

  const nowMs = params.nowMs ?? Date.now();
  const parsedSlot = parseDeliveryTimeSlot(params.deliveryTimeSlot);
  const parsedDate = parseIsoDate(params.deliveryDate);
  if (!parsedSlot || !parsedDate) return false;

  const cutoffMinutesBeforeStart = params.cutoffMinutesBeforeStart ?? 60;
  const slotStartHours = Math.floor(parsedSlot.startMinutes / 60);
  const slotStartMinutes = parsedSlot.startMinutes % 60;
  const slotStartMs =
    Date.UTC(
      parsedDate.year,
      parsedDate.month - 1,
      parsedDate.day,
      slotStartHours,
      slotStartMinutes,
    ) - CITY_UTC_OFFSET_MINUTES[params.citySlug] * 60_000;
  const cutoffMs = slotStartMs - cutoffMinutesBeforeStart * 60_000;

  return nowMs < cutoffMs;
}

export function extractDeliveryScheduleFromComment(comment: string | null): {
  deliveryDate: string | null;
  deliveryTimeSlot: string | null;
} {
  if (!comment) {
    return { deliveryDate: null, deliveryTimeSlot: null };
  }

  const dateMatch = /(?:^|\n)Дата доставки:\s*(\d{2})\.(\d{2})\.(\d{4})(?:\n|$)/.exec(comment);
  const slotMatch = /(?:^|\n)Время доставки:\s*([0-2]\d:\d{2}-[0-2]\d:\d{2})(?:\n|$)/.exec(comment);

  const deliveryDate = dateMatch
    ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`
    : null;
  const deliveryTimeSlot = slotMatch?.[1] ?? null;

  return {
    deliveryDate: deliveryDate && isValidIsoDate(deliveryDate) ? deliveryDate : null,
    deliveryTimeSlot,
  };
}

export function isCancellationLockedByDeliveryWindow(params: {
  citySlug: DeliveryCitySlug | null;
  comment: string | null;
  nowMs?: number;
}): boolean {
  if (params.citySlug !== "blg") return false;

  const schedule = extractDeliveryScheduleFromComment(params.comment);
  if (!schedule.deliveryDate || !schedule.deliveryTimeSlot) return false;

  const slotParams: Parameters<typeof isDeliveryTimeSlotOpen>[0] = {
    citySlug: params.citySlug,
    deliveryDate: schedule.deliveryDate,
    deliveryTimeSlot: schedule.deliveryTimeSlot,
  };
  if (typeof params.nowMs === "number") {
    slotParams.nowMs = params.nowMs;
  }

  return !isDeliveryTimeSlotOpen(slotParams);
}
