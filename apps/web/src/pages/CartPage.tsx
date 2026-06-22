import { CalendarDays, Minus, Plus, ShoppingBag } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, apiGet } from "../api/client";
import { ProductImagePreview } from "../components/ProductImagePreview";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { buildApiUrl } from "../config";
import {
  calculateCartPromotionDiscount,
  type ActivePromotionRule,
  type ActivePromotionsResponse,
} from "../promotions/cartPromotions";
import {
  getOrderEditRemainingMs,
  useAppState,
  type City,
} from "../state/AppStateProvider";
import { useTelegram } from "../telegram/TelegramProvider";

function formatPriceRub(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

type OrderApiSuccess = {
  ok: true;
  orderId: string;
  notified: boolean;
};

type OrderApiError = {
  ok: false;
  error: { code: string; message: string };
};

type ReferralOverviewBalance = {
  pointsBalance: number;
  rewardPoints?: {
    pointsExpireAfterMonths?: number;
    pointsMaxSpendPercent?: number;
  };
};

const DEFAULT_POINTS_EXPIRE_AFTER_MONTHS = 3;
const DEFAULT_POINTS_MAX_SPEND_PERCENT = 50;
const BLG_JUNE_2026_DELIVERY_TIME_SLOTS = [
  "13:00-15:00",
  "15:00-17:00",
  "17:00-19:00",
  "19:00-21:00",
  "21:00-23:00",
  "23:00-00:00",
] as const;

const BLG_WEEKDAY_DELIVERY_TIME_SLOTS = [
  "18:00-20:00",
  "20:00-22:00",
  "22:00-00:00",
] as const;

const BLG_WEEKEND_DELIVERY_TIME_SLOTS = [
  "14:00-16:00",
  "16:00-18:00",
  "18:00-20:00",
  "20:00-22:00",
  "22:00-00:00",
] as const;

type DeliveryTimeSlot =
  | (typeof BLG_JUNE_2026_DELIVERY_TIME_SLOTS)[number]
  | (typeof BLG_WEEKEND_DELIVERY_TIME_SLOTS)[number];

const BLG_ORDER_CUTOFF_BY_TIME_SLOT: Record<
  DeliveryTimeSlot,
  { dayOffset: number; minutesOfDay: number }
> = {
  "13:00-15:00": { dayOffset: 0, minutesOfDay: 0 },
  "15:00-17:00": { dayOffset: 0, minutesOfDay: 15 * 60 },
  "17:00-19:00": { dayOffset: 0, minutesOfDay: 17 * 60 },
  "19:00-21:00": { dayOffset: 0, minutesOfDay: 19 * 60 },
  "21:00-23:00": { dayOffset: 0, minutesOfDay: 21 * 60 },
  "23:00-00:00": { dayOffset: 0, minutesOfDay: 23 * 60 },
  "14:00-16:00": { dayOffset: 0, minutesOfDay: 0 },
  "16:00-18:00": { dayOffset: 0, minutesOfDay: 16 * 60 },
  "18:00-20:00": { dayOffset: 0, minutesOfDay: 18 * 60 },
  "20:00-22:00": { dayOffset: 0, minutesOfDay: 20 * 60 },
  "22:00-00:00": { dayOffset: 0, minutesOfDay: 22 * 60 },
};
const BLG_DELIVERY_FEE_RUB = 150;
const BLG_FREE_DELIVERY_THRESHOLD_RUB = 1500;
const DELIVERY_FIELD_HIGHLIGHT_CLASS_NAME =
  "border-sky-300/70 focus:ring-sky-200/70 focus-visible:ring-sky-200/70";

const CITY_UTC_OFFSET_MINUTES: Record<City, number> = {
  vvo: 10 * 60,
  blg: 9 * 60,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOrderApiResponse(value: unknown): OrderApiSuccess | OrderApiError {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return {
      ok: false,
      error: { code: "BAD_RESPONSE", message: "Invalid API response" },
    };
  }

  if (value.ok === true) {
    const orderId = value.orderId;
    const notified = value.notified;
    if (typeof orderId === "string" && typeof notified === "boolean") {
      return { ok: true, orderId, notified };
    }
    return {
      ok: false,
      error: { code: "BAD_RESPONSE", message: "Invalid API response" },
    };
  }

  const error = value.error;
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }

  return { ok: false, error: { code: "BAD_RESPONSE", message: "Invalid API response" } };
}

function getTodayIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTodayIsoDateForCity(city: City | null, nowMs: number = Date.now()): string {
  if (!city) return getTodayIsoDate();

  const offsetMinutes = CITY_UTC_OFFSET_MINUTES[city];
  const adjusted = new Date(nowMs + offsetMinutes * 60_000);
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

function isWeekendIsoDate(value: string): boolean {
  const parsed = parseIsoDate(value);
  if (!parsed) return false;

  const dayOfWeek = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}

function isBlgJune2026DeliveryScheduleDate(value: string): boolean {
  const parsed = parseIsoDate(value);
  return parsed?.year === 2026 && parsed.month === 6;
}

function getBlgDeliveryTimeSlotsForDate(deliveryDate: string): readonly DeliveryTimeSlot[] {
  if (isBlgJune2026DeliveryScheduleDate(deliveryDate)) {
    return BLG_JUNE_2026_DELIVERY_TIME_SLOTS;
  }

  return isWeekendIsoDate(deliveryDate)
    ? BLG_WEEKEND_DELIVERY_TIME_SLOTS
    : BLG_WEEKDAY_DELIVERY_TIME_SLOTS;
}

function getCityLocalDateTimeMs(params: {
  city: City;
  parsedDate: { year: number; month: number; day: number };
  dayOffset?: number;
  minutesOfDay: number;
}): number {
  const hours = Math.floor(params.minutesOfDay / 60);
  const minutes = params.minutesOfDay % 60;

  return (
    Date.UTC(
      params.parsedDate.year,
      params.parsedDate.month - 1,
      params.parsedDate.day + (params.dayOffset ?? 0),
      hours,
      minutes,
    ) -
    CITY_UTC_OFFSET_MINUTES[params.city] * 60_000
  );
}

function formatDeliveryDatePickerValue(value: string): string {
  if (!value) return "";

  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${day}.${month}.${year}`;
}

function getMinDeliveryDateForCity(city: City | null, nowMs: number = Date.now()): string {
  const today = getTodayIsoDateForCity(city, nowMs);
  if (city !== "blg") return today;

  const hasOpenSlotsToday = getBlgDeliveryTimeSlotsForDate(today).some((slot) =>
    isDeliveryTimeSlotAvailable({
      city,
      deliveryDate: today,
      slot,
      nowMs,
    }),
  );

  return hasOpenSlotsToday ? today : getNextIsoDate(today);
}

function isDeliveryTimeSlotAvailable(params: {
  city: City | null;
  deliveryDate: string;
  slot: DeliveryTimeSlot;
  nowMs: number;
}): boolean {
  if (params.city !== "blg") return true;
  if (params.deliveryDate.trim().length === 0) return true;

  const parsedDate = parseIsoDate(params.deliveryDate);
  const cutoff = BLG_ORDER_CUTOFF_BY_TIME_SLOT[params.slot];
  if (!parsedDate || !cutoff) return false;

  const cutoffMs = getCityLocalDateTimeMs({
    city: params.city,
    parsedDate,
    dayOffset: cutoff.dayOffset,
    minutesOfDay: cutoff.minutesOfDay,
  });

  return params.nowMs < cutoffMs;
}

function getBlgDeliveryFeeRub(itemsSubtotalRub: number): number {
  return itemsSubtotalRub >= BLG_FREE_DELIVERY_THRESHOLD_RUB ? 0 : BLG_DELIVERY_FEE_RUB;
}

export function CartPage() {
  const { state, dispatch } = useAppState();
  const { isTelegram, webApp } = useTelegram();
  const deliveryDateInputRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pointsBalance, setPointsBalance] = useState(0);
  const [pointsEnabled, setPointsEnabled] = useState(false);
  const [pointsLoading, setPointsLoading] = useState(false);
  const [pointsError, setPointsError] = useState<string | null>(null);
  const [pointsExpireAfterMonths, setPointsExpireAfterMonths] = useState(
    DEFAULT_POINTS_EXPIRE_AFTER_MONTHS,
  );
  const [pointsMaxSpendPercent, setPointsMaxSpendPercent] = useState(
    DEFAULT_POINTS_MAX_SPEND_PERCENT,
  );
  const [activePromotionRules, setActivePromotionRules] = useState<ActivePromotionRule[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const cityToday = useMemo(() => getTodayIsoDateForCity(state.city, nowMs), [state.city, nowMs]);
  const minDeliveryDate = useMemo(
    () => getMinDeliveryDateForCity(state.city, nowMs),
    [state.city, nowMs],
  );
  const checkoutDraft = state.checkoutDraft;
  const orderEditSession = state.orderEditSession;
  const editSessionExpired = orderEditSession
    ? getOrderEditRemainingMs(orderEditSession, nowMs) <= 0
    : false;
  const showBlgDeliverySchedule =
    state.city === "blg" && checkoutDraft.deliveryMethod === "delivery";
  const availableDeliveryTimeSlots = useMemo(
    () =>
      getBlgDeliveryTimeSlotsForDate(checkoutDraft.deliveryDate).filter((slot) =>
        isDeliveryTimeSlotAvailable({
          city: state.city,
          deliveryDate: checkoutDraft.deliveryDate,
          slot,
          nowMs,
        }),
      ),
    [checkoutDraft.deliveryDate, nowMs, state.city],
  );
  const selectedDateHasNoAvailableSlots =
    showBlgDeliverySchedule &&
    checkoutDraft.deliveryDate.trim().length > 0 &&
    availableDeliveryTimeSlots.length === 0;
  const selectedDeliveryDateIsBeforeMin =
    showBlgDeliverySchedule &&
    checkoutDraft.deliveryDate.trim().length > 0 &&
    checkoutDraft.deliveryDate < minDeliveryDate;
  const itemsTotal = useMemo(() => {
    return state.cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  }, [state.cart]);
  const showBlgDeliveryFeeCard =
    state.city === "blg" && checkoutDraft.deliveryMethod === "delivery";
  const deliveryFee =
    showBlgDeliveryFeeCard
      ? getBlgDeliveryFeeRub(itemsTotal)
      : 0;
  const total = itemsTotal + deliveryFee;
  const promotionDiscount = useMemo(() => {
    return calculateCartPromotionDiscount({
      cart: state.cart,
      rules: activePromotionRules,
      nowMs,
    });
  }, [activePromotionRules, nowMs, state.cart]);
  const promotionDiscountAmount = Math.min(total, promotionDiscount.discountAmount);
  const totalAfterPromotionDiscount = Math.max(0, total - promotionDiscountAmount);

  const maxPointsByOrderTotal = useMemo(() => {
    return Math.max(0, Math.floor((totalAfterPromotionDiscount * pointsMaxSpendPercent) / 100));
  }, [pointsMaxSpendPercent, totalAfterPromotionDiscount]);

  const maxPointsToSpend = useMemo(() => {
    return Math.max(0, Math.min(pointsBalance, maxPointsByOrderTotal));
  }, [maxPointsByOrderTotal, pointsBalance]);

  const fixedEditPointsToSpend = orderEditSession
    ? Math.max(0, Math.min(orderEditSession.discountAmount, maxPointsByOrderTotal))
    : 0;
  const pointsToSpend = orderEditSession
    ? fixedEditPointsToSpend
    : pointsEnabled
      ? maxPointsToSpend
      : 0;
  const totalToPay = Math.max(0, totalAfterPromotionDiscount - pointsToSpend);
  const checkoutHasDiscount = totalToPay < total;
  const checkoutButtonLabel = submitting
    ? orderEditSession
      ? "Обновляем..."
      : "Отправляем..."
    : orderEditSession
      ? "Обновить заказ"
      : "К оформлению";

  function openDeliveryDatePicker(): void {
    const input = deliveryDateInputRef.current;
    if (!input || submitting) return;

    if (typeof input.showPicker === "function") {
      input.showPicker();
      return;
    }

    input.focus();
    input.click();
  }

  async function loadPointsBalance(): Promise<void> {
    setPointsLoading(true);
    setPointsError(null);
    try {
      const data = await apiGet<ReferralOverviewBalance>(
        "/api/referrals/overview?limit=1&offset=0",
      );
      setPointsBalance(Math.max(0, Math.trunc(data.pointsBalance)));

      const nextExpireAfterMonths = data.rewardPoints?.pointsExpireAfterMonths;
      if (
        typeof nextExpireAfterMonths === "number" &&
        Number.isFinite(nextExpireAfterMonths) &&
        nextExpireAfterMonths > 0
      ) {
        setPointsExpireAfterMonths(Math.trunc(nextExpireAfterMonths));
      }

      const nextMaxSpendPercent = data.rewardPoints?.pointsMaxSpendPercent;
      if (
        typeof nextMaxSpendPercent === "number" &&
        Number.isFinite(nextMaxSpendPercent) &&
        nextMaxSpendPercent > 0 &&
        nextMaxSpendPercent <= 100
      ) {
        setPointsMaxSpendPercent(Math.trunc(nextMaxSpendPercent));
      }
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        if (
          e.code === "TG_INIT_DATA_REQUIRED" ||
          e.code === "TG_INIT_DATA_INVALID" ||
          e.code === "TG_INIT_DATA_EXPIRED"
        ) {
          setPointsBalance(0);
          setPointsEnabled(false);
          return;
        }
        setPointsError(e.message);
        return;
      }

      setPointsError(e instanceof Error ? e.message : "Failed to load points balance");
    } finally {
      setPointsLoading(false);
    }
  }

  useEffect(() => {
    void loadPointsBalance();
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!state.city) {
      setActivePromotionRules([]);
      return () => {
        cancelled = true;
      };
    }

    const query = new URLSearchParams({ citySlug: state.city }).toString();
    apiGet<ActivePromotionsResponse>(`/api/promotions/active?${query}`, { withTelegramAuth: false })
      .then((data) => {
        if (cancelled) return;
        setActivePromotionRules(data.items);
      })
      .catch(() => {
        if (cancelled) return;
        setActivePromotionRules([]);
      });

    return () => {
      cancelled = true;
    };
  }, [state.city]);

  useEffect(() => {
    if (orderEditSession) {
      setPointsEnabled(false);
      return;
    }
    if (maxPointsToSpend > 0) return;
    setPointsEnabled(false);
  }, [maxPointsToSpend, orderEditSession]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!checkoutDraft.deliveryTimeSlot) return;
    if (availableDeliveryTimeSlots.includes(checkoutDraft.deliveryTimeSlot as DeliveryTimeSlot)) {
      return;
    }
    dispatch({
      type: "checkout/set",
      patch: { deliveryTimeSlot: "" },
    });
  }, [availableDeliveryTimeSlots, checkoutDraft.deliveryTimeSlot, dispatch]);

  useEffect(() => {
    if (!showBlgDeliverySchedule) return;
    if (!checkoutDraft.deliveryDate) return;
    if (checkoutDraft.deliveryDate >= minDeliveryDate) return;

    dispatch({
      type: "checkout/set",
      patch: { deliveryDate: "", deliveryTimeSlot: "" },
    });
  }, [checkoutDraft.deliveryDate, dispatch, minDeliveryDate, showBlgDeliverySchedule]);

  const hasRequiredBlgDeliverySchedule =
    !showBlgDeliverySchedule ||
    (checkoutDraft.deliveryDate.trim().length > 0 &&
      checkoutDraft.deliveryTimeSlot.trim().length > 0 &&
      !selectedDateHasNoAvailableSlots &&
      !selectedDeliveryDateIsBeforeMin);

  const canSubmit =
    state.cart.length > 0 &&
    state.city !== null &&
    !submitting &&
    !editSessionExpired &&
    hasRequiredBlgDeliverySchedule &&
    (checkoutDraft.deliveryMethod !== "delivery" ||
      checkoutDraft.address.trim().length > 0);

  async function notify(message: string): Promise<void> {
    if (isTelegram) {
      try {
        webApp.showAlert(message);
        return;
      } catch {
        // fallthrough
      }
    }
    alert(message);
  }

  function updateCheckoutDraft(
    patch: Partial<{
      deliveryMethod: "pickup" | "delivery";
      address: string;
      comment: string;
      deliveryDate: string;
      deliveryTimeSlot: string;
    }>,
  ): void {
    dispatch({ type: "checkout/set", patch });
  }

  async function submitOrder(): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);

    try {
      if (!state.city) {
        setSubmitError("Сначала выберите город в каталоге.");
        return;
      }

      if (orderEditSession && editSessionExpired) {
        setSubmitError("Р’СЂРµРјСЏ РЅР° СЂРµРґР°РєС‚РёСЂРѕРІР°РЅРёРµ РёСЃС‚РµРєР»Рѕ. Р—Р°РїСѓСЃС‚РёС‚Рµ РµРіРѕ Р·Р°РЅРѕРІРѕ РІ СѓРїСЂР°РІР»РµРЅРёРё Р·Р°РєР°Р·Р°РјРё.");
        return;
      }

      const trimmedAddress = checkoutDraft.address.trim();
      if (showBlgDeliverySchedule && checkoutDraft.deliveryDate.trim().length === 0) {
        setSubmitError("Р’С‹Р±РµСЂРёС‚Рµ РґР°С‚Сѓ РґРѕСЃС‚Р°РІРєРё.");
        return;
      }

      if (showBlgDeliverySchedule && checkoutDraft.deliveryDate < minDeliveryDate) {
        setSubmitError(
          minDeliveryDate > cityToday
            ? "На выбранную дату свободных слотов уже нет. Выберите другую дату."
            : "Выберите корректную дату доставки.",
        );
        return;
      }

      if (showBlgDeliverySchedule && selectedDateHasNoAvailableSlots) {
        setSubmitError(
          "РќР° РІС‹Р±СЂР°РЅРЅСѓСЋ РґР°С‚Сѓ СЃРІРѕР±РѕРґРЅС‹С… СЃР»РѕС‚РѕРІ СѓР¶Рµ РЅРµС‚. Р’С‹Р±РµСЂРёС‚Рµ РґСЂСѓРіСѓСЋ РґР°С‚Сѓ.",
        );
        return;
      }

      if (showBlgDeliverySchedule && checkoutDraft.deliveryTimeSlot.trim().length === 0) {
        setSubmitError("Р’С‹Р±РµСЂРёС‚Рµ РІСЂРµРјСЏ РґРѕСЃС‚Р°РІРєРё.");
        return;
      }
      if (checkoutDraft.deliveryMethod === "delivery" && !trimmedAddress) {
        setSubmitError("Укажите адрес для доставки.");
        return;
      }

      if (
        showBlgDeliverySchedule &&
        checkoutDraft.deliveryTimeSlot.trim().length > 0 &&
        checkoutDraft.deliveryDate.trim().length === 0
      ) {
        setSubmitError("Выберите дату доставки.");
        return;
      }

      if (
        showBlgDeliverySchedule &&
        selectedDateHasNoAvailableSlots &&
        checkoutDraft.deliveryTimeSlot.trim().length > 0
      ) {
        setSubmitError(
          selectedDateHasNoAvailableSlots
            ? "На выбранную дату свободных слотов уже нет. Выберите другую дату."
            : "Выберите время доставки.",
        );
        return;
      }

      const pointsToSpendForOrder = orderEditSession
        ? fixedEditPointsToSpend
        : pointsEnabled
          ? maxPointsToSpend
          : 0;
      const tgInitData = window.Telegram?.WebApp?.initData ?? "";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (tgInitData) {
        headers["x-telegram-init-data"] = tgInitData;
      } else if (import.meta.env.DEV) {
        headers["x-dev-admin"] = "1";
      }
      const requestPath = orderEditSession
        ? `/api/orders/${orderEditSession.orderId}/edit`
        : "/api/order";

      const res = await fetch(buildApiUrl(requestPath), {
        method: orderEditSession ? "PUT" : "POST",
        headers,
        body: JSON.stringify({
          citySlug: state.city,
          deliveryMethod: checkoutDraft.deliveryMethod,
          address: trimmedAddress || null,
          comment: checkoutDraft.comment.trim() || null,
          deliveryDate: showBlgDeliverySchedule ? checkoutDraft.deliveryDate || null : null,
          deliveryTimeSlot: showBlgDeliverySchedule
            ? checkoutDraft.deliveryTimeSlot || null
            : null,
          pointsToSpend: pointsToSpendForOrder,
          items: state.cart.map((x) => ({ productId: x.productId, qty: x.qty })),
        }),
      });

      const json = (await res.json().catch(() => null)) as unknown;
      const parsed = parseOrderApiResponse(json);

      if (!res.ok || parsed.ok === false) {
        const code = parsed.ok === false ? parsed.error.code : "HTTP_ERROR";
        const message = parsed.ok === false ? parsed.error.message : "Request failed";

        if ((code === "TG_INIT_DATA_REQUIRED" || code === "TG_INIT_DATA_INVALID") && !tgInitData) {
          setSubmitError("Откройте мини-приложение внутри Telegram, чтобы оформить заказ.");
        } else {
          setSubmitError(message);
        }
        return;
      }

      if (orderEditSession) {
        dispatch({ type: "order-edit/complete" });
        void loadPointsBalance();
      } else {
        dispatch({ type: "cart/clear" });
        dispatch({ type: "checkout/reset" });
      }

      if (!orderEditSession && pointsToSpendForOrder > 0) {
        setPointsBalance((prev) => Math.max(0, prev - pointsToSpendForOrder));
      }
      setPointsEnabled(false);

      await notify(
        orderEditSession
          ? "Заказ обновлён.\nПередаём админу..."
          : "Заказ создан.\nПередаём админу...",
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Network error";
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (state.cart.length === 0) {
    return (
      <Card className="overflow-hidden border-border/70 bg-card">
        <CardContent className="flex flex-col items-center py-10 text-center">
          <div className="mb-3 grid h-16 w-16 place-items-center rounded-full bg-primary/15 text-primary">
            <ShoppingBag className="h-8 w-8" />
          </div>
          <div className="text-lg font-semibold">Корзина пуста</div>
          <Button asChild className="mt-5">
            <Link to="/">Перейти в каталог</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Корзина</h2>
        <Badge variant="secondary">{state.cart.length} позиций</Badge>
      </div>

      <div className="space-y-3">
        {state.cart.map((item) => (
          <Card key={item.productId} className="border-border/70 bg-card">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <ProductImagePreview
                  imageUrl={item.imageUrl}
                  alt={item.title}
                  loading="lazy"
                  targetWidth={160}
                  className="h-20 w-20 shrink-0 rounded-lg object-cover"
                  placeholderClassName="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{item.title}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {formatPriceRub(item.price)} / шт
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() =>
                        dispatch({ type: "cart/remove", productId: item.productId })
                      }
                    >
                      Удалить
                    </Button>
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-8 w-8"
                        disabled={submitting}
                        onClick={() =>
                          dispatch({ type: "cart/dec", productId: item.productId })
                        }
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <div className="min-w-9 text-center text-sm font-semibold">{item.qty}</div>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-8 w-8"
                        disabled={submitting}
                        onClick={() =>
                          dispatch({ type: "cart/inc", productId: item.productId })
                        }
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="text-sm font-semibold">
                      {formatPriceRub(item.price * item.qty)}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {showBlgDeliveryFeeCard ? (
          <Card className="border-border/70 bg-card">
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">Доставка</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Бесплатно от 1 500 ₽, иначе 150 ₽
                  </div>
                </div>
                <div className="text-sm font-semibold">
                  {deliveryFee === 0 ? "Бесплатно" : formatPriceRub(deliveryFee)}
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {promotionDiscountAmount > 0 ? (
          <Card className="border-emerald-300/40 bg-emerald-400/10">
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {promotionDiscount.title ?? "1+1=3"}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Бесплатно: {promotionDiscount.freeQty} шт. Считаем самые дешёвые товары.
                  </div>
                </div>
                <div className="shrink-0 text-sm font-semibold text-emerald-500">
                  -{formatPriceRub(promotionDiscountAmount)}
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card className="border-border/70 bg-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Оформление</CardTitle>
            <div className="text-right">
              {promotionDiscountAmount > 0 || pointsToSpend > 0 ? (
                <div className="text-xs text-muted-foreground line-through">
                  {formatPriceRub(total)}
                </div>
              ) : null}
              <div className="text-lg font-semibold">{formatPriceRub(totalToPay)}</div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          <label className="grid gap-1.5 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">Способ получения</span>
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
              value={checkoutDraft.deliveryMethod}
              disabled={submitting}
              onChange={(e) =>
                updateCheckoutDraft({
                  deliveryMethod: e.target.value === "delivery" ? "delivery" : "pickup",
                })
              }
            >
              <option value="pickup">Самовывоз</option>
              <option value="delivery">Доставка</option>
            </select>
          </label>

          {checkoutDraft.deliveryMethod === "delivery" ? (
            <div className="space-y-3">
              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-semibold text-muted-foreground">
                  Ваш адрес <span className="text-destructive">*</span>
                </span>
                <Input
                  className={DELIVERY_FIELD_HIGHLIGHT_CLASS_NAME}
                  value={checkoutDraft.address}
                  disabled={submitting}
                  onChange={(e) => updateCheckoutDraft({ address: e.target.value })}
                  placeholder="Улица, дом"
                />
              </label>

              {showBlgDeliverySchedule ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1.5 text-sm">
                    <span className="text-xs font-semibold text-muted-foreground">
                      Дата доставки
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={openDeliveryDatePicker}
                        className={`hidden h-10 flex-1 items-center gap-2 rounded-md border border-input bg-background px-3 text-left text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background sm:flex ${DELIVERY_FIELD_HIGHLIGHT_CLASS_NAME} ${
                          checkoutDraft.deliveryDate ? "text-foreground" : "text-muted-foreground"
                        } ${submitting ? "cursor-not-allowed opacity-50" : ""}`}
                      >
                        <span className="truncate">
                          {checkoutDraft.deliveryDate
                            ? formatDeliveryDatePickerValue(checkoutDraft.deliveryDate)
                            : "Выберите дату"}
                        </span>
                        <CalendarDays
                          className="ml-auto h-4 w-4 shrink-0 text-muted-foreground"
                          strokeWidth={2}
                        />
                      </button>

                      <Input
                        ref={deliveryDateInputRef}
                        className={`min-w-0 flex-1 sm:sr-only ${DELIVERY_FIELD_HIGHLIGHT_CLASS_NAME}`}
                        type="date"
                        value={checkoutDraft.deliveryDate}
                        min={minDeliveryDate}
                        required={showBlgDeliverySchedule}
                        disabled={submitting}
                        onChange={(e) =>
                          updateCheckoutDraft({
                            deliveryDate: e.target.value,
                            deliveryTimeSlot: e.target.value.trim().length
                              ? checkoutDraft.deliveryTimeSlot
                              : "",
                          })
                        }
                      />
                      {checkoutDraft.deliveryDate ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={submitting}
                          onClick={() =>
                            updateCheckoutDraft({
                              deliveryDate: "",
                              deliveryTimeSlot: "",
                            })
                          }
                        >
                          Сбросить
                        </Button>
                      ) : null}
                    </div>
                  </label>

                  <label className="grid gap-1.5 text-sm">
                    <span className="text-xs font-semibold text-muted-foreground">
                      Время доставки
                    </span>
                    <select
                      className={`h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background ${DELIVERY_FIELD_HIGHLIGHT_CLASS_NAME}`}
                      value={checkoutDraft.deliveryTimeSlot}
                      required={showBlgDeliverySchedule}
                      disabled={
                        submitting ||
                        checkoutDraft.deliveryDate.trim().length === 0 ||
                        selectedDateHasNoAvailableSlots
                      }
                      onChange={(e) =>
                        updateCheckoutDraft({ deliveryTimeSlot: e.target.value })
                      }
                    >
                      <option value="">
                        {checkoutDraft.deliveryDate.trim().length === 0
                          ? "Выберите время"
                          : selectedDateHasNoAvailableSlots
                            ? "Нет слотов"
                            : "Не выбрано"}
                      </option>
                      {availableDeliveryTimeSlots.map((slot) => (
                        <option key={slot} value={slot}>
                          {slot}
                        </option>
                      ))}
                    </select>
                    <span className="hidden">
                      Дату и время можно не указывать.
                    </span>
                    {selectedDateHasNoAvailableSlots ? (
                      <span className="text-xs text-muted-foreground">
                        На выбранную дату свободных слотов уже нет. Выберите другую дату.
                      </span>
                    ) : null}
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}

          <label className="grid gap-1.5 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">Комментарий</span>
            <Textarea
              value={checkoutDraft.comment}
              disabled={submitting}
              onChange={(e) => updateCheckoutDraft({ comment: e.target.value })}
              placeholder="Опционально"
            />
          </label>

          {orderEditSession ? (
            orderEditSession.discountAmount > 0 ? (
              <div className="space-y-2 rounded-md border border-border/70 bg-background/50 p-3">
                <div className="text-sm font-medium">
                  Скидка баллами при сохранении: -{formatPriceRub(pointsToSpend)}
                </div>
                <div className="text-xs text-muted-foreground">
                  Если сумма заказа станет меньше или сработает лимит {pointsMaxSpendPercent}%,
                  лишние баллы автоматически вернутся на баланс.
                </div>
              </div>
            ) : null
          ) : (
            <div className="space-y-2 rounded-md border border-border/70 bg-background/50 p-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-input"
                  checked={pointsEnabled}
                  disabled={submitting || pointsLoading || maxPointsToSpend <= 0}
                  onChange={(e) => setPointsEnabled(e.target.checked)}
                />
                <span>
                  Использовать баллы ({pointsBalance})
                  {maxPointsToSpend > 0
                    ? `, спишется до ${pointsToSpend || maxPointsToSpend}`
                    : ""}
                </span>
              </label>
              <div className="text-xs text-muted-foreground">
                Можно оплатить до {pointsMaxSpendPercent}% корзины. Баллы действуют{" "}
                {pointsExpireAfterMonths} мес.
              </div>
              {pointsToSpend > 0 ? (
                <div className="text-xs text-muted-foreground">
                  Скидка баллами: -{formatPriceRub(pointsToSpend)}. К оплате:{" "}
                  {formatPriceRub(totalToPay)}.
                </div>
              ) : null}
              {pointsError ? (
                <div className="text-xs text-destructive">
                  Баллы временно недоступны: {pointsError}
                </div>
              ) : null}
            </div>
          )}

          {submitError ? (
            <Alert variant="destructive">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}

          <Button
            type="button"
            className="grid h-14 w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-0 rounded-xl px-3 text-base font-bold"
            disabled={!canSubmit}
            onClick={() => void submitOrder()}
          >
            <span className="col-start-2 justify-self-center">{checkoutButtonLabel}</span>
            <span className="col-start-3 flex min-w-0 items-baseline justify-self-end gap-1.5 pl-2">
              <span className="shrink-0 text-base font-black leading-none">
                {formatPriceRub(totalToPay)}
              </span>
              {checkoutHasDiscount ? (
                <span className="shrink-0 text-xs font-semibold leading-none text-primary-foreground/55 line-through decoration-primary-foreground/60">
                  {formatPriceRub(total)}
                </span>
              ) : null}
            </span>
          </Button>

          {orderEditSession && editSessionExpired ? (
            <div className="text-xs text-destructive">
              Время редактирования истекло. Выйдите из режима и запустите его заново в
              управлении заказами.
            </div>
          ) : null}

          {!state.city ? (
            <div className="text-xs text-muted-foreground">
              Для оформления сначала выберите город в каталоге.
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

