import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProductImagePreview } from "../components/ProductImagePreview";
import { PRODUCTS } from "../data/products";
import { useAppState } from "../state/AppStateProvider";
import { isSupabaseConfigured } from "../supabase/client";
import { fetchCatalog, type CatalogItem, SupabaseQueryError } from "../supabase/catalog";
import { buildImageCandidates } from "../utils/imageCandidates";

const CATALOG_INITIAL_RENDER_COUNT = 24;
const CATALOG_RENDER_STEP = 20;
const CATALOG_IMAGE_PREFETCH_AHEAD = 12;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-border/70 bg-card/90 p-6 shadow-sm">
        <div className="text-lg font-semibold">{title}</div>
        {description ? (
          <div className="mt-2 text-sm text-muted-foreground">{description}</div>
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
          className="flex h-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/90 shadow-sm"
        >
          <div className="aspect-[4/3] animate-pulse bg-muted/60" />
          <div className="flex flex-1 flex-col space-y-2 p-3">
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted/60" />
            <div className="mt-auto h-8 w-full animate-pulse rounded-xl bg-muted/60" />
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

const MANUFACTURER_STOP_WORDS = new Set([
  "одноразка",
  "одноразовый",
  "одноразовая",
  "одноразовые",
  "disposable",
  "pod",
  "pods",
  "salt",
  "vape",
  "вейп",
  "жидкость",
  "жидкости",
  "liquid",
  "cartridge",
  "картридж",
  "испаритель",
]);

function normalizeManufacturerId(value: string): string {
  return normalizeSearchText(value).replaceAll(" ", "-");
}

function extractManufacturerLabel(title: string): string {
  const tokens = title
    .replaceAll("_", " ")
    .replaceAll("/", " ")
    .split(/\s+/g)
    .map((token) => token.replaceAll(/[^0-9A-Za-zА-Яа-яЁё-]+/g, ""))
    .filter((token) => token.length > 0);

  for (const token of tokens) {
    const normalized = normalizeSearchText(token);
    if (normalized.length < 2) continue;
    if (/^\d/.test(normalized)) continue;
    if (MANUFACTURER_STOP_WORDS.has(normalized)) continue;
    return token;
  }

  return "Other";
}

function normalizePuffCount(value: number): number | null {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return null;
  if (rounded < 200 || rounded > 60_000) return null;
  return rounded;
}

function extractPuffCount(item: CatalogItem): number | null {
  const source = `${item.title} ${item.description ?? ""}`
    .toLowerCase()
    .replaceAll(",", ".")
    .replaceAll(/\s+/g, " ");

  const explicitK = source.match(
    /(\d{1,2}(?:\.\d+)?)\s*[kк]\s*(?:затяж(?:ек|ки|ка)?|puffs?|тяг)/iu,
  );
  if (explicitK) {
    const value = Number.parseFloat(explicitK[1]);
    const normalized = normalizePuffCount(value * 1000);
    if (normalized !== null) return normalized;
  }

  const explicitNumeric = source.match(/(\d{3,5})\s*(?:затяж(?:ек|ки|ка)?|puffs?|тяг)/iu);
  if (explicitNumeric) {
    const value = Number.parseInt(explicitNumeric[1], 10);
    const normalized = normalizePuffCount(value);
    if (normalized !== null) return normalized;
  }

  const disposableHint =
    item.categorySlug.trim().toLowerCase() === "disposable" ||
    /однораз|disposable/.test(source);
  if (!disposableHint) {
    return null;
  }

  const fallbackK = source.match(/(?:^|\D)(\d{1,2}(?:\.\d+)?)\s*[kк](?:\D|$)/iu);
  if (fallbackK) {
    const value = Number.parseFloat(fallbackK[1]);
    const normalized = normalizePuffCount(value * 1000);
    if (normalized !== null) return normalized;
  }

  const fallbackNumeric = source.match(/(?:^|\D)(\d{3,5})(?:\D|$)/u);
  if (fallbackNumeric) {
    const value = Number.parseInt(fallbackNumeric[1], 10);
    const normalized = normalizePuffCount(value);
    if (normalized !== null) return normalized;
  }

  return null;
}

function parsePositiveIntInput(value: string): number | null {
  const digitsOnly = value.replaceAll(/\D+/g, "");
  if (digitsOnly.length === 0) return null;
  const parsed = Number.parseInt(digitsOnly, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

type CatalogImagePreview = { src: string; alt: string };

function ProductCard({
  item,
  isFavorite,
  imageLoading,
  onAdd,
  onToggleFavorite,
  onOpenImage,
}: {
  item: CatalogItem;
  isFavorite: boolean;
  imageLoading: "eager" | "lazy";
  onAdd: () => void;
  onToggleFavorite: () => void;
  onOpenImage: (preview: CatalogImagePreview) => void;
}) {
  const previewImageSrc = useMemo(
    () => buildImageCandidates(item.imageUrl, { targetWidth: 1280 })[0] ?? null,
    [item.imageUrl],
  );

  return (
    <article className="flex h-full flex-col gap-2">
      <div className="relative overflow-hidden rounded-[20px] border border-border/60">
        {previewImageSrc ? (
          <button
            type="button"
            className="block w-full cursor-zoom-in rounded-[20px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label={`Открыть фото товара ${item.title}`}
            onClick={() => onOpenImage({ src: previewImageSrc, alt: item.title })}
          >
            <ProductImagePreview
              imageUrl={item.imageUrl}
              alt={item.title}
              loading={imageLoading}
              targetWidth={360}
              className="h-[224px] w-full rounded-[20px] object-cover"
              placeholderClassName="flex h-[224px] w-full items-center justify-center rounded-[20px] bg-muted text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            />
          </button>
        ) : (
          <ProductImagePreview
            imageUrl={item.imageUrl}
            alt={item.title}
            loading={imageLoading}
            targetWidth={360}
            className="h-[224px] w-full rounded-[20px] object-cover"
            placeholderClassName="flex h-[224px] w-full items-center justify-center rounded-[20px] bg-muted text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          />
        )}

        <button
          type="button"
          aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={isFavorite}
          className={[
            "absolute right-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-full border border-border/70 backdrop-blur-sm transition-colors",
            isFavorite
              ? "bg-destructive text-destructive-foreground"
              : "bg-background/65 text-foreground hover:bg-background/80",
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
          className="absolute bottom-3 right-3 z-10 grid h-12 w-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-glow disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
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
        <div className="text-[clamp(1.15rem,4.5vw,1.45rem)] font-black leading-none text-foreground">
          {formatPriceRub(item.price)}
        </div>
        <div className="mt-1 line-clamp-2 min-h-[2.6em] text-[clamp(0.86rem,3.25vw,1rem)] font-normal leading-snug text-foreground/85">
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

type CatalogRow = {
  item: CatalogItem;
  categoryId: string;
  manufacturerId: string;
  manufacturerLabel: string;
  puffCount: number | null;
};

type CatalogSortMode =
  | "none"
  | "price_asc"
  | "price_desc"
  | "title_asc"
  | "title_desc";
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
  const [selectedManufacturerIds, setSelectedManufacturerIds] = useState<string[]>([]);
  const [sortMode, setSortMode] = useState<CatalogSortMode>("none");
  const [onlyInStock, setOnlyInStock] = useState(false);
  const [puffRangeMinInput, setPuffRangeMinInput] = useState("");
  const [puffRangeMaxInput, setPuffRangeMaxInput] = useState("");
  const [sortOpen, setSortOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [imagePreview, setImagePreview] = useState<CatalogImagePreview | null>(null);
  const [toast, setToast] = useState<CatalogToast | null>(null);
  const toastKeyRef = useRef(0);
  const [renderedCount, setRenderedCount] = useState(CATALOG_INITIAL_RENDER_COUNT);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const prefetchedImageUrlsRef = useRef<Set<string>>(new Set());

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

  const catalogRows = useMemo<CatalogRow[]>(() => {
    return items.map((item) => {
      const manufacturerLabel = extractManufacturerLabel(item.title);
      return {
        item,
        categoryId:
          typeof item.categorySlug === "string" && item.categorySlug.trim().length > 0
            ? item.categorySlug.trim().toLowerCase()
            : "other",
        manufacturerLabel,
        manufacturerId: normalizeManufacturerId(manufacturerLabel),
        puffCount: extractPuffCount(item),
      };
    });
  }, [items]);

  const categories = useMemo<CategoryStat[]>(() => {
    const counts = new Map<string, number>();
    for (const row of catalogRows) {
      counts.set(row.categoryId, (counts.get(row.categoryId) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([id, count]) => ({ id, count, label: formatCategoryLabel(id) }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ru"));
  }, [catalogRows]);

  const manufacturers = useMemo<CategoryStat[]>(() => {
    const stats = new Map<string, { label: string; count: number }>();
    for (const row of catalogRows) {
      const prev = stats.get(row.manufacturerId);
      if (prev) {
        prev.count += 1;
      } else {
        stats.set(row.manufacturerId, { label: row.manufacturerLabel, count: 1 });
      }
    }

    return Array.from(stats.entries())
      .map(([id, value]) => ({ id, label: value.label, count: value.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ru"));
  }, [catalogRows]);

  useEffect(() => {
    const available = new Set(categories.map((x) => x.id));
    setSelectedCategoryIds((prev) => {
      const next = prev.filter((id) => available.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [categories]);

  useEffect(() => {
    const available = new Set(manufacturers.map((x) => x.id));
    setSelectedManufacturerIds((prev) => {
      const next = prev.filter((id) => available.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [manufacturers]);

  const selectedCategoriesSet = useMemo(() => {
    return new Set(selectedCategoryIds);
  }, [selectedCategoryIds]);

  const selectedManufacturersSet = useMemo(() => {
    return new Set(selectedManufacturerIds);
  }, [selectedManufacturerIds]);

  const normalizedSearchQuery = useMemo(() => {
    return normalizeSearchText(searchQuery);
  }, [searchQuery]);

  const puffRange = useMemo(() => {
    const min = parsePositiveIntInput(puffRangeMinInput);
    const max = parsePositiveIntInput(puffRangeMaxInput);
    if (min === null && max === null) return null;
    if (min !== null && max !== null && min > max) {
      return { min: max, max: min };
    }
    return { min, max };
  }, [puffRangeMaxInput, puffRangeMinInput]);

  const puffBounds = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    let count = 0;
    for (const row of catalogRows) {
      if (row.puffCount === null) continue;
      if (row.puffCount < min) min = row.puffCount;
      if (row.puffCount > max) max = row.puffCount;
      count += 1;
    }
    if (count === 0) return null;
    return { min, max };
  }, [catalogRows]);

  const activeFilterCount = useMemo(() => {
    return (
      selectedCategoryIds.length +
      selectedManufacturerIds.length +
      (puffRange ? 1 : 0)
    );
  }, [puffRange, selectedCategoryIds.length, selectedManufacturerIds.length]);

  const filtersSummary = useMemo(() => {
    const parts: string[] = [];
    if (selectedCategoryIds.length > 0) {
      parts.push(`Категорий: ${selectedCategoryIds.length}`);
    }
    if (selectedManufacturerIds.length > 0) {
      parts.push(`Производителей: ${selectedManufacturerIds.length}`);
    }
    if (puffRange) {
      const minLabel = puffRange.min ?? "0";
      const maxLabel = puffRange.max ?? "∞";
      parts.push(`Затяжки: ${minLabel}-${maxLabel}`);
    }
    return parts.join(" • ");
  }, [puffRange, selectedCategoryIds.length, selectedManufacturerIds.length]);

  useEffect(() => {
    if (!toast) return;
    const timeoutId = window.setTimeout(() => {
      setToast(null);
    }, 1700);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [toast]);

  useEffect(() => {
    if (!imagePreview || typeof window === "undefined") return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setImagePreview(null);
      }
    };

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [imagePreview]);

  const visibleItems = useMemo(() => {
    const preFilteredRows = catalogRows.filter((row) => {
      if (selectedCategoryIds.length > 0 && !selectedCategoriesSet.has(row.categoryId)) {
        return false;
      }
      if (
        selectedManufacturerIds.length > 0 &&
        !selectedManufacturersSet.has(row.manufacturerId)
      ) {
        return false;
      }
      if (onlyInStock && !row.item.inStock) {
        return false;
      }
      if (puffRange) {
        if (row.puffCount === null) return false;
        if (puffRange.min !== null && row.puffCount < puffRange.min) return false;
        if (puffRange.max !== null && row.puffCount > puffRange.max) return false;
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

    if (sortMode === "price_asc") {
      return [...scoredItems]
        .sort(
          (a, b) =>
            a.item.price - b.item.price ||
            b.score - a.score ||
            a.item.title.localeCompare(b.item.title, "ru"),
        )
        .map((entry) => entry.item);
    }

    if (sortMode === "price_desc") {
      return [...scoredItems]
        .sort(
          (a, b) =>
            b.item.price - a.item.price ||
            b.score - a.score ||
            a.item.title.localeCompare(b.item.title, "ru"),
        )
        .map((entry) => entry.item);
    }

    if (sortMode === "title_asc") {
      return [...scoredItems]
        .sort(
          (a, b) =>
            a.item.title.localeCompare(b.item.title, "ru") ||
            b.score - a.score ||
            a.item.price - b.item.price,
        )
        .map((entry) => entry.item);
    }

    if (sortMode === "title_desc") {
      return [...scoredItems]
        .sort(
          (a, b) =>
            b.item.title.localeCompare(a.item.title, "ru") ||
            b.score - a.score ||
            a.item.price - b.item.price,
        )
        .map((entry) => entry.item);
    }

    if (normalizedSearchQuery.length > 0) {
      return [...scoredItems]
        .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, "ru"))
        .map((entry) => entry.item);
    }

    return scoredItems.map((entry) => entry.item);
  }, [
    catalogRows,
    normalizedSearchQuery,
    onlyInStock,
    puffRange,
    selectedCategoriesSet,
    selectedCategoryIds.length,
    selectedManufacturerIds.length,
    selectedManufacturersSet,
    sortMode,
  ]);

  useEffect(() => {
    setRenderedCount(Math.min(CATALOG_INITIAL_RENDER_COUNT, visibleItems.length));
    prefetchedImageUrlsRef.current.clear();
  }, [visibleItems]);

  const renderedItems = useMemo(() => {
    return visibleItems.slice(0, renderedCount);
  }, [visibleItems, renderedCount]);

  const hasMoreToRender = renderedItems.length < visibleItems.length;

  useEffect(() => {
    if (!hasMoreToRender) return;
    if (typeof window === "undefined" || typeof window.IntersectionObserver === "undefined") {
      return;
    }

    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel) return;

    const observer = new window.IntersectionObserver(
      (entries) => {
        const shouldLoadMore = entries.some((entry) => entry.isIntersecting);
        if (!shouldLoadMore) return;
        setRenderedCount((prev) => Math.min(prev + CATALOG_RENDER_STEP, visibleItems.length));
      },
      {
        root: null,
        rootMargin: "900px 0px 900px 0px",
        threshold: 0.01,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreToRender, visibleItems.length]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (renderedCount >= visibleItems.length) return;

    const prefetched = prefetchedImageUrlsRef.current;
    const queue: string[] = [];
    const nextBatch = visibleItems.slice(
      renderedCount,
      Math.min(renderedCount + CATALOG_IMAGE_PREFETCH_AHEAD, visibleItems.length),
    );

    for (const item of nextBatch) {
      const bestCandidate = buildImageCandidates(item.imageUrl, { targetWidth: 360 })[0] ?? null;
      if (!bestCandidate) continue;
      if (prefetched.has(bestCandidate)) continue;
      prefetched.add(bestCandidate);
      queue.push(bestCandidate);
    }

    if (queue.length === 0) return;

    const preload = () => {
      for (const url of queue) {
        const img = new Image();
        img.decoding = "async";
        img.src = url;
      }
    };

    const idleWindow = window as Window & {
      requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      const idleId = idleWindow.requestIdleCallback(preload, { timeout: 600 });
      return () => {
        if (typeof idleWindow.cancelIdleCallback === "function") {
          idleWindow.cancelIdleCallback(idleId);
        }
      };
    }

    const timeoutId = window.setTimeout(preload, 120);
    return () => window.clearTimeout(timeoutId);
  }, [visibleItems, renderedCount]);

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

  function toggleManufacturer(manufacturerId: string): void {
    setSelectedManufacturerIds((prev) =>
      prev.includes(manufacturerId)
        ? prev.filter((id) => id !== manufacturerId)
        : [...prev, manufacturerId],
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
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
            Город
          </div>
          <div className="mt-1 text-lg font-semibold text-foreground">
            {cityLabel ?? "Не выбран"}
          </div>
        </div>

        <button
          type="button"
          className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-background"
          onClick={() => dispatch({ type: "city/clear" })}
        >
          Сменить город
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex flex-1 items-center gap-2">
              <button
                type="button"
                className={[
                  "inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors",
                  sortMode === "none" && !onlyInStock
                    ? "border-border/70 bg-background text-foreground/85 hover:bg-muted/55"
                    : "border-primary bg-primary text-white",
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
                className={[
                  "inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors",
                  activeFilterCount === 0
                    ? "border-border/70 bg-background text-foreground hover:bg-muted/55"
                    : "border-primary bg-primary text-white",
                ].join(" ")}
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
                {activeFilterCount > 0 ? (
                  <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    {activeFilterCount}
                  </span>
                ) : null}
              </button>
          </div>

          <button
            type="button"
            aria-label={searchOpen ? "Закрыть поиск" : "Открыть поиск"}
            className={[
              "grid h-10 w-10 shrink-0 place-items-center rounded-full border transition-colors",
              searchOpen
                ? "border-primary bg-primary text-white"
                : "border-border/70 bg-background text-foreground/80 hover:bg-muted/55",
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
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/80"
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
              className="h-10 w-full rounded-xl border border-border/70 bg-background pl-9 pr-3 text-xs font-medium text-foreground placeholder:text-muted-foreground/80 focus:border-primary focus:outline-none"
              autoFocus
            />
          </label>
        ) : null}
      </div>

      {!supabaseEnabled ? (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          Supabase env не задан: используется мок-каталог (DEV).
          <div className="mt-1 text-xs text-amber-300">
            Заполните `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY` в `.env.local`.
          </div>
        </div>
      ) : null}

      {supabaseEnabled && error ? (
        <div className="rounded-2xl border border-destructive/35 bg-destructive/10 p-4">
          <div className="text-sm font-semibold text-destructive">Ошибка загрузки каталога</div>
          <div className="mt-1 text-xs text-destructive/90">{error.message}</div>
          {import.meta.env.DEV && error.devDetails ? (
            <div className="mt-2 rounded-xl border border-destructive/35 bg-background px-3 py-2 font-mono text-[11px] text-destructive">
              <div>{error.devDetails}</div>
              {error.devDetails.includes("code=BAD_RESPONSE") ? (
                <div className="mt-1 text-destructive/90">
                  DEV: проверьте, что API доступен (`/api/catalog?citySlug=vvo`), и что
                  dev-proxy направлен на рабочий backend (`VITE_DEV_API_TARGET`) или локальный
                  API запущен.
                </div>
              ) : (
                <div className="mt-1 text-destructive/90">
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
        <div className="rounded-2xl border border-border/70 bg-card/90 p-6 text-center">
          <div className="text-lg font-semibold">Нет товаров</div>
          <div className="mt-2 text-sm text-muted-foreground">
            Попробуйте снять часть фильтров или выбрать другой город.
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 auto-rows-fr gap-3">
            {renderedItems.map((item, index) => (
              <ProductCard
                key={item.id}
                item={item}
                isFavorite={favoriteIds.has(item.id)}
                imageLoading={index < 2 ? "eager" : "lazy"}
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
                onOpenImage={setImagePreview}
              />
            ))}
          </div>

          {hasMoreToRender ? (
            <div className="pt-2">
              <div ref={loadMoreSentinelRef} className="h-4 w-full" />
              <button
                type="button"
                className="mt-2 w-full rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55"
                onClick={() =>
                  setRenderedCount((prev) =>
                    Math.min(prev + CATALOG_RENDER_STEP, visibleItems.length),
                  )
                }
              >
                {`Показать ещё (${renderedItems.length} из ${visibleItems.length})`}
              </button>
            </div>
          ) : null}
        </>
      )}

      {imagePreview ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-3 sm:p-6">
          <button
            type="button"
            className="absolute inset-0 cursor-zoom-out"
            aria-label="Закрыть превью изображения"
            onClick={() => setImagePreview(null)}
          />
          <div className="relative z-10 flex max-h-full w-full max-w-6xl items-center justify-center">
            <img
              src={imagePreview.src}
              alt={imagePreview.alt}
              className="max-h-[92vh] w-full max-w-[94vw] rounded-xl object-contain"
              loading="eager"
              decoding="sync"
              referrerPolicy="no-referrer"
            />
            <button
              type="button"
              className="absolute right-2 top-2 grid h-10 w-10 place-items-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75"
              aria-label="Закрыть превью изображения"
              onClick={() => setImagePreview(null)}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                <path
                  d="M6 6 18 18M18 6 6 18"
                  className="fill-none stroke-current"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>
      ) : null}

      {sortOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center px-4 pb-4 pt-16 sm:items-center">
          <button
            type="button"
            className="absolute inset-0 bg-background/70"
            aria-label="Закрыть сортировку"
            onClick={() => setSortOpen(false)}
          />

          <div className="relative w-full max-w-sm rounded-2xl border border-border/70 bg-card/90 p-4 shadow-xl">
            <div className="text-base font-semibold text-foreground">Сортировать по</div>

            <div className="mt-4 grid gap-2">
              <button
                type="button"
                className={[
                  "flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors",
                  onlyInStock
                    ? "border-primary bg-primary/20 text-[#b9d4ff]"
                    : "border-border/70 bg-background text-foreground/85 hover:bg-muted/55",
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
                  sortMode === "price_asc"
                    ? "border-primary bg-primary/20 text-[#b9d4ff]"
                    : "border-border/70 bg-background text-foreground/85 hover:bg-muted/55",
                ].join(" ")}
                onClick={() => {
                  setSortMode((prev) => (prev === "price_asc" ? "none" : "price_asc"));
                  setSortOpen(false);
                }}
              >
                <span>По возрастанию цены</span>
                {sortMode === "price_asc" ? <span aria-hidden="true">✓</span> : null}
              </button>

              <button
                type="button"
                className={[
                  "flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors",
                  sortMode === "price_desc"
                    ? "border-primary bg-primary/20 text-[#b9d4ff]"
                    : "border-border/70 bg-background text-foreground/85 hover:bg-muted/55",
                ].join(" ")}
                onClick={() => {
                  setSortMode((prev) => (prev === "price_desc" ? "none" : "price_desc"));
                  setSortOpen(false);
                }}
              >
                <span>По убыванию цены</span>
                {sortMode === "price_desc" ? <span aria-hidden="true">✓</span> : null}
              </button>

              <button
                type="button"
                className={[
                  "flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors",
                  sortMode === "title_asc"
                    ? "border-primary bg-primary/20 text-[#b9d4ff]"
                    : "border-border/70 bg-background text-foreground/85 hover:bg-muted/55",
                ].join(" ")}
                onClick={() => {
                  setSortMode((prev) => (prev === "title_asc" ? "none" : "title_asc"));
                  setSortOpen(false);
                }}
              >
                <span>По названию (А-Я)</span>
                {sortMode === "title_asc" ? <span aria-hidden="true">✓</span> : null}
              </button>

              <button
                type="button"
                className={[
                  "flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm font-medium transition-colors",
                  sortMode === "title_desc"
                    ? "border-primary bg-primary/20 text-[#b9d4ff]"
                    : "border-border/70 bg-background text-foreground/85 hover:bg-muted/55",
                ].join(" ")}
                onClick={() => {
                  setSortMode((prev) => (prev === "title_desc" ? "none" : "title_desc"));
                  setSortOpen(false);
                }}
              >
                <span>По названию (Я-А)</span>
                {sortMode === "title_desc" ? <span aria-hidden="true">✓</span> : null}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {filtersOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center px-4 pb-4 pt-16 sm:items-center">
          <button
            type="button"
            className="absolute inset-0 bg-background/70"
            aria-label="Закрыть фильтры"
            onClick={() => setFiltersOpen(false)}
          />

          <div className="relative w-full max-w-md rounded-2xl border border-border/70 bg-card/90 p-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-foreground">Фильтры каталога</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Здесь настраиваются все категории.
                </div>
              </div>

              <button
                type="button"
                className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90"
                onClick={() => setFiltersOpen(false)}
              >
                Готово
              </button>
            </div>

            <div className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Категории
            </div>
            {categories.length === 0 ? (
              <div className="mt-2 text-sm text-muted-foreground">
                Категории пока не найдены в текущем каталоге.
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {categories.map((category) => {
                  const active = selectedCategoriesSet.has(category.id);
                  return (
                    <button
                      key={category.id}
                      type="button"
                      className={[
                        "rounded-xl border px-3 py-2 text-xs font-semibold transition-colors",
                        active
                          ? "border-primary bg-primary text-white"
                          : "border-border/70 bg-background text-foreground/85 hover:bg-muted/55",
                      ].join(" ")}
                      onClick={() => toggleCategory(category.id)}
                    >
                      {category.label} ({category.count})
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Производитель
            </div>
            {manufacturers.length === 0 ? (
              <div className="mt-2 text-sm text-muted-foreground">
                Производители не определились автоматически.
              </div>
            ) : (
              <div className="mt-2 flex max-h-40 flex-wrap gap-2 overflow-y-auto pr-1">
                {manufacturers.map((manufacturer) => {
                  const active = selectedManufacturersSet.has(manufacturer.id);
                  return (
                    <button
                      key={manufacturer.id}
                      type="button"
                      className={[
                        "rounded-xl border px-3 py-2 text-xs font-semibold transition-colors",
                        active
                          ? "border-primary bg-primary text-white"
                          : "border-border/70 bg-background text-foreground/85 hover:bg-muted/55",
                      ].join(" ")}
                      onClick={() => toggleManufacturer(manufacturer.id)}
                    >
                      {manufacturer.label} ({manufacturer.count})
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Затяжки (одноразки)
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
                <span>От</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={puffRangeMinInput}
                  onChange={(event) =>
                    setPuffRangeMinInput(
                      event.target.value.replaceAll(/\D+/g, "").slice(0, 5),
                    )
                  }
                  placeholder={puffBounds ? String(puffBounds.min) : "1000"}
                  className="h-9 w-full min-w-0 rounded-lg border border-border/70 bg-background px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/80 focus:border-primary focus:outline-none"
                />
              </label>
              <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
                <span>До</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={puffRangeMaxInput}
                  onChange={(event) =>
                    setPuffRangeMaxInput(
                      event.target.value.replaceAll(/\D+/g, "").slice(0, 5),
                    )
                  }
                  placeholder={puffBounds ? String(puffBounds.max) : "4000"}
                  className="h-9 w-full min-w-0 rounded-lg border border-border/70 bg-background px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/80 focus:border-primary focus:outline-none"
                />
              </label>
            </div>
            {puffBounds ? (
              <div className="mt-2 break-words text-[11px] leading-snug text-muted-foreground">
                Доступный диапазон в каталоге: {puffBounds.min} - {puffBounds.max}
              </div>
            ) : (
              <div className="mt-2 text-[11px] text-muted-foreground">
                В каталоге нет товаров с распознанным числом затяжек.
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                className="rounded-xl border border-border/70 bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={activeFilterCount === 0}
                onClick={() => {
                  setSelectedCategoryIds([]);
                  setSelectedManufacturerIds([]);
                  setPuffRangeMinInput("");
                  setPuffRangeMaxInput("");
                }}
              >
                Сбросить
              </button>

              <div className="text-right text-xs text-muted-foreground">
                {activeFilterCount === 0 ? "Показаны все товары" : filtersSummary}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4 [bottom:calc(env(safe-area-inset-bottom,0px)+7.1rem)]">
          <div
            key={toast.key}
            className="w-full max-w-md rounded-2xl border border-border/80 bg-[linear-gradient(135deg,#2b3442_0%,#232a33_100%)] px-4 py-3.5 text-sm font-semibold text-foreground shadow-[0_14px_40px_rgba(0,0,0,0.5)] backdrop-blur"
          >
            <div className="flex items-center gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/25 text-[#8fbeff]">
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
