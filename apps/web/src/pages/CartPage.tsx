import { useMemo, useState } from "react";
import { API_BASE_URL } from "../config";
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

      const res = await fetch(`${API_BASE_URL}/api/order`, {
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

      await notify(
        `Заказ создан.\nID: ${parsed.orderId}\nУведомление: ${parsed.notified ? "отправлено" : "не отправлено"}`,
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
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
        <div className="text-lg font-semibold">Корзина пуста</div>
        <div className="mt-2 text-sm text-slate-600">
          Добавьте товары из каталога.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-lg font-semibold">Корзина</div>

      <div className="space-y-3">
        {state.cart.map((item) => (
          <div
            key={item.productId}
            className="rounded-2xl border border-slate-200 bg-white p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">{item.title}</div>
                <div className="mt-1 text-xs text-slate-600">
                  {formatPriceRub(item.price)} / шт
                </div>
              </div>
              <button
                type="button"
                className="text-xs font-semibold text-rose-600 hover:text-rose-700"
                onClick={() =>
                  dispatch({ type: "cart/remove", productId: item.productId })
                }
              >
                Удалить
              </button>
            </div>

            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="h-9 w-9 rounded-xl border border-slate-200 bg-white text-sm font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={submitting}
                  onClick={() =>
                    dispatch({ type: "cart/dec", productId: item.productId })
                  }
                >
                  −
                </button>
                <div className="min-w-10 text-center text-sm font-semibold">
                  {item.qty}
                </div>
                <button
                  type="button"
                  className="h-9 w-9 rounded-xl border border-slate-200 bg-white text-sm font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
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
        ))}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-600">Итого</div>
          <div className="text-lg font-semibold">{formatPriceRub(total)}</div>
        </div>

        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-semibold text-slate-600">
              Способ получения
            </span>
            <select
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm"
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
              <span className="text-xs font-semibold text-slate-600">
                Ваш адрес <span className="text-rose-600">*</span>
              </span>
              <input
                className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm"
                value={address}
                disabled={submitting}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Улица, дом"
              />
            </label>
          ) : null}

          <label className="grid gap-1 text-sm">
            <span className="text-xs font-semibold text-slate-600">Комментарий</span>
            <textarea
              className="min-h-20 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
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
          className="mt-4 w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
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

