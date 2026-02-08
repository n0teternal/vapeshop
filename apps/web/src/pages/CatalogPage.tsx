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

function formatCategoryLabel(categorySlug: string): string {
  const normalized = categorySlug.trim().toLowerCase();
  if (normalized.length === 0) return "Прочее";
  if (normalized === "other") return "Прочее";

  const words = normalized.split(/[_-]+/g).filter((x) => x.length > 0);
  if (words.length === 0) return "Прочее";

  return words
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ");
}

function ProductCard({
  item,
  isFavorite,
  onAdd,
  onToggleFavorite,
}: {
  item: CatalogItem;
  isFavorite: boolean;
  onAdd: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <article className="flex h-full flex-col gap-2">
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
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Photo
            </div>
          </div>
        )}

        <button
          type="button"
          aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={isFavorite}
          className={[
            "absolute right-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-full backdrop-blur-sm",
            isFavorite ? "bg-[#ff4d6d]/90 text-white" : "bg-black/35 text-white",
          ].join(" ")}
          onClick={onToggleFavorite}
        >
          <svg viewBox="0 0 24 24" className="block h-5 w-5" aria-hidden="true">
            <path
              d="M12 20.6c-.3 0-.6-.1-.8-.3l-1.3-1.1C6.1 16 4 14.1 4 11.5 4 9.3 5.7 7.6 7.9 7.6c1.3 0 2.5.6 3.3 1.5.8-.9 2-1.5 3.3-1.5 2.2 0 3.9 1.7 3.9 3.9 0 2.6-2.1 4.5-5.9 7.7l-1.3 1.1c-.2.2-.5.3-.8.3Z"
              className={isFavorite ? "fill-white" : "fill-white/90"}
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
        <div className="mt-1 line-clamp-2 min-h-[2.6em] text-[clamp(0.86rem,3.25vw,1rem)] font-normal leading-snug text-slate-200">
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
    categorySlug: "other",
    price: p.price,
    inStock: p.inStock,
  }));
}

type CategoryStat = {
  id: string;
  label: string;
  count: number;
};

