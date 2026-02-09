import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
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

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("ё", "е")
    .replaceAll(/[^a-z0-9а-я\s]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function buildImageCandidates(imageUrl: string | null): string[] {
  const raw = imageUrl?.trim() ?? "";
  if (!raw) return [];

  const m = raw.match(/^([^?#]+)(.*)$/);
  if (!m) return [raw];

  const pathPart = m[1];
  const suffix = m[2] ?? "";
  if (!pathPart) return [raw];

  const unique = new Set<string>();
  const push = (value: string) => {
    if (value.trim().length === 0) return;
    unique.add(value);
  };

  push(raw);

  const extMatch = pathPart.match(/\.([a-z0-9]{2,10})$/i);
  if (extMatch) {
    const ext = `.${(extMatch[1] ?? "").toLowerCase()}`;
    const base = pathPart.slice(0, -ext.length);
    const variants = [".webp", ".jpg", ".jpeg", ".png"];
    for (const variant of variants) {
      if (variant === ext) continue;
      push(`${base}${variant}${suffix}`);
    }
    return Array.from(unique);
  }

  push(`${pathPart}.webp${suffix}`);
  push(`${pathPart}.jpg${suffix}`);
  push(`${pathPart}.jpeg${suffix}`);
  push(`${pathPart}.png${suffix}`);
  return Array.from(unique);
}

function isSubsequence(query: string, target: string): boolean {
  if (query.length === 0) return true;
  let queryIndex = 0;

  for (let i = 0; i < target.length && queryIndex < query.length; i += 1) {
    if (target[i] === query[queryIndex]) {
      queryIndex += 1;
    }
  }

  return queryIndex === query.length;
}

function levenshteinDistanceWithinLimit(
  left: string,
  right: string,
  maxDistance: number,
): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  if (Math.abs(left.length - right.length) > maxDistance) {
    return maxDistance + 1;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, idx) => idx);
  let current = new Array<number>(right.length + 1).fill(0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      const nextValue = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
      current[j] = nextValue;
      if (nextValue < rowMin) rowMin = nextValue;
    }

    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }

    [previous, current] = [current, previous];
  }

  return previous[right.length];
}

