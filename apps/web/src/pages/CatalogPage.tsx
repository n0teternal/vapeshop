import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PRODUCTS } from "../data/products";
import { useAppState } from "../state/AppStateProvider";
import { isSupabaseConfigured } from "../supabase/client";
import { fetchCatalog, type CatalogItem, SupabaseQueryError } from "../supabase/catalog";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1f2328] px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#252a31] p-6 shadow-sm">
        <div className="text-lg font-semibold">{title}</div>
        {description ? (
          <div className="mt-2 text-sm text-slate-400">{description}</div>
        ) : null}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

function CatalogSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-2 auto-rows-fr gap-3">
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={`sk-${idx}`}
          className="flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#252a31] shadow-sm"
        >
          <div className="aspect-[4/3] animate-pulse bg-slate-700/60" />
          <div className="flex flex-1 flex-col space-y-2 p-3">
            <div className="h-4 w-3/4 animate-pulse rounded bg-slate-700/60" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-slate-700/60" />
            <div className="mt-auto h-8 w-full animate-pulse rounded-xl bg-slate-700/60" />
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
    <article className="flex h-full flex-col gap-4">
      <div className="relative overflow-hidden rounded-[26px] border border-white/10">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={item.title}
            loading="lazy"
            className="h-[260px] w-full rounded-[26px] object-cover"
          />
        ) : (
          <div className="flex h-[260px] w-full items-center justify-center rounded-[26px] bg-[#2b3139]">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Photo</div>
          </div>
        )}

        <button
          type="button"
          aria-label="Favorite"
          className="absolute right-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-full bg-black/35 text-white backdrop-blur-sm"
        >
          <svg viewBox="0 0 24 24" className="block h-5 w-5" aria-hidden="true">
            <path
              d="M12 20.6c-.3 0-.6-.1-.8-.3l-1.3-1.1C6.1 16 4 14.1 4 11.5 4 9.3 5.7 7.6 7.9 7.6c1.3 0 2.5.6 3.3 1.5.8-.9 2-1.5 3.3-1.5 2.2 0 3.9 1.7 3.9 3.9 0 2.6-2.1 4.5-5.9 7.7l-1.3 1.1c-.2.2-.5.3-.8.3Z"
              className="fill-white"
            />
          </svg>
        </button>

        <button
          type="button"
          aria-label="Add to cart"
          className="absolute bottom-3 right-3 z-10 grid h-12 w-12 place-items-center rounded-full bg-white text-[#10151d] shadow-[0_10px_24px_rgba(0,0,0,0.45)] disabled:cursor-not-allowed disabled:bg-slate-500 disabled:text-slate-200"
          disabled={!item.inStock}
          onClick={onAdd}
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
            <path
              d="M7 7.5A5 5 0 0 1 17 7.5v.5h1.2c.8 0 1.4.6 1.4 1.4L18.8 19A2 2 0 0 1 16.8 21H7.2a2 2 0 0 1-2-2L4.4 9.4c0-.8.6-1.4 1.4-1.4H7zm2 0V8h6v-.5a3 3 0 1 0-6 0"
              className="fill-current"
            />
          </svg>
        </button>
      </div>

      <div className="px-1 pb-1">
        <div className="text-[clamp(1.15rem,4.5vw,1.45rem)] font-black leading-none text-white">
          {formatPriceRub(item.price)}
        </div>
        <div className="mt-2 line-clamp-2 min-h-[2.6em] text-[clamp(0.86rem,3.25vw,1rem)] font-normal leading-snug text-slate-200">
          {item.title}
        </div>
      </div>
    </article>
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
  const [onlyInStock, setOnlyInStock] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const mockItems = useMemo(() => mapMockCatalog(), []);
  const [supabaseItems, setSupabaseItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; devDetails?: string } | null>(
    null,
  );

  const supabaseEnabled = isSupabaseConfigured();
  const items = supabaseEnabled ? supabaseItems : mockItems;

  const cityLabel = useMemo(() => {
    if (state.city === "vvo") return "Владивосток (VVO)";
    if (state.city === "blg") return "Благовещенск (BLG)";
    return null;
  }, [state.city]);

  useEffect(() => {
    if (!supabaseEnabled) return;
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
        if (e instanceof SupabaseQueryError) {
          const details = `table=${e.table} status=${e.status ?? "n/a"} code=${e.code ?? "n/a"} msg=${e.message}`;
          const msgLower = e.message.toLowerCase();

          const isInvalidKey =
            e.status === 401 &&
            (msgLower.includes("invalid api key") || msgLower.includes("apikey") && msgLower.includes("invalid"));
          if (isInvalidKey) {
            setError({ message: "Supabase env не задан/не тот проект", devDetails: details });
            return;
          }

          const isSchemaCache = e.status === 404 || e.code === "PGRST205" || msgLower.includes("schema cache");
          if (isSchemaCache) {
            setError({
              message: `В базе нет таблицы ${e.table} или не обновился API-кэш`,
              devDetails: details,
            });
            return;
          }

          const isPermission =
            e.status === 401 ||
            e.status === 403 ||
            e.code === "42501" ||
            msgLower.includes("permission");
          if (isPermission) {
            setError({ message: "Нет прав (RLS)", devDetails: details });
            return;
          }

          setError({ message: `Supabase error: ${e.message}`, devDetails: details });
          return;
        }

        const message =
          e instanceof Error
            ? e.message.includes("Supabase is not configured")
              ? "Supabase env не задан/не тот проект"
              : e.message
            : "Unknown error";
        setError({ message, devDetails: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [state.city, supabaseEnabled, reloadToken]);

  const visibleItems = useMemo(() => {
    return onlyInStock ? items.filter((x) => x.inStock) : items;
  }, [items, onlyInStock]);

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
          className="rounded-xl border border-white/10 bg-[#252a31] px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-[#1f2328]"
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

      <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-[#252a31] px-4 py-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-600 text-[#2f80ff]"
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
          <div className="mt-1 text-xs text-rose-800">{error.message}</div>
          {import.meta.env.DEV && error.devDetails ? (
            <div className="mt-2 rounded-xl border border-rose-200 bg-[#1f2328] px-3 py-2 font-mono text-[11px] text-rose-900">
              <div>{error.devDetails}</div>
              <div className="mt-1 text-rose-800">
                DEV: выполните `supabase/schema.sql`, затем `supabase/seed.sql` в Supabase SQL Editor. Если
                ошибка “schema cache” не исчезает — выполните `notify pgrst, 'reload schema';`.
              </div>
            </div>
          ) : null}
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
        <div className="rounded-2xl border border-white/10 bg-[#252a31] p-6 text-center">
          <div className="text-lg font-semibold">Нет товаров</div>
          <div className="mt-2 text-sm text-slate-400">
            Попробуйте отключить фильтр или выберите другой город.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 auto-rows-fr gap-3">
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
