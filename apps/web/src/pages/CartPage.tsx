import { Minus, Plus, ShoppingBag } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { useAppState } from "../state/AppStateProvider";
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
};

const REFERRAL_OWNER_TG_USER_ID = 1208488286;

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

export function CartPage() {
  const { state, dispatch } = useAppState();
  const { isTelegram, webApp } = useTelegram();

  const [deliveryMethod, setDeliveryMethod] = useState<"pickup" | "delivery">(
    "delivery",
  );
  const [address, setAddress] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pointsBalance, setPointsBalance] = useState(0);
  const [pointsEnabled, setPointsEnabled] = useState(false);
  const [pointsLoading, setPointsLoading] = useState(false);
  const [pointsError, setPointsError] = useState<string | null>(null);
  const isReferralOwner = webApp.initDataUnsafe?.user?.id === REFERRAL_OWNER_TG_USER_ID;

  const total = useMemo(() => {
    return state.cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  }, [state.cart]);

  const maxPointsToSpend = useMemo(() => {
    return Math.max(0, Math.min(pointsBalance, Math.floor(total)));
  }, [pointsBalance, total]);

  const pointsToSpend = pointsEnabled ? maxPointsToSpend : 0;
  const totalToPay = Math.max(0, total - pointsToSpend);

  useEffect(() => {
    let cancelled = false;

    if (!isReferralOwner) {
      setPointsBalance(0);
      setPointsEnabled(false);
      setPointsLoading(false);
      setPointsError(null);
      return () => {
        cancelled = true;
      };
    }

    async function loadPointsBalance(): Promise<void> {
      setPointsLoading(true);
      setPointsError(null);
      try {
        const data = await apiGet<ReferralOverviewBalance>(
          "/api/referrals/overview?limit=1&offset=0",
        );
        if (!cancelled) {
          setPointsBalance(Math.max(0, Math.trunc(data.pointsBalance)));
        }
      } catch (e: unknown) {
        if (cancelled) return;

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
        if (!cancelled) {
          setPointsLoading(false);
        }
      }
    }

    void loadPointsBalance();

    return () => {
      cancelled = true;
    };
  }, [isReferralOwner]);

  useEffect(() => {
    if (maxPointsToSpend > 0) return;
    setPointsEnabled(false);
  }, [maxPointsToSpend]);

  const canSubmit =
    state.cart.length > 0 &&
    state.city !== null &&
    !submitting &&
    (deliveryMethod !== "delivery" || address.trim().length > 0);

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

  async function submitOrder(): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);

    try {
      if (!state.city) {
        setSubmitError("Сначала выберите город в каталоге.");
        return;
      }

      const trimmedAddress = address.trim();
      if (deliveryMethod === "delivery" && !trimmedAddress) {
        setSubmitError("Укажите адрес для доставки.");
        return;
      }

      const trimmedComment = comment.trim();
      const fullComment =
        deliveryMethod === "delivery"
          ? `Адрес: ${trimmedAddress}${trimmedComment ? `\n${trimmedComment}` : ""}`
          : trimmedComment
            ? trimmedComment
            : null;

      const pointsToSpendForOrder = pointsEnabled ? maxPointsToSpend : 0;
      const tgInitData = window.Telegram?.WebApp?.initData ?? "";

      const res = await fetch(buildApiUrl("/api/order"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-telegram-init-data": tgInitData,
        },
        body: JSON.stringify({
          citySlug: state.city,
          deliveryMethod,
          comment: fullComment,
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

      dispatch({ type: "cart/clear" });
      setAddress("");
      setComment("");
      if (pointsToSpendForOrder > 0) {
        setPointsBalance((prev) => Math.max(0, prev - pointsToSpendForOrder));
      }
      setPointsEnabled(false);

      await notify("Заказ создан.\nПередаём админу...");
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
          <p className="mt-2 max-w-[24ch] text-sm text-muted-foreground">
            Добавьте товары из каталога.
          </p>
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
      </div>

      <Card className="border-border/70 bg-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Оформление</CardTitle>
            <div className="text-right">
              {pointsToSpend > 0 ? (
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
              value={deliveryMethod}
              disabled={submitting}
              onChange={(e) =>
                setDeliveryMethod(e.target.value === "delivery" ? "delivery" : "pickup")
              }
            >
              <option value="pickup">Самовывоз</option>
              <option value="delivery">Доставка</option>
            </select>
          </label>

          {deliveryMethod === "delivery" ? (
            <label className="grid gap-1.5 text-sm">
              <span className="text-xs font-semibold text-muted-foreground">
                Ваш адрес <span className="text-destructive">*</span>
              </span>
              <Input
                value={address}
                disabled={submitting}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Улица, дом"
              />
            </label>
          ) : null}

          <label className="grid gap-1.5 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">Комментарий</span>
            <Textarea
              value={comment}
              disabled={submitting}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Опционально"
            />
          </label>

          {isReferralOwner ? (
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
                  {maxPointsToSpend > 0 ? `, спишется до ${pointsToSpend || maxPointsToSpend}` : ""}
                </span>
              </label>
              {pointsToSpend > 0 ? (
                <div className="text-xs text-muted-foreground">
                  Скидка баллами: -{formatPriceRub(pointsToSpend)}. К оплате: {formatPriceRub(totalToPay)}.
                </div>
              ) : null}
              {pointsError ? (
                <div className="text-xs text-destructive">Баллы временно недоступны: {pointsError}</div>
              ) : null}
            </div>
          ) : null}

          {submitError ? (
            <Alert variant="destructive">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}

          <Button
            type="button"
            className="w-full"
            disabled={!canSubmit}
            onClick={() => void submitOrder()}
          >
            {submitting ? "Отправляем..." : "Оформить"}
          </Button>

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
