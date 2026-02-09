import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
          setSubmitError("Откройте мини-апп внутри Telegram, чтобы оформить заказ.");
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
      <div className="py-6 text-center">
        <div className="empty-cart-stage" aria-hidden="true">
          <span className="empty-cart-emoji">🛒</span>
        </div>

        <div className="text-lg font-semibold leading-tight text-slate-100">Корзина пуста</div>
        <div className="mt-2 text-sm leading-[1.35] text-slate-400">
          Добавьте товары из каталога.
        </div>
        <Link
          to="/"
          className="mt-4 inline-flex rounded-xl bg-[#2f80ff] px-4 py-2 text-sm font-semibold text-white hover:bg-[#2370e3]"
        >
          Перейти в каталог
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-lg font-semibold leading-tight text-slate-100">Корзина</div>

      <div className="space-y-3">
        {state.cart.map((item) => (
          <div
            key={item.productId}
            className="rounded-2xl border border-white/10 bg-[#252a31] p-4"
          >
            <div className="flex items-start gap-3">
              {item.imageUrl ? (
                <img
                  src={item.imageUrl}
                  alt={item.title}
                  loading="lazy"
                  className="h-16 w-16 shrink-0 rounded-xl object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-[#2b3139] text-[10px] font-semibold uppercase text-slate-500">
                  Photo
                </div>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{item.title}</div>
                    <div className="mt-1 text-xs text-slate-400">
                      {formatPriceRub(item.price)}
                      {" / \u0448\u0442"}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="text-xs font-semibold text-rose-600 hover:text-rose-700"
                    onClick={() =>
                      dispatch({ type: "cart/remove", productId: item.productId })
                    }
                  >
                    {"\u0423\u0434\u0430\u043b\u0438\u0442\u044c"}
                  </button>
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="h-9 w-9 rounded-xl border border-white/10 bg-[#252a31] text-sm font-semibold hover:bg-[#303743] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={submitting}
                      onClick={() =>
                        dispatch({ type: "cart/dec", productId: item.productId })
                      }
                    >
                      -
                    </button>
                    <div className="min-w-10 text-center text-sm font-semibold">
                      {item.qty}
                    </div>
                    <button
                      type="button"
                      className="h-9 w-9 rounded-xl border border-white/10 bg-[#252a31] text-sm font-semibold hover:bg-[#303743] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={submitting}
                      onClick={() =>
                        dispatch({ type: "cart/inc", productId: item.productId })
                      }
                    >
                      +
                    </button>
                  </div>
                  <div className="text-sm font-semibold">
                    {formatPriceRub(item.price * item.qty)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-white/10 bg-[#252a31] p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-400">Итого</div>
          <div className="text-lg font-semibold leading-tight text-slate-100">{formatPriceRub(total)}</div>
        </div>

        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-semibold text-slate-400">
              Способ получения
            </span>
            <select
              className="h-10 rounded-xl border border-white/10 bg-[#252a31] px-3 text-sm"
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
            <label className="grid gap-1 text-sm">
              <span className="text-xs font-semibold text-slate-400">
                Ваш адрес <span className="text-rose-600">*</span>
              </span>
              <input
                className="h-10 rounded-xl border border-white/10 bg-[#252a31] px-3 text-sm"
                value={address}
                disabled={submitting}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Улица, дом"
              />
            </label>
          ) : null}

          <label className="grid gap-1 text-sm">
            <span className="text-xs font-semibold text-slate-400">Комментарий</span>
            <textarea
              className="min-h-20 rounded-xl border border-white/10 bg-[#252a31] px-3 py-2 text-sm"
              value={comment}
              disabled={submitting}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Опционально"
            />
          </label>
        </div>

        {submitError ? (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
            {submitError}
          </div>
        ) : null}

        <button
          type="button"
          className="mt-4 w-full rounded-xl bg-[#2f80ff] px-4 py-3 text-sm font-semibold text-white hover:bg-[#2370e3] disabled:cursor-not-allowed disabled:bg-slate-600"
          disabled={!canSubmit}
          onClick={() => void submitOrder()}
        >
          {submitting ? "Отправляем..." : "Оформить"}
        </button>

        {!state.city ? (
          <div className="mt-2 text-xs text-slate-500">
            Для оформления выберите город в каталоге.
          </div>
        ) : null}
      </div>
    </div>
  );
}