function getSearchMatchScore(title: string, normalizedQuery: string): number {
  if (normalizedQuery.length === 0) return 1;

  const normalizedTitle = normalizeSearchText(title);
  if (normalizedTitle.length === 0) return 0;

  const exactIndex = normalizedTitle.indexOf(normalizedQuery);
  if (exactIndex >= 0) {
    return 120 - Math.min(exactIndex, 40);
  }

  const titleWords = normalizedTitle.split(" ").filter((x) => x.length > 0);
  const queryWords = normalizedQuery.split(" ").filter((x) => x.length > 0);
  if (titleWords.length === 0 || queryWords.length === 0) return 0;

  let totalScore = 0;

  for (const queryWord of queryWords) {
    let bestWordScore = 0;

    for (const titleWord of titleWords) {
      if (titleWord.includes(queryWord)) {
        bestWordScore = Math.max(bestWordScore, 88 - Math.min(titleWord.length, 30));
        continue;
      }

      if (queryWord.length >= 3) {
        const maxDistance =
          queryWord.length >= 9 ? 3 : queryWord.length >= 6 ? 2 : 1;
        const distance = levenshteinDistanceWithinLimit(
          queryWord,
          titleWord,
          maxDistance,
        );
        if (distance <= maxDistance) {
          const distancePenalty = distance * 12;
          const lengthPenalty = Math.min(Math.abs(titleWord.length - queryWord.length), 8);
          bestWordScore = Math.max(bestWordScore, 64 - distancePenalty - lengthPenalty);
        }
      }
    }

    if (bestWordScore <= 0) {
      return 0;
    }

    totalScore += bestWordScore;
  }

  const compactQuery = normalizedQuery.replaceAll(" ", "");
  const compactTitle = normalizedTitle.replaceAll(" ", "");
  if (compactQuery.length >= 3 && isSubsequence(compactQuery, compactTitle)) {
    totalScore += 6;
  }

  return totalScore;
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
  const imageCandidates = useMemo(() => buildImageCandidates(item.imageUrl), [item.imageUrl]);
  const [imageIndex, setImageIndex] = useState(0);

  useEffect(() => {
    setImageIndex(0);
  }, [item.imageUrl]);

  const imageSrc = imageCandidates[imageIndex] ?? null;

  return (
    <article className="flex h-full flex-col gap-2">
      <div className="relative overflow-hidden rounded-[26px] border border-white/10">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={item.title}
            loading="eager"
            referrerPolicy="no-referrer"
            className="h-[224px] w-full rounded-[26px] object-cover"
            onError={() => {
              setImageIndex((prev) => {
                if (prev >= imageCandidates.length - 1) return prev;
                return prev + 1;
              });
            }}
          />
        ) : (
          <div className="flex h-[224px] w-full items-center justify-center rounded-[26px] bg-[#2b3139]">
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

type PriceSortMode = "none" | "asc" | "desc";
type CatalogToast = { key: number; message: string };
type CatalogLoadError = { message: string; devDetails?: string };

function mapCatalogLoadError(error: unknown): CatalogLoadError {
  if (error instanceof SupabaseQueryError) {
    const details = `table=${error.table} status=${error.status ?? "n/a"} code=${error.code ?? "n/a"} msg=${error.message}`;

    if (error.code === "BAD_RESPONSE") {
      return {
        message:
          "API вернул неожиданный ответ. Проверьте, что `/api/catalog` доступен и возвращает JSON.",
        devDetails: details,
      };
    }

    const msgLower = error.message.toLowerCase();

    const isInvalidKey =
      error.status === 401 &&
      (msgLower.includes("invalid api key") ||
        (msgLower.includes("apikey") && msgLower.includes("invalid")));
    if (isInvalidKey) {
      return {
        message: "Supabase env не задан или ключ относится к другому проекту.",
        devDetails: details,
      };
    }

    const isSchemaCache =
      error.status === 404 || error.code === "PGRST205" || msgLower.includes("schema cache");
    if (isSchemaCache) {
      return {
        message: `В базе нет таблицы ${error.table} или не обновился API-кэш.`,
        devDetails: details,
      };
    }

    const isPermission =
      error.status === 401 ||
      error.status === 403 ||
      error.code === "42501" ||
      msgLower.includes("permission");
    if (isPermission) {
      return { message: "Нет прав доступа (RLS).", devDetails: details };
    }

    return { message: `Supabase error: ${error.message}`, devDetails: details };
  }

  const message =
    error instanceof Error
      ? error.message.includes("Supabase is not configured")
        ? "Supabase env не задан или ключ относится к другому проекту."
        : error.message
      : "Unknown error";

  return { message, devDetails: error instanceof Error ? error.message : String(error) };
}

export function CatalogPage() {
  const { state, dispatch } = useAppState();

  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [priceSortMode, setPriceSortMode] = useState<PriceSortMode>("none");
  const [onlyInStock, setOnlyInStock] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [toast, setToast] = useState<CatalogToast | null>(null);
  const toastKeyRef = useRef(0);

  const mockItems = useMemo(() => mapMockCatalog(), []);
  const supabaseEnabled = isSupabaseConfigured();
  const catalogQuery = useQuery({
    queryKey: ["catalog", state.city] as const,
    queryFn: ({ queryKey }) => {
      const [, citySlug] = queryKey;
      if (!citySlug) {
        throw new Error("City is not selected");
      }
      return fetchCatalog(citySlug);
    },
    enabled: supabaseEnabled && state.city !== null,
  });
  const supabaseItems = catalogQuery.data ?? [];
  const loading = supabaseEnabled && catalogQuery.isPending;
  const error = useMemo(() => {
    if (!catalogQuery.error) return null;
    return mapCatalogLoadError(catalogQuery.error);
  }, [catalogQuery.error]);
  const items = supabaseEnabled ? supabaseItems : mockItems;

  const cityLabel = useMemo(() => {
    if (state.city === "vvo") return "Владивосток (VVO)";
    if (state.city === "blg") return "Благовещенск (BLG)";
    return null;
  }, [state.city]);

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

  const normalizedSearchQuery = useMemo(() => {
    return normalizeSearchText(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    if (!toast) return;
    const timeoutId = window.setTimeout(() => {
      setToast(null);
    }, 1700);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [toast]);

  const visibleItems = useMemo(() => {
    const preFilteredRows = catalogWithCategory
      .filter((row) => {
        if (selectedCategoryIds.length > 0 && !selectedCategoriesSet.has(row.categoryId)) {
          return false;
        }
        if (onlyInStock && !row.item.inStock) {
          return false;
        }
        return true;
      });

    const scoredItems =
      normalizedSearchQuery.length > 0
        ? preFilteredRows
            .map((row) => ({
              item: row.item,
              score: getSearchMatchScore(row.item.title, normalizedSearchQuery),
            }))
            .filter((entry) => entry.score > 0)
        : preFilteredRows.map((row) => ({ item: row.item, score: 0 }));

    if (priceSortMode === "asc") {
      return [...scoredItems]
        .sort(
          (a, b) =>
            a.item.price - b.item.price ||
            b.score - a.score ||
            a.item.title.localeCompare(b.item.title, "ru"),
        )
        .map((entry) => entry.item);
    }

    if (priceSortMode === "desc") {
      return [...scoredItems]
        .sort(
          (a, b) =>
            b.item.price - a.item.price ||
            b.score - a.score ||
            a.item.title.localeCompare(b.item.title, "ru"),
        )
        .map((entry) => entry.item);
    }

    if (normalizedSearchQuery.length > 0) {
      return [...scoredItems]
        .sort(
          (a, b) =>
            b.score - a.score || a.item.title.localeCompare(b.item.title, "ru"),
        )
        .map((entry) => entry.item);
    }

    return scoredItems.map((entry) => entry.item);
  }, [
    catalogWithCategory,
    normalizedSearchQuery,
    onlyInStock,
    priceSortMode,
    selectedCategoriesSet,
    selectedCategoryIds.length,
  ]);

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

  function showToast(message: string): void {
    toastKeyRef.current += 1;
    setToast({ key: toastKeyRef.current, message });
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

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex w-max min-w-full items-center gap-2 pr-1">
              <button
                type="button"
                className={[
                  "inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors",
                  priceSortMode === "none" && !onlyInStock
                    ? "border-white/10 bg-[#1f2328] text-slate-200 hover:bg-[#20252b]"
                    : "border-[#2f80ff] bg-[#2f80ff] text-white",
                ].join(" ")}
                onClick={() => setSortOpen(true)}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                  <path
                    d="M7 5v14m0 0-3-3m3 3 3-3M17 19V5m0 0-3 3m3-3 3 3"
                    className="fill-none stroke-current"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Сортировка
              </button>

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

          <button
            type="button"
            aria-label={searchOpen ? "Закрыть поиск" : "Открыть поиск"}
            className={[
              "grid h-10 w-10 shrink-0 place-items-center rounded-full border transition-colors",
              searchOpen
                ? "border-[#2f80ff] bg-[#2f80ff] text-white"
                : "border-white/10 bg-[#1f2328] text-slate-300 hover:bg-[#20252b]",
            ].join(" ")}
            onClick={() =>
              setSearchOpen((prev) => {
                if (prev) {
                  setSearchQuery("");
                }
                return !prev;
              })
            }
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <path
                d="M15.8 14.4 20 18.6l-1.4 1.4-4.2-4.2a7 7 0 1 1 1.4-1.4ZM10 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"
                className="fill-current"
              />
            </svg>
          </button>
        </div>

        {searchOpen ? (
          <label className="relative block">
            <span className="sr-only">Поиск по названию</span>
            <svg
              viewBox="0 0 24 24"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden="true"
            >
              <path
                d="M15.8 14.4 20 18.6l-1.4 1.4-4.2-4.2a7 7 0 1 1 1.4-1.4ZM10 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"
                className="fill-current"
              />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Поиск по названию"
              className="h-10 w-full rounded-xl border border-white/10 bg-[#1f2328] pl-9 pr-3 text-xs font-medium text-slate-100 placeholder:text-slate-500 focus:border-[#2f80ff] focus:outline-none"
              autoFocus
            />
          </label>
        ) : null}
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
              {error.devDetails.includes("code=BAD_RESPONSE") ? (
                <div className="mt-1 text-rose-800">
                  DEV: проверьте, что API доступен (`/api/catalog?citySlug=vvo`), и что
                  dev-proxy направлен на рабочий backend (`VITE_DEV_API_TARGET`) или локальный
                  API запущен.
                </div>
              ) : (
                <div className="mt-1 text-rose-800">
                  DEV: выполните `supabase/schema.sql`, затем `supabase/seed.sql` в Supabase
                  SQL Editor. Если ошибка "schema cache" не исчезает, выполните `notify pgrst,
                  'reload schema';`.
                </div>
              )}
            </div>
          ) : null}
          <button
            type="button"
            className="mt-3 rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-700"
            onClick={() => {
              void catalogQuery.refetch();
            }}
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
              onAdd={() => {
                dispatch({
                  type: "cart/add",
                  item: {
                    productId: item.id,
                    title: item.title,
                    price: item.price,
                    imageUrl: item.imageUrl,
                  },
                });
                showToast("\u0422\u043e\u0432\u0430\u0440 \u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d \u0432 \u043a\u043e\u0440\u0437\u0438\u043d\u0443");
              }}
              onToggleFavorite={() => {
                const wasFavorite = favoriteIds.has(item.id);
                dispatch({
                  type: "favorite/toggle",
                  item: {
                    productId: item.id,
                    title: item.title,
                    price: item.price,
                    imageUrl: item.imageUrl,
                    inStock: item.inStock,
                  },
                });
                showToast(
                  wasFavorite
                    ? "\u0422\u043e\u0432\u0430\u0440 \u0443\u0434\u0430\u043b\u0435\u043d \u0438\u0437 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0433\u043e"
                    : "\u0422\u043e\u0432\u0430\u0440 \u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d \u0432 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435",
                );
              }}
            />
          ))}
        </div>
      )}

      {sortOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center px-4 pb-4 pt-16 sm:items-center">
          <button
            type="button"
            className="absolute inset-0 bg-slate-900/50"
            aria-label="Закрыть сортировку"
            onClick={() => setSortOpen(false)}
          />

          <div className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-[#252a31] p-4 shadow-xl">
            <div className="text-base font-semibold text-slate-100">Сортировать по</div>

            <div className="mt-4 grid gap-2">
              <button
                type="button"
                className={[
                  "flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors",
                  onlyInStock
                    ? "border-[#2f80ff] bg-[#2f80ff]/20 text-[#b9d4ff]"
                    : "border-white/10 bg-[#1f2328] text-slate-200 hover:bg-[#20252b]",
                ].join(" ")}
                onClick={() => setOnlyInStock((prev) => !prev)}
              >
                <span>Только в наличии</span>
                {onlyInStock ? <span aria-hidden="true">✓</span> : null}
              </button>

              <button
                type="button"
                className={[
                  "flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors",
                  priceSortMode === "asc"
                    ? "border-[#2f80ff] bg-[#2f80ff]/20 text-[#b9d4ff]"
                    : "border-white/10 bg-[#1f2328] text-slate-200 hover:bg-[#20252b]",
                ].join(" ")}
                onClick={() => {
                  setPriceSortMode((prev) => (prev === "asc" ? "none" : "asc"));
                  setSortOpen(false);
                }}
              >
                <span>По возрастанию цены</span>
                {priceSortMode === "asc" ? <span aria-hidden="true">✓</span> : null}
              </button>

              <button
                type="button"
                className={[
                  "flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors",
                  priceSortMode === "desc"
                    ? "border-[#2f80ff] bg-[#2f80ff]/20 text-[#b9d4ff]"
                    : "border-white/10 bg-[#1f2328] text-slate-200 hover:bg-[#20252b]",
                ].join(" ")}
                onClick={() => {
                  setPriceSortMode((prev) => (prev === "desc" ? "none" : "desc"));
                  setSortOpen(false);
                }}
              >
                <span>По убыванию цены</span>
                {priceSortMode === "desc" ? <span aria-hidden="true">✓</span> : null}
              </button>
            </div>
          </div>
        </div>
      ) : null}

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

      {toast ? (
        <div className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4 [bottom:calc(env(safe-area-inset-bottom,0px)+7.1rem)]">
          <div
            key={toast.key}
            className="w-full max-w-md rounded-2xl border border-white/15 bg-[linear-gradient(135deg,#2b3442_0%,#232a33_100%)] px-4 py-3.5 text-sm font-semibold text-slate-100 shadow-[0_14px_40px_rgba(0,0,0,0.5)] backdrop-blur"
          >
            <div className="flex items-center gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#2f80ff]/25 text-[#8fbeff]">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
                  <path
                    d="M9.6 16.2 5.8 12.4 4.4 13.8l5.2 5.2L20 8.6l-1.4-1.4z"
                    className="fill-current"
                  />
                </svg>
              </span>
              <span className="leading-tight">{toast.message}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