export function CatalogPage() {
  const { state, dispatch } = useAppState();

  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
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
            (msgLower.includes("invalid api key") ||
              (msgLower.includes("apikey") && msgLower.includes("invalid")));
          if (isInvalidKey) {
            setError({
              message: "Supabase env не задан или ключ относится к другому проекту.",
              devDetails: details,
            });
            return;
          }

          const isSchemaCache =
            e.status === 404 || e.code === "PGRST205" || msgLower.includes("schema cache");
          if (isSchemaCache) {
            setError({
              message: `В базе нет таблицы ${e.table} или не обновился API-кэш.`,
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
            setError({ message: "Нет прав доступа (RLS).", devDetails: details });
            return;
          }

          setError({ message: `Supabase error: ${e.message}`, devDetails: details });
          return;
        }

        const message =
          e instanceof Error
            ? e.message.includes("Supabase is not configured")
              ? "Supabase env не задан или ключ относится к другому проекту."
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

  const catalogWithCategory = useMemo(() => {
    return items.map((item) => ({
      item,
      categoryId:
        typeof item.categorySlug === "string" && item.categorySlug.trim().length > 0
          ? item.categorySlug.trim().toLowerCase()
          : "other",
    }));
  }, [items]);

  const categories = useMemo<CategoryStat[]>(() => {
    const counts = new Map<string, number>();
    for (const row of catalogWithCategory) {
      counts.set(row.categoryId, (counts.get(row.categoryId) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([id, count]) => ({ id, count, label: formatCategoryLabel(id) }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ru"));
  }, [catalogWithCategory]);

  useEffect(() => {
    const available = new Set(categories.map((x) => x.id));
    setSelectedCategoryIds((prev) => {
      const next = prev.filter((id) => available.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [categories]);

  const quickCategories = useMemo(() => categories, [categories]);

  const selectedCategoriesSet = useMemo(() => {
    return new Set(selectedCategoryIds);
  }, [selectedCategoryIds]);

  const visibleItems = useMemo(() => {
    return catalogWithCategory
      .filter((row) => {
        if (selectedCategoryIds.length > 0 && !selectedCategoriesSet.has(row.categoryId)) {
          return false;
        }
        return true;
      })
      .map((row) => row.item);
  }, [catalogWithCategory, selectedCategoriesSet, selectedCategoryIds.length]);

  const favoriteIds = useMemo(() => {
    return new Set(state.favorites.map((item) => item.productId));
  }, [state.favorites]);

  function toggleCategory(categoryId: string): void {
    setSelectedCategoryIds((prev) =>
      prev.includes(categoryId)
        ? prev.filter((id) => id !== categoryId)
        : [...prev, categoryId],
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Город
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-100">
            {cityLabel ?? "Не выбран"}
          </div>
        </div>

        <button
          type="button"
          className="rounded-xl border border-white/10 bg-[#252a31] px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-[#1f2328]"
          onClick={() => dispatch({ type: "city/clear" })}
        >
          Сменить город
        </button>
      </div>

      <div className="overflow-x-auto">
        <div className="flex w-max min-w-full items-center gap-2">
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-[#1f2328] px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-[#20252b]"
            onClick={() => setFiltersOpen(true)}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <path
                d="M4 6.5h16M7 12h10M10 17.5h4"
                className="fill-none stroke-current"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            Фильтры
            {selectedCategoryIds.length > 0 ? (
              <span className="rounded-full bg-[#2f80ff] px-1.5 py-0.5 text-[10px] font-bold text-white">
                {selectedCategoryIds.length}
              </span>
            ) : null}
          </button>

          {quickCategories.map((category) => {
            const active = selectedCategoriesSet.has(category.id);
            return (
              <button
                key={category.id}
                type="button"
                className={[
                  "shrink-0 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors",
                  active
                    ? "border-[#2f80ff] bg-[#2f80ff] text-white"
                    : "border-white/10 bg-[#1f2328] text-slate-200 hover:bg-[#20252b]",
                ].join(" ")}
                onClick={() => toggleCategory(category.id)}
              >
                {category.label}
              </button>
            );
          })}
        </div>
      </div>

      {!supabaseEnabled ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Supabase env не задан: используется мок-каталог (DEV).
          <div className="mt-1 text-xs text-amber-800">
            Заполните `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY` в `.env.local`.
          </div>
        </div>
      ) : null}

      {supabaseEnabled && error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <div className="text-sm font-semibold text-rose-900">Ошибка загрузки каталога</div>
          <div className="mt-1 text-xs text-rose-800">{error.message}</div>
          {import.meta.env.DEV && error.devDetails ? (
            <div className="mt-2 rounded-xl border border-rose-200 bg-[#1f2328] px-3 py-2 font-mono text-[11px] text-rose-900">
              <div>{error.devDetails}</div>
              <div className="mt-1 text-rose-800">
                DEV: выполните `supabase/schema.sql`, затем `supabase/seed.sql` в Supabase
                SQL Editor. Если ошибка "schema cache" не исчезает, выполните `notify pgrst,
                'reload schema';`.
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
            Попробуйте снять часть фильтров или выбрать другой город.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 auto-rows-fr gap-3">
          {visibleItems.map((item) => (
            <ProductCard
              key={item.id}
              item={item}
              isFavorite={favoriteIds.has(item.id)}
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
              onToggleFavorite={() =>
                dispatch({
                  type: "favorite/toggle",
                  item: {
                    productId: item.id,
                    title: item.title,
                    price: item.price,
                    imageUrl: item.imageUrl,
                    inStock: item.inStock,
                  },
                })
              }
            />
          ))}
        </div>
      )}

      {filtersOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center px-4 pb-4 pt-16 sm:items-center">
          <button
            type="button"
            className="absolute inset-0 bg-slate-900/50"
            aria-label="Закрыть фильтры"
            onClick={() => setFiltersOpen(false)}
          />

          <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-[#252a31] p-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-100">Фильтры каталога</div>
                <div className="mt-1 text-xs text-slate-400">
                  Здесь настраиваются все категории.
                </div>
              </div>

              <button
                type="button"
                className="rounded-xl bg-[#2f80ff] px-3 py-2 text-xs font-semibold text-white hover:bg-[#2370e3]"
                onClick={() => setFiltersOpen(false)}
              >
                Готово
              </button>
            </div>

            {categories.length === 0 ? (
              <div className="mt-4 text-sm text-slate-400">
                Категории пока не найдены в текущем каталоге.
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap gap-2">
                {categories.map((category) => {
                  const active = selectedCategoriesSet.has(category.id);
                  return (
                    <button
                      key={category.id}
                      type="button"
                      className={[
                        "rounded-xl border px-3 py-2 text-xs font-semibold transition-colors",
                        active
                          ? "border-[#2f80ff] bg-[#2f80ff] text-white"
                          : "border-white/10 bg-[#1f2328] text-slate-200 hover:bg-[#20252b]",
                      ].join(" ")}
                      onClick={() => toggleCategory(category.id)}
                    >
                      {category.label} ({category.count})
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                className="rounded-xl border border-white/10 bg-[#1f2328] px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-[#20252b] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={selectedCategoryIds.length === 0}
                onClick={() => setSelectedCategoryIds([])}
              >
                Сбросить
              </button>

              <div className="text-xs text-slate-400">
                {selectedCategoryIds.length === 0
                  ? "Показаны все категории"
                  : `Выбрано категорий: ${selectedCategoryIds.length}`}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
