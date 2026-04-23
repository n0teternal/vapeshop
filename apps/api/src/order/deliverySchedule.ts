export type DeliveryCitySlug = "vvo" | "blg";

export const BLG_DELIVERY_TIME_SLOTS = [
  "18:00-19:00",
  "19:00-20:00",
  "20:00-21:00",
] as const;
const BLG_TODAY_DELIVERY_DATE_CUTOFF_MINUTES = 20 * 60;

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

  return getMinutesOfDayForCity(citySlug, nowMs) >= BLG_TODAY_DELIVERY_DATE_CUTOFF_MINUTES
    ? getNextIsoDate(today)
    : today;
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
  if (params.deliveryDate !== getTodayIsoDateForCity(params.citySlug, nowMs)) {
    return true;
  }

  const parsedSlot = parseDeliveryTimeSlot(params.deliveryTimeSlot);
  if (!parsedSlot) return false;

  const cutoffMinutesBeforeStart = params.cutoffMinutesBeforeStart ?? 60;
  const nowMinutes = getMinutesOfDayForCity(params.citySlug, nowMs);
  const cutoffMinutes = parsedSlot.startMinutes - cutoffMinutesBeforeStart;
  return nowMinutes < cutoffMinutes;
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
