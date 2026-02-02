import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, apiGet, apiPost, apiPut, apiUpload } from "../api/client";

type AdminMe = {
  tgUserId: number;
  username: string | null;
  role: string;
};

type City = { id: number; name: string; slug: string };

type ProductInventory = {
  city_id: number;
  city_slug: string;
  in_stock: boolean;
  stock_qty: number | null;
  price_override: number | null;
};

type Product = {
  id: string;
  title: string;
  description: string | null;
  base_price: number;
  image_url: string | null;
  is_active: boolean;
  inventory: ProductInventory[];
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

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={[
        "rounded-xl px-3 py-2 text-sm font-semibold",
        active ? "bg-slate-900 text-white" : "bg-white text-slate-900 hover:bg-slate-50",
        "border border-slate-200",
      ].join(" ")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      {children}
    </div>
  );
}

function AdminProductsView() {
  const [cities, setCities] = useState<City[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | "new" | null>(null);

  const editingProduct = useMemo(() => {
    if (!editingId || editingId === "new") return null;
    return products.find((p) => p.id === editingId) ?? null;
  }, [editingId, products]);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [citiesData, productsData] = await Promise.all([
        apiGet<City[]>("/api/admin/cities"),
        apiGet<Product[]>("/api/admin/products"),
      ]);
      setCities(citiesData);
      setProducts(productsData);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Ошибка загрузки";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Товары</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-50"
            onClick={() => void load()}
            disabled={loading}
          >
            Обновить
          </button>
          <button
            type="button"
            className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
            onClick={() => setEditingId("new")}
          >
            + Добавить
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
          {error}
        </div>
      ) : null}

      {editingId ? (
        <ProductEditor
          cities={cities}
          product={editingProduct}
          mode={editingId === "new" ? "create" : "edit"}
          onClose={() => setEditingId(null)}
          onSaved={async (productId) => {
            await load();
            setEditingId(productId);
          }}
        />
      ) : null}

      {loading ? (
        <div className="grid gap-3">
          <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
          <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
        </div>
      ) : (
        <div className="grid gap-3">
          {products.map((p) => (
            <Card key={p.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="h-16 w-16 overflow-hidden rounded-xl bg-slate-100">
                    {p.image_url ? (
                      <img
                        src={p.image_url}
                        alt={p.title}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : null}
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{p.title}</div>
                    <div className="mt-1 text-xs text-slate-600">
                      {formatRub(p.base_price)} •{" "}
                      <span className={p.is_active ? "text-emerald-700" : "text-slate-500"}>
                        {p.is_active ? "active" : "inactive"}
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-50"
                  onClick={() => setEditingId(p.id)}
                >
                  Edit
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ProductEditor({
  cities,
  product,
  mode,
  onClose,
  onSaved,
}: {
  cities: City[];
  product: Product | null;
  mode: "create" | "edit";
  onClose: () => void;
  onSaved: (productId: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [rowSaving, setRowSaving] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string | null>>({});

  type InvDraft = {
    inStock: boolean;
    stockQty: string;
    priceOverride: string;
  };
  const [invDraft, setInvDraft] = useState<Record<string, InvDraft>>({});

  useEffect(() => {
    setError(null);
    setRowError({});
    setRowSaving(null);

    if (product) {
      setTitle(product.title);
      setDescription(product.description ?? "");
      setBasePrice(String(product.base_price));
      setIsActive(product.is_active);

      const bySlug: Record<string, InvDraft> = {};
      for (const c of cities) {
        const inv = product.inventory.find((x) => x.city_slug === c.slug) ?? null;
        bySlug[c.slug] = {
          inStock: inv?.in_stock ?? false,
          stockQty: inv?.stock_qty === null || inv?.stock_qty === undefined ? "" : String(inv.stock_qty),
          priceOverride:
            inv?.price_override === null || inv?.price_override === undefined
              ? ""
              : String(inv.price_override),
        };
      }
      setInvDraft(bySlug);
    } else {
      setTitle("");
      setDescription("");
      setBasePrice("");
      setIsActive(true);

      const bySlug: Record<string, InvDraft> = {};
      for (const c of cities) {
        bySlug[c.slug] = { inStock: false, stockQty: "", priceOverride: "" };
      }
      setInvDraft(bySlug);
    }
  }, [product, cities]);

  const canEditInventory = mode === "edit" && Boolean(product);

  async function saveProduct(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const priceNumber = Number(basePrice);
      if (!Number.isFinite(priceNumber) || priceNumber < 0) {
        setError("base_price должен быть числом >= 0");
        return;
      }

      if (mode === "create") {
        const created = await apiPost<{
          id: string;
        }>("/api/admin/products", {
          title,
          description: description.trim() ? description.trim() : null,
          basePrice: priceNumber,
          isActive,
        });
        await onSaved(created.id);
        return;
      }

      if (!product) return;
      await apiPut(`/api/admin/products/${product.id}`, {
        title,
        description: description.trim() ? description.trim() : null,
        basePrice: priceNumber,
        isActive,
      });
      await onSaved(product.id);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Ошибка сохранения";
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  async function uploadImage(file: File): Promise<void> {
    if (!product) return;
    setSaving(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      await apiUpload(`/api/admin/products/${product.id}/image`, form);
      await onSaved(product.id);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Ошибка загрузки изображения";
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  async function saveInventory(citySlug: string): Promise<void> {
    if (!product) return;
    const row = invDraft[citySlug];
    if (!row) return;

    setRowSaving(citySlug);
    setRowError((prev) => ({ ...prev, [citySlug]: null }));
    try {
      const stockQty =
        row.stockQty.trim().length === 0 ? null : Number(row.stockQty);
      if (stockQty !== null && (!Number.isFinite(stockQty) || stockQty < 0)) {
        setRowError((prev) => ({ ...prev, [citySlug]: "stock_qty должен быть >= 0" }));
        return;
      }

      const priceOverride =
        row.priceOverride.trim().length === 0 ? null : Number(row.priceOverride);
      if (
        priceOverride !== null &&
        (!Number.isFinite(priceOverride) || priceOverride < 0)
      ) {
        setRowError((prev) => ({ ...prev, [citySlug]: "price_override должен быть >= 0" }));
        return;
      }

      await apiPut("/api/admin/inventory", {
        productId: product.id,
        citySlug,
        inStock: row.inStock,
        stockQty,
        priceOverride,
      });

      await onSaved(product.id);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Ошибка сохранения наличия";
      setRowError((prev) => ({ ...prev, [citySlug]: message }));
    } finally {
      setRowSaving(null);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">
            {mode === "create" ? "Новый товар" : "Редактирование товара"}
          </div>
          {product ? (
            <div className="mt-1 text-xs text-slate-500">ID: {product.id}</div>
          ) : null}
        </div>
        <button
          type="button"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-50"
          onClick={onClose}
          disabled={saving}
        >
          Закрыть
        </button>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </div>
      ) : null}

      <div className="mt-4 grid gap-3">
        <label className="grid gap-1">
          <span className="text-xs font-semibold text-slate-600">Название</span>
          <input
            className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={saving}
          />
        </label>

        <label className="grid gap-1">
          <span className="text-xs font-semibold text-slate-600">Описание</span>
          <textarea
            className="min-h-20 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={saving}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1">
            <span className="text-xs font-semibold text-slate-600">Базовая цена</span>
            <input
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm"
              value={basePrice}
              inputMode="numeric"
              onChange={(e) => setBasePrice(e.target.value)}
              disabled={saving}
              placeholder="0"
            />
          </label>

          <label className="flex items-center gap-2 self-end pb-2 text-sm font-semibold">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-indigo-600"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              disabled={saving}
            />
            active
          </label>
        </div>

        <button
          type="button"
          className="rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          onClick={() => void saveProduct()}
          disabled={saving || title.trim().length === 0}
        >
          {saving ? "Сохраняем..." : mode === "create" ? "Создать" : "Сохранить"}
        </button>
      </div>

      <div className="mt-6">
        <div className="text-sm font-semibold">Изображение</div>
        <div className="mt-2 flex items-start gap-3">
          <div className="h-20 w-20 overflow-hidden rounded-xl bg-slate-100">
            {product?.image_url ? (
              <img
                src={product.image_url}
                alt={product.title}
                className="h-full w-full object-cover"
              />
            ) : null}
          </div>
          <div className="flex-1">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={!product || saving}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void uploadImage(file);
              }}
            />
            {!product ? (
              <div className="mt-1 text-xs text-slate-500">
                Сначала создайте товар, затем загрузите картинку.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-6">
        <div className="text-sm font-semibold">Наличие по городам</div>

        {!canEditInventory ? (
          <div className="mt-2 text-xs text-slate-500">
            Наличие можно редактировать после создания товара.
          </div>
        ) : null}

        <div className="mt-3 grid gap-3">
          {cities.map((c) => {
            const row = invDraft[c.slug];
            if (!row) return null;
            const isSaving = rowSaving === c.slug;
            const rError = rowError[c.slug] ?? null;

            return (
              <div key={c.slug} className="rounded-2xl border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">{c.name}</div>
                  <label className="flex items-center gap-2 text-sm font-semibold">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                      checked={row.inStock}
                      disabled={!canEditInventory || isSaving}
                      onChange={(e) =>
                        setInvDraft((prev) => ({
                          ...prev,
                          [c.slug]: { ...prev[c.slug], inStock: e.target.checked },
                        }))
                      }
                    />
                    in_stock
                  </label>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="grid gap-1">
                    <span className="text-xs font-semibold text-slate-600">
                      stock_qty
                    </span>
                    <input
                      className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm"
                      value={row.stockQty}
                      inputMode="numeric"
                      placeholder="(пусто)"
                      disabled={!canEditInventory || isSaving}
                      onChange={(e) =>
                        setInvDraft((prev) => ({
                          ...prev,
                          [c.slug]: { ...prev[c.slug], stockQty: e.target.value },
                        }))
                      }
                    />
                  </label>

                  <label className="grid gap-1">
                    <span className="text-xs font-semibold text-slate-600">
                      price_override
                    </span>
                    <input
                      className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm"
                      value={row.priceOverride}
                      inputMode="numeric"
                      placeholder="(пусто)"
                      disabled={!canEditInventory || isSaving}
                      onChange={(e) =>
                        setInvDraft((prev) => ({
                          ...prev,
                          [c.slug]: { ...prev[c.slug], priceOverride: e.target.value },
                        }))
                      }
                    />
                  </label>
                </div>

                {rError ? (
                  <div className="mt-2 text-xs text-rose-700">{rError}</div>
                ) : null}

                <button
                  type="button"
                  className="mt-3 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                  disabled={!canEditInventory || isSaving}
                  onClick={() => void saveInventory(c.slug)}
                >
                  {isSaving ? "Сохраняем..." : "Сохранить наличие"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
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
  const [tab, setTab] = useState<"products" | "orders">("products");

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
        setError(e instanceof ApiError ? e : new ApiError({ code: "UNKNOWN", message: "Ошибка", status: 0 }));
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
            ? `Вы вошли как ${me?.username ? `@${me.username}` : me?.tgUserId} • ${me?.role}`
            : "Доступ к админке только для allowlist пользователей."}
        </div>
      </div>

      {accessState === "loading" ? (
        <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
      ) : null}

      {accessState !== "ok" && accessState !== "loading" ? (
        <Card>
          <div className="text-sm font-semibold">Нет доступа</div>
          <div className="mt-2 text-sm text-slate-600">
            {accessState === "forbidden"
              ? "Ваш tg_user_id отсутствует в таблице admins."
              : accessState === "unauthorized"
                ? "Нужна Telegram initData (откройте мини-апп внутри Telegram)."
                : "Не удалось проверить доступ."}
          </div>

          {!isTelegram && import.meta.env.DEV ? (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              DEV: можно включить bypass (сервер): `DEV_ADMIN_TG_USER_ID` + заголовок
              `x-dev-admin=1` (фронт в dev отправляет автоматически).
            </div>
          ) : null}
        </Card>
      ) : null}

      {accessState === "ok" ? (
        <>
          <div className="flex items-center gap-2">
            <TabButton active={tab === "products"} onClick={() => setTab("products")}>
              Товары
            </TabButton>
            <TabButton active={tab === "orders"} onClick={() => setTab("orders")}>
              Заказы
            </TabButton>
          </div>

          {tab === "products" ? <AdminProductsView /> : <AdminOrdersView />}
        </>
      ) : null}
    </div>
  );
}
