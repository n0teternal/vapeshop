import { Minus, Plus, ShoppingBag } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
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

  const total = useMemo(() => {
    return state.cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  }, [state.cart]);

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
      <Card className="overflow-hidden border-border/70 bg-card/82">
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
          <Card key={item.productId} className="border-border/70 bg-card/82">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <ProductImagePreview
                  imageUrl={item.imageUrl}
                  alt={item.title}
                  loading="lazy"
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

      <Card className="border-border/70 bg-card/82">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Оформление</CardTitle>
            <div className="text-lg font-semibold">{formatPriceRub(total)}</div>
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
