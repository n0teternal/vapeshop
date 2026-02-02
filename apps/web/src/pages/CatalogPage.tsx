import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PRODUCTS } from "../data/products";
import { useAppState } from "../state/AppStateProvider";
import { useTelegram } from "../telegram/TelegramProvider";
import { isSupabaseConfigured } from "../supabase/client";
import { fetchCatalog, type CatalogItem } from "../supabase/catalog";

function formatPriceRub(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

function FullscreenGate({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-lg font-semibold">{title}</div>
        {description ? (
          <div className="mt-2 text-sm text-slate-600">{description}</div>
        ) : null}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

function CatalogSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={`sk-${idx}`}
          className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
        >
          <div className="aspect-[4/3] animate-pulse bg-slate-200" />
          <div className="space-y-2 p-3">
            <div className="h-4 w-3/4 animate-pulse rounded bg-slate-200" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-slate-200" />
            <div className="h-8 w-full animate-pulse rounded-xl bg-slate-200" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ProductCard({
  item,
  onAdd,
}: {
  item: CatalogItem;
  onAdd: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="relative aspect-[4/3] bg-gradient-to-br from-slate-100 to-slate-200">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={item.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-end justify-between p-3">
            <span className="text-xs font-semibold text-slate-600">Фото</span>
          </div>
        )}

        <div className="absolute bottom-3 right-3">
          {item.inStock ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
              в наличии
            </span>
          ) : (
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
              нет
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2 p-3">
        <div className="text-sm font-semibold">{item.title}</div>
        <div className="text-sm text-slate-700">{formatPriceRub(item.price)}</div>
        <button
          type="button"
          className="w-full rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          disabled={!item.inStock}
          onClick={onAdd}
        >
          В корзину
        </button>
      </div>
    </div>
  );
}

function mapMockCatalog(): CatalogItem[] {
  return PRODUCTS.map((p) => ({
    id: p.id,
    title: p.title,
    description: null,
    imageUrl: null,
    price: p.price,
    inStock: p.inStock,
  }));
}

export function CatalogPage() {
  const { state, dispatch } = useAppState();
  const { isTelegram, webApp } = useTelegram();

  const [exitHint, setExitHint] = useState<string | null>(null);
  const [onlyInStock, setOnlyInStock] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const mockItems = useMemo(() => mapMockCatalog(), []);
  const [supabaseItems, setSupabaseItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supabaseEnabled = isSupabaseConfigured();
  const items = supabaseEnabled ? supabaseItems : mockItems;

  const cityLabel = useMemo(() => {
    if (state.city === "vvo") return "Владивосток (VVO)";
    if (state.city === "blg") return "Благовещенск (BLG)";
    return null;
  }, [state.city]);

  useEffect(() => {
    if (!supabaseEnabled) return;
    if (!state.isAdultConfirmed) return;
    if (!state.city) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchCatalog(state.city)
      .then((data) => {
        if (cancelled) return;
        setSupabaseItems(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : "Unknown error";
        setError(message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [state.isAdultConfirmed, state.city, supabaseEnabled, reloadToken]);

  const visibleItems = useMemo(() => {
    return onlyInStock ? items.filter((x) => x.inStock) : items;
  }, [items, onlyInStock]);

  if (!state.isAdultConfirmed) {
    return (
      <FullscreenGate
        title="Контент 18+"
        description="Подтвердите, что вам исполнилось 18 лет, чтобы продолжить."
      >
        <div className="grid gap-3">
          <button
            type="button"
            className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700"
            onClick={() => dispatch({ type: "adult/confirm" })}
          >
            Мне 18+
          </button>
          <button
            type="button"
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-50"
            onClick={() => {
              if (isTelegram) {
                webApp.close();
                return;
              }

              if (window.opener) {
                window.close();
                return;
              }

              setExitHint("Нельзя закрыть окно автоматически. Закройте вкладку вручную.");
            }}
          >
            Выйти
          </button>
          {exitHint ? (
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {exitHint}
            </div>
          ) : null}
        </div>
      </FullscreenGate>
    );
  }

  if (!state.city) {
    return (
      <FullscreenGate title="Выберите город">
        <div className="grid gap-3">
          <button
            type="button"
            className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
            onClick={() => dispatch({ type: "city/set", city: "vvo" })}
          >
            Владивосток (VVO)
          </button>
          <button
            type="button"
            className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
            onClick={() => dispatch({ type: "city/set", city: "blg" })}
          >
            Благовещенск (BLG)
          </button>
        </div>
      </FullscreenGate>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-lg font-semibold">Каталог</div>
          {cityLabel ? (
            <div className="text-xs text-slate-500">Город: {cityLabel}</div>
          ) : null}
        </div>
        <button
          type="button"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-50"
          onClick={() => dispatch({ type: "city/clear" })}
        >
          Сменить город
        </button>
      </div>

      {!supabaseEnabled ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Supabase env не задан: используется мок-каталог (DEV).
          <div className="mt-1 text-xs text-amber-800">
            Заполните `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY` в `.env.local`.
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-indigo-600"
            checked={onlyInStock}
            onChange={(e) => setOnlyInStock(e.target.checked)}
          />
          Только в наличии
        </label>
        <div className="text-xs text-slate-500">{visibleItems.length} шт</div>
      </div>

      {supabaseEnabled && error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <div className="text-sm font-semibold text-rose-900">
            Ошибка загрузки каталога
          </div>
          <div className="mt-1 text-xs text-rose-800">{error}</div>
          <button
            type="button"
            className="mt-3 rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-700"
            onClick={() => setReloadToken((x) => x + 1)}
          >
            Повторить
          </button>
        </div>
      ) : null}

      {supabaseEnabled && loading ? (
        <CatalogSkeleton count={6} />
      ) : visibleItems.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <div className="text-lg font-semibold">Нет товаров</div>
          <div className="mt-2 text-sm text-slate-600">
            Попробуйте отключить фильтр или выберите другой город.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {visibleItems.map((item) => (
            <ProductCard
              key={item.id}
              item={item}
              onAdd={() =>
                dispatch({
                  type: "cart/add",
                  item: {
                    productId: item.id,
                    title: item.title,
                    price: item.price,
                  },
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
