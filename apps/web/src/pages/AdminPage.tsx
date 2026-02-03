import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, apiGet, apiPut } from "../api/client";

type AdminMe = {
  tgUserId: number;
  username: string | null;
  role: string;
};

type OrderStatus = "new" | "processing" | "done";

type OrderItem = {
  product_id: string | null;
  title: string | null;
  qty: number;
  unit_price: number;
};

type Order = {
  id: string;
  created_at: string;
  status: OrderStatus;
  city_id: number | null;
  city_slug: string | null;
  tg_user_id: number;
  tg_username: string | null;
  delivery_method: string;
  comment: string | null;
  total_price: number;
  items: OrderItem[];
};

function formatRub(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU");
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      {children}
    </div>
  );
}

function AdminOrdersView() {
  const [status, setStatus] = useState<OrderStatus>("new");
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextStatus: OrderStatus): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<Order[]>(`/api/admin/orders?status=${nextStatus}`);
      setOrders(data);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Ошибка загрузки";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(status);
  }, [status, load]);

  async function setOrderStatus(orderId: string, next: OrderStatus): Promise<void> {
    setError(null);
    try {
      await apiPut(`/api/admin/orders/${orderId}/status`, { status: next });
      await load(status);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Ошибка обновления статуса";
      setError(message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Заказы</div>
        <div className="flex items-center gap-2">
          <select
            className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold"
            value={status}
            disabled={loading}
            onChange={(e) => {
              const v = e.target.value;
              setStatus(v === "done" ? "done" : v === "processing" ? "processing" : "new");
            }}
          >
            <option value="new">new</option>
            <option value="processing">processing</option>
            <option value="done">done</option>
          </select>
          <button
            type="button"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-50"
            onClick={() => void load(status)}
            disabled={loading}
          >
            Обновить
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-3">
          <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
          <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
        </div>
      ) : orders.length === 0 ? (
        <Card>
          <div className="text-sm text-slate-600">Пусто</div>
        </Card>
      ) : (
        <div className="grid gap-3">
          {orders.map((o) => (
            <Card key={o.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">
                    {formatDateTime(o.created_at)} •{" "}
                    {o.city_slug ? o.city_slug.toUpperCase() : "—"} •{" "}
                    <span className="text-slate-600">{o.status}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    Юзер:{" "}
                    {o.tg_username ? `@${o.tg_username} (${o.tg_user_id})` : o.tg_user_id}
                    {" • "}
                    {formatRub(o.total_price)}
                    {" • "}
                    {o.delivery_method}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {o.status !== "processing" ? (
                    <button
                      type="button"
                      className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                      onClick={() => void setOrderStatus(o.id, "processing")}
                    >
                      В работу
                    </button>
                  ) : null}
                  {o.status !== "done" ? (
                    <button
                      type="button"
                      className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                      onClick={() => void setOrderStatus(o.id, "done")}
                    >
                      Готово
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="mt-3 border-t border-slate-200 pt-3">
                <div className="text-xs font-semibold text-slate-500">Позиции</div>
                <div className="mt-2 space-y-1 text-sm">
                  {o.items.map((it, idx) => (
                    <div key={`${o.id}:${idx}`} className="flex justify-between gap-3">
                      <div className="truncate">
                        {it.title ?? it.product_id ?? "unknown"} ×{it.qty}
                      </div>
                      <div className="shrink-0 font-semibold text-slate-700">
                        {formatRub(it.unit_price)}
                      </div>
                    </div>
                  ))}
                </div>

                {o.comment ? (
                  <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
                    <span className="text-xs font-semibold text-slate-500">
                      Комментарий:
                    </span>{" "}
                    {o.comment}
                  </div>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdminPage() {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const isTelegram = Boolean(window.Telegram?.WebApp?.initData);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiGet<AdminMe>("/api/admin/me")
      .then((data) => {
        if (cancelled) return;
        setMe(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setMe(null);
        setError(
          e instanceof ApiError
            ? e
            : new ApiError({ code: "UNKNOWN", message: "Error", status: 0 }),
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const accessState = useMemo(() => {
    if (loading) return "loading";
    if (me) return "ok";
    if (!error) return "unknown";
    if (error.status === 403) return "forbidden";
    if (error.status === 401) return "unauthorized";
    return "error";
  }, [loading, me, error]);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-lg font-semibold">Admin</div>
        <div className="mt-1 text-sm text-slate-600">
          {accessState === "ok"
            ? `Logged in as ${me?.username ? `@${me.username}` : me?.tgUserId} (role: ${me?.role})`
            : "Admin access is restricted to allowlist users."}
        </div>
      </div>

      {accessState === "loading" ? (
        <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
      ) : null}

      {accessState !== "ok" && accessState !== "loading" ? (
        <Card>
          <div className="text-sm font-semibold">No access</div>
          <div className="mt-2 text-sm text-slate-600">
            {accessState === "forbidden"
              ? "Your tg_user_id is not in the admins table."
              : accessState === "unauthorized"
                ? "Telegram initData required (open the mini app inside Telegram)."
                : "Failed to check access."}
          </div>

          {!isTelegram && import.meta.env.DEV ? (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              DEV: enable bypass (server): `DEV_ADMIN_TG_USER_ID` + header `x-dev-admin=1` (frontend sends automatically
              in dev).
            </div>
          ) : null}
        </Card>
      ) : null}

      {accessState === "ok" ? <AdminOrdersView /> : null}
    </div>
  );
}
