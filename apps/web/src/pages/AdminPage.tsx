import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ApiError,
  apiDelete,
  apiDownloadBlob,
  apiGet,
  apiPost,
  apiPut,
  apiUpload,
} from "../api/client";
import { buildApiUrl } from "../config";
import { fetchCatalog, type CatalogItem, type CitySlug } from "../supabase/catalog";
import {
  CATALOG_FILTER_CATEGORIES_UI,
  normalizeCatalogCategoryId,
  normalizeManufacturerId,
  resolveCatalogManufacturerLabel,
} from "./CatalogPage";

type AdminMe = {
  tgUserId: number;
  username: string | null;
  role: string;
};

type AdminCity = {
  id: number;
  name: string;
  slug: string;
};

type ImportProductsCsvResult = {
  delimiter: ";" | "," | "\t";
  decodedEncoding?: "utf-8" | "windows-1251" | "ibm866" | "koi8-r" | "xlsx";
  cities: Array<{ id: number; slug: string; name: string }>;
  rows: { total: number; valid: number; invalid: number };
  products: { inserted: number; updated: number };
  inventoryRows: number;
  sync: {
    citySlug: string | null;
    inventoryDeleted: number;
    productsDeleted: number;
    productsArchived: number;
  };
  generatedIds: boolean;
  outputXlsxBase64: string | null;
  errors: Array<{
    rowNum: number;
    id: string | null;
    title: string | null;
    messages: string[];
  }>;
};

type ImportPromoProductsCsvResult = {
  delimiter: ";" | "," | "\t";
  decodedEncoding?: "utf-8" | "windows-1251" | "ibm866" | "koi8-r" | "xlsx";
  cities: Array<{ id: number; slug: string; name: string }>;
  rows: { total: number; valid: number; invalid: number };
  promos: { upserted: number; deleted: number };
  errors: Array<{
    rowNum: number;
    productId: string | null;
    title: string | null;
    messages: string[];
  }>;
};

type UploadImagesResult = {
  saved: Array<{ originalName: string; fileName: string; size: number }>;
  errors: Array<{ originalName: string; message: string }>;
  baseUrl: string | null;
};

type UploadedImageFile = {
  name: string;
  size: number;
  updatedAt: string;
};

type AdminProductInventory = {
  city_id: number;
  city_slug: string;
  in_stock: boolean;
  stock_qty: number | null;
  price_override: number | null;
};

type AdminProduct = {
  id: string;
  title: string;
  description: string | null;
  base_price: number;
  image_url: string | null;
  is_active: boolean;
  inventory: AdminProductInventory[];
};

type AdminProductsTab = "active" | "archive";

type AdminProductsResponse = {
  tab: AdminProductsTab;
  limit: number;
  total: number;
  activeCount: number;
  archiveCount: number;
  items: AdminProduct[];
};

type OrderStatus = "new" | "processing" | "done";

type PromotionRuleType =
  | "buy_2_get_3_cheapest_free"
  | "buy_pod_get_liquid_cheapest_free";

type AdminPromotionRule = {
  id: number;
  cityId: number | null;
  citySlug: string | null;
  cityName: string | null;
  type: PromotionRuleType;
  adminTitle: string;
  publicTitle: string;
  categorySlug: string;
  brand: string | null;
  productIds: string[];
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  createdAt: string;
};

type AdminPromotionsResponse = {
  items: AdminPromotionRule[];
};

type AdminPromoCode = {
  code: string;
  discountAmount: number;
  startsAt: string;
  endsAt: string;
  maxUses: number;
  usedCount: number;
  isActive: boolean;
  createdAt: string;
};

type AdminPromoCodesResponse = {
  items: AdminPromoCode[];
};

type AdminPromoCodeDraft = {
  code: string;
  discountAmount: string;
  startsAt: string;
  endsAt: string;
  maxUses: string;
};

type AdminPromotionBrandOption = {
  brand: string;
  count: number;
};

type AdminPromotionModelOption = {
  productId: string;
  title: string;
  brand: string;
  price: number;
};

type AdminPromotionDraft = {
  type: PromotionRuleType;
  citySlug: string;
  categorySlug: string;
  brands: string[];
  modelScope: "brand" | "models";
  productIds: string[];
  startsAt: string;
  endsAt: string;
};

const PRODUCTS_PAGE_SIZE = 120;
const ORDERS_PAGE_SIZE = 50;
const ADMIN_REPORT_PASSWORD = "q81231";
const PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE =
  "buy_2_get_3_cheapest_free" as const;
const PROMOTION_TYPE_BUY_POD_GET_LIQUID_CHEAPEST_FREE =
  "buy_pod_get_liquid_cheapest_free" as const;
const PROMOTION_CATEGORY_OPTIONS = CATALOG_FILTER_CATEGORIES_UI.map((category) => ({
  value: category.id,
  label: category.label,
}));

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

function formatDeliveryMethodLabel(value: string): string {
  if (value === "pickup") return "Самовывоз";
  if (value === "delivery") return "Доставка";
  if (value === "express") return "Экспресс";
  return value;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU");
}

function getDateInputValue(daysFromToday = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildPublicFileUrl(baseUrl: string, name: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/g, "");
  const encodedPath = name
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${normalizedBase}/${encodedPath}`;
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-border/70 bg-card/90 p-4 shadow-sm">
      {children}
    </div>
  );
}

function formatCityLabel(city: Pick<AdminCity, "name" | "slug">): string {
  return `${city.name} (${city.slug.toUpperCase()})`;
}

function AdminImportProductsCityCard({ city }: { city: AdminCity }) {
  const [file, setFile] = useState<File | null>(null);
  const [useImagePrefix, setUseImagePrefix] = useState(false);
  const [csvEncoding, setCsvEncoding] = useState<
    "auto" | "utf-8" | "windows-1251" | "ibm866" | "koi8-r"
  >("auto");
  const [submitting, setSubmitting] = useState(false);
  const [downloadingLastXlsx, setDownloadingLastXlsx] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportProductsCsvResult | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState<string>("products.with_ids.xlsx");
  const [promoFile, setPromoFile] = useState<File | null>(null);
  const [promoCsvEncoding, setPromoCsvEncoding] = useState<
    "auto" | "utf-8" | "windows-1251" | "ibm866" | "koi8-r"
  >("auto");
  const [promoSubmitting, setPromoSubmitting] = useState(false);
  const [promoDownloading, setPromoDownloading] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoDownloadError, setPromoDownloadError] = useState<string | null>(null);
  const [promoResult, setPromoResult] = useState<ImportPromoProductsCsvResult | null>(null);

  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  async function runImport(): Promise<void> {
    if (!file) return;

    setSubmitting(true);
    setError(null);
    setDownloadError(null);
    setResult(null);

    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }

    try {
      const form = new FormData();
      form.append("file", file);

      const search = new URLSearchParams();
      search.set("citySlug", city.slug);
      if (useImagePrefix) search.set("imageMode", "filename");
      if (csvEncoding !== "auto") search.set("encoding", csvEncoding);
      const query = search.toString() ? `?${search.toString()}` : "";
      const res = await apiUpload<ImportProductsCsvResult>(
        `/api/admin/import/products${query}`,
        form,
      );
      setResult(res);

      if (res.outputXlsxBase64) {
        const binary = atob(res.outputXlsxBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        const url = URL.createObjectURL(blob);
        setDownloadUrl(url);

        const base = file.name.replace(/\.(csv|xlsx|xls)$/i, "");
        setDownloadName(`${base || "products"}.with_ids.xlsx`);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Import failed";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  function parseDownloadFileName(contentDisposition: string | null, fallback: string): string {
    if (!contentDisposition) return fallback;

    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      const encoded = utf8Match[1].trim().replace(/^"|"$/g, "");
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    }

    const basicMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    if (basicMatch?.[1]) {
      return basicMatch[1].trim();
    }

    return fallback;
  }

  async function downloadLastXlsx(): Promise<void> {
    setDownloadingLastXlsx(true);
    setDownloadError(null);
    try {
      const headers: Record<string, string> = {};
      const tgInitData = window.Telegram?.WebApp?.initData ?? "";
      if (tgInitData) {
        headers["x-telegram-init-data"] = tgInitData;
      }
      if (import.meta.env.DEV && !tgInitData) {
        headers["x-dev-admin"] = "1";
      }

      const query = `?${new URLSearchParams({ citySlug: city.slug }).toString()}`;

      let res = await fetch(buildApiUrl(`/api/admin/export/products.xlsx${query}`), {
        method: "GET",
        headers,
      });
      if (res.status === 404) {
        res = await fetch(buildApiUrl(`/api/admin/export/products${query}`), {
          method: "GET",
          headers,
        });
      }

      if (!res.ok) {
        let message = `Failed to download XLSX (${res.status})`;
        try {
          const payload = (await res.json()) as {
            ok?: boolean;
            error?: { message?: string };
          };
          const apiMessage = payload?.error?.message;
          if (typeof apiMessage === "string" && apiMessage.trim().length > 0) {
            message = apiMessage;
          }
        } catch {
          // ignore JSON parse failures for non-JSON error responses
        }
        throw new Error(message);
      }

      const blob = await res.blob();
      const fallbackName = `products.${city.slug}.latest.${new Date().toISOString().slice(0, 10)}.xlsx`;
      const fileName = parseDownloadFileName(
        res.headers.get("content-disposition"),
        fallbackName,
      );
      const objectUrl = URL.createObjectURL(blob);

      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to download XLSX";
      setDownloadError(message);
    } finally {
      setDownloadingLastXlsx(false);
    }
  }

  async function runPromoImport(): Promise<void> {
    if (!promoFile) return;

    setPromoSubmitting(true);
    setPromoError(null);
    setPromoDownloadError(null);
    setPromoResult(null);

    try {
      const form = new FormData();
      form.append("file", promoFile);

      const search = new URLSearchParams();
      search.set("citySlug", city.slug);
      if (promoCsvEncoding !== "auto") search.set("encoding", promoCsvEncoding);
      const query = search.toString() ? `?${search.toString()}` : "";
      const res = await apiUpload<ImportPromoProductsCsvResult>(
        `/api/admin/import/promos${query}`,
        form,
      );
      setPromoResult(res);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Promo import failed";
      setPromoError(message);
    } finally {
      setPromoSubmitting(false);
    }
  }

  async function downloadPromoXlsx(): Promise<void> {
    setPromoDownloading(true);
    setPromoDownloadError(null);
    try {
      const headers: Record<string, string> = {};
      const tgInitData = window.Telegram?.WebApp?.initData ?? "";
      if (tgInitData) {
        headers["x-telegram-init-data"] = tgInitData;
      }
      if (import.meta.env.DEV && !tgInitData) {
        headers["x-dev-admin"] = "1";
      }

      const query = `?${new URLSearchParams({ citySlug: city.slug }).toString()}`;
      let res = await fetch(buildApiUrl(`/api/admin/export/promos.xlsx${query}`), {
        method: "GET",
        headers,
      });
      if (res.status === 404) {
        res = await fetch(buildApiUrl(`/api/admin/export/promos${query}`), {
          method: "GET",
          headers,
        });
      }

      if (!res.ok) {
        let message = `Failed to download promo XLSX (${res.status})`;
        try {
          const payload = (await res.json()) as {
            ok?: boolean;
            error?: { message?: string };
          };
          const apiMessage = payload?.error?.message;
          if (typeof apiMessage === "string" && apiMessage.trim().length > 0) {
            message = apiMessage;
          }
        } catch {
          // ignore JSON parse failures for non-JSON error responses
        }
        throw new Error(message);
      }

      const blob = await res.blob();
      const fallbackName = `promo-products.${city.slug}.latest.${new Date().toISOString().slice(0, 10)}.xlsx`;
      const fileName = parseDownloadFileName(
        res.headers.get("content-disposition"),
        fallbackName,
      );
      const objectUrl = URL.createObjectURL(blob);

      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to download promo XLSX";
      setPromoDownloadError(message);
    } finally {
      setPromoDownloading(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">
            Import products: {formatCityLabel(city)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground/80">
            Upload a CSV/XLSX file for this city only.
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-slate-600"
            disabled={!file || submitting || downloadingLastXlsx}
            onClick={() => void runImport()}
          >
            {submitting ? "Importing..." : "Import"}
          </button>
          <button
            type="button"
            className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={downloadingLastXlsx || submitting}
            onClick={() => void downloadLastXlsx()}
          >
            {downloadingLastXlsx ? "Preparing..." : `Download ${city.slug.toUpperCase()} XLSX`}
          </button>
        </div>
      </div>

      <div className="mt-3">
        <input
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          disabled={submitting}
          onChange={(e) => {
            const next = e.target.files?.[0] ?? null;
            setFile(next);
            setResult(null);
            setError(null);
          }}
        />
      </div>

      <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-600"
          checked={useImagePrefix}
          disabled={submitting}
          onChange={(e) => setUseImagePrefix(e.target.checked)}
        />
        image_url = имя файла (добавить префикс)
      </label>

      <label className="mt-2 block text-xs text-muted-foreground">
        CSV encoding
        <select
          className="mt-1 block rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-100"
          value={csvEncoding}
          disabled={submitting}
          onChange={(e) =>
            setCsvEncoding(
              e.target.value as "auto" | "utf-8" | "windows-1251" | "ibm866" | "koi8-r",
            )
          }
        >
          <option value="auto">auto (recommended)</option>
          <option value="utf-8">utf-8</option>
          <option value="windows-1251">windows-1251</option>
          <option value="ibm866">ibm866</option>
          <option value="koi8-r">koi8-r</option>
        </select>
      </label>

      {error ? (
        <div className="mt-3 rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {downloadError ? (
        <div className="mt-3 rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {downloadError}
        </div>
      ) : null}

      {result ? (
        <div className="mt-3 space-y-2 text-sm text-foreground/80">
          <div>Cities: {result.cities.map((item) => item.slug.toUpperCase()).join(", ")}</div>
          <div>
            Rows: total={result.rows.total} valid={result.rows.valid} invalid={result.rows.invalid}
          </div>
          {result.decodedEncoding ? <div>Decoded encoding: {result.decodedEncoding}</div> : null}
          <div>
            Products: inserted={result.products.inserted} updated={result.products.updated}
          </div>
          <div>Inventory rows: {result.inventoryRows}</div>
          <div>
            Sync cleanup: city={result.sync.citySlug?.toUpperCase() ?? "ALL"}{" "}
            inventory deleted={result.sync.inventoryDeleted} products deleted=
            {result.sync.productsDeleted} archived={result.sync.productsArchived}
          </div>
          {downloadUrl ? (
            <div>
              <a
                href={downloadUrl}
                download={downloadName}
                className="text-sm font-semibold text-[#66a3ff] hover:text-[#8fb9ff]"
              >
                Download XLSX with generated IDs
              </a>
            </div>
          ) : null}

          {result.errors.length > 0 ? (
            <details className="rounded-xl border border-border/70 bg-muted/55 px-3 py-2">
              <summary className="cursor-pointer text-sm font-semibold text-foreground">
                Errors ({result.errors.length})
              </summary>
              <div className="mt-2 space-y-2 text-xs text-foreground/80">
                {result.errors.slice(0, 20).map((er) => (
                  <div key={`row-${er.rowNum}`}>
                    <div className="font-semibold">
                      row {er.rowNum}
                      {er.title ? ` (${er.title})` : ""}
                    </div>
                    <div className="text-foreground/80">{er.messages.join("; ")}</div>
                  </div>
                ))}
                {result.errors.length > 20 ? (
                  <div className="text-muted-foreground">...and {result.errors.length - 20} more</div>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 border-t border-border/70 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">
              Promo products: {formatCityLabel(city)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground/80">
              Download the city table, fill promo_old_price and promo_new_price, then import it.
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <button
              type="button"
              className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-slate-600"
              disabled={!promoFile || promoSubmitting || promoDownloading}
              onClick={() => void runPromoImport()}
            >
              {promoSubmitting ? "Importing..." : "Import promo"}
            </button>
            <button
              type="button"
              className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={promoDownloading || promoSubmitting}
              onClick={() => void downloadPromoXlsx()}
            >
              {promoDownloading ? "Preparing..." : `Download promo ${city.slug.toUpperCase()} XLSX`}
            </button>
          </div>
        </div>

        <div className="mt-3">
          <input
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            disabled={promoSubmitting}
            onChange={(e) => {
              const next = e.target.files?.[0] ?? null;
              setPromoFile(next);
              setPromoResult(null);
              setPromoError(null);
            }}
          />
        </div>

        <label className="mt-2 block text-xs text-muted-foreground">
          CSV encoding
          <select
            className="mt-1 block rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-100"
            value={promoCsvEncoding}
            disabled={promoSubmitting}
            onChange={(e) =>
              setPromoCsvEncoding(
                e.target.value as "auto" | "utf-8" | "windows-1251" | "ibm866" | "koi8-r",
              )
            }
          >
            <option value="auto">auto (recommended)</option>
            <option value="utf-8">utf-8</option>
            <option value="windows-1251">windows-1251</option>
            <option value="ibm866">ibm866</option>
            <option value="koi8-r">koi8-r</option>
          </select>
        </label>

        {promoError ? (
          <div className="mt-3 rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {promoError}
          </div>
        ) : null}
        {promoDownloadError ? (
          <div className="mt-3 rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {promoDownloadError}
          </div>
        ) : null}

        {promoResult ? (
          <div className="mt-3 space-y-2 text-sm text-foreground/80">
            <div>
              Rows: total={promoResult.rows.total} valid={promoResult.rows.valid} invalid=
              {promoResult.rows.invalid}
            </div>
            {promoResult.decodedEncoding ? (
              <div>Decoded encoding: {promoResult.decodedEncoding}</div>
            ) : null}
            <div>
              Promo rows: upserted={promoResult.promos.upserted} deleted=
              {promoResult.promos.deleted}
            </div>

            {promoResult.errors.length > 0 ? (
              <details className="rounded-xl border border-border/70 bg-muted/55 px-3 py-2">
                <summary className="cursor-pointer text-sm font-semibold text-foreground">
                  Promo errors ({promoResult.errors.length})
                </summary>
                <div className="mt-2 space-y-2 text-xs text-foreground/80">
                  {promoResult.errors.slice(0, 20).map((er) => (
                    <div key={`promo-row-${er.rowNum}`}>
                      <div className="font-semibold">
                        row {er.rowNum}
                        {er.title ? ` (${er.title})` : ""}
                      </div>
                      <div className="text-foreground/80">{er.messages.join("; ")}</div>
                    </div>
                  ))}
                  {promoResult.errors.length > 20 ? (
                    <div className="text-muted-foreground">
                      ...and {promoResult.errors.length - 20} more
                    </div>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function AdminImportProductsCsv() {
  const [cities, setCities] = useState<AdminCity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCities = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<AdminCity[]>("/api/admin/cities");
      setCities(data);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to load cities";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCities();
  }, [loadCities]);

  if (loading) {
    return (
      <Card>
        <div className="text-sm font-semibold">Import products by city</div>
        <div className="mt-3 h-20 animate-pulse rounded-2xl bg-muted/60" />
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <div className="text-sm font-semibold">Import products by city</div>
        <div className="mt-3 rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
        <button
          type="button"
          className="mt-3 rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55"
          onClick={() => void loadCities()}
        >
          Reload
        </button>
      </Card>
    );
  }

  if (cities.length === 0) {
    return (
      <Card>
        <div className="text-sm font-semibold">Import products by city</div>
        <div className="mt-2 text-sm text-muted-foreground">No cities found.</div>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      {cities.map((city) => (
        <AdminImportProductsCityCard key={city.id} city={city} />
      ))}
    </div>
  );
}

function AdminUploadImages() {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadImagesResult | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [files, setFiles] = useState<UploadedImageFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [deletingFiles, setDeletingFiles] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const selectedFilesSet = useMemo(() => new Set(selectedFiles), [selectedFiles]);
  const selectedCount = selectedFiles.length;

  const loadFiles = useCallback(async (): Promise<void> => {
    setLoadingFiles(true);
    setListError(null);
    try {
      const res = await apiGet<{ files: UploadedImageFile[]; baseUrl: string | null }>(
        "/api/admin/upload/items",
      );
      setFiles(res.files);
      if (res.baseUrl) setBaseUrl(res.baseUrl);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to load files";
      setListError(message);
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  useEffect(() => {
    if (!filesOpen) return;
    void loadFiles();
  }, [filesOpen, loadFiles]);

  useEffect(() => {
    setSelectedFiles((prev) =>
      prev.filter((name) => files.some((file) => file.name === name)),
    );
  }, [files]);

  useEffect(() => {
    if (filesOpen) return;
    setSelectedFiles([]);
  }, [filesOpen]);

  async function handleUpload(files: FileList | null): Promise<void> {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) {
      setError("Не выбран ни один файл");
      return;
    }

    setUploading(true);
    setError(null);
    setResult(null);

    try {
      const form = new FormData();
      for (const f of list) {
        form.append("files", f, f.name);
      }

      const res = await apiUpload<UploadImagesResult>("/api/admin/upload/items", form);
      setResult(res);
      if (res.baseUrl) setBaseUrl(res.baseUrl);
      await loadFiles();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Upload failed";
      setError(message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(name: string): Promise<void> {
    setError(null);
    setDeletingFiles(true);
    try {
      await apiDelete(`/api/admin/upload/items/${encodeURIComponent(name)}`);
      await loadFiles();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Delete failed";
      setError(message);
    } finally {
      setDeletingFiles(false);
    }
  }

  async function deleteFiles(names: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (const name of names) {
      try {
        await apiDelete(`/api/admin/upload/items/${encodeURIComponent(name)}`);
      } catch {
        failed.push(name);
      }
    }

    await loadFiles();
    return failed;
  }

  async function handleDeleteSelected(): Promise<void> {
    if (selectedCount === 0) return;
    const names = [...selectedFiles];
    const confirmed = window.confirm(
      names.length === 1
        ? `Удалить выбранный файл "${names[0]}"?`
        : `Удалить выбранные файлы (${names.length})?`,
    );
    if (!confirmed) return;

    setDeletingFiles(true);
    setError(null);
    try {
      const failed = await deleteFiles(names);
      if (failed.length > 0) {
        setError(`Failed to delete ${failed.length} of ${names.length} selected files`);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Delete failed";
      setError(message);
    } finally {
      setDeletingFiles(false);
    }
  }

  async function handleDeleteAll(): Promise<void> {
    if (files.length === 0) return;
    const names = files.map((file) => file.name);
    const confirmed = window.confirm(`Delete all files (${names.length})?`);
    if (!confirmed) return;

    setDeletingFiles(true);
    setError(null);
    try {
      const failed = await deleteFiles(names);
      if (failed.length > 0) {
        setError(`Failed to delete ${failed.length} of ${names.length} files`);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Delete failed";
      setError(message);
    } finally {
      setDeletingFiles(false);
    }
  }

  async function handleRename(from: string): Promise<void> {
    const next = (renameDrafts[from] ?? "").trim();
    if (!next) {
      setError("Введите новое имя файла");
      return;
    }
    setError(null);
    try {
      await apiPost("/api/admin/upload/items/rename", { from, to: next });
      setRenameDrafts((prev) => {
        const copy = { ...prev };
        delete copy[from];
        return copy;
      });
      await loadFiles();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Rename failed";
      setError(message);
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Upload product images</div>
          <div className="mt-1 text-xs text-muted-foreground/80">
            Назови файлы как id/slug товара (например: pods-grape.jpg).
          </div>
        </div>
      </div>

      <div className="mt-3">
        <input
          type="file"
          multiple
          accept=".webp,image/webp,.jpg,.jpeg,.png,.heic,image/*"
          disabled={uploading}
          onChange={(e) => {
            void handleUpload(e.target.files);
            e.currentTarget.value = "";
          }}
        />
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="mt-3 space-y-2 text-sm text-foreground/80">
          <div>Загружено: {result.saved.length}</div>
          {result.errors.length > 0 ? (
            <div className="text-destructive/85">Ошибки: {result.errors.length}</div>
          ) : null}
          {result.baseUrl ? (
            <div className="text-xs text-muted-foreground/80">Base URL: {result.baseUrl}</div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4">
        <button
          type="button"
          className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55"
          onClick={() => setFilesOpen(true)}
        >
          Файлы
        </button>
      </div>

      {filesOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-4 sm:py-10">
          <button
            type="button"
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setFilesOpen(false)}
            aria-label="Закрыть"
          />
          <div className="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col rounded-2xl bg-card/90 p-4 shadow-xl">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold">Файлы</div>
                {baseUrl ? (
                  <div className="mt-1 break-all text-xs text-muted-foreground/80">Base URL: {baseUrl}</div>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {files.length > 0 ? (
                  <div className="text-xs text-muted-foreground/80">Выбрано: {selectedCount}</div>
                ) : null}
                <button
                  type="button"
                  className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55"
                  disabled={loadingFiles || deletingFiles}
                  onClick={() => void loadFiles()}
                >
                  Обновить
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={loadingFiles || deletingFiles || selectedCount === 0}
                  onClick={() => void handleDeleteSelected()}
                >
                  Удалить выбранные
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={loadingFiles || deletingFiles || files.length === 0}
                  onClick={() => void handleDeleteAll()}
                >
                  Delete all
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90"
                  onClick={() => setFilesOpen(false)}
                >
                  Закрыть
                </button>
              </div>
            </div>

            <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
            {listError ? (
              <div className="mt-3 rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {listError}
              </div>
            ) : null}

            {loadingFiles ? (
              <div className="mt-3 text-xs text-muted-foreground/80">Загрузка...</div>
            ) : files.length === 0 ? (
              <div className="mt-3 text-xs text-muted-foreground/80">Файлов нет</div>
            ) : (
              <div className="mt-3 space-y-2">
                {files.map((f) => {
                  const isSelected = selectedFilesSet.has(f.name);

                  return (
                    <div
                    key={f.name}
                    className={`grid grid-cols-[minmax(0,1fr)_40px_96px] gap-3 rounded-xl border p-3 text-xs transition-colors sm:grid-cols-[minmax(0,1fr)_48px_200px] ${
                      isSelected
                        ? "border-primary/60 bg-primary/10"
                        : "border-border/70 bg-muted/55"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground">
                        {f.name}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {Math.round(f.size / 1024)} KB
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <input
                          className="h-8 w-44 rounded-lg border border-border/70 bg-card/90 px-2 text-xs"
                          placeholder="Новое имя"
                          value={renameDrafts[f.name] ?? ""}
                          disabled={deletingFiles}
                          onChange={(e) =>
                            setRenameDrafts((prev) => ({ ...prev, [f.name]: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="rounded-lg border border-border/70 bg-card/90 px-2 py-1 text-xs font-semibold text-foreground hover:bg-muted/60"
                          disabled={deletingFiles}
                          onClick={() => void handleRename(f.name)}
                        >
                          Переименовать
                        </button>
                        <button
                          type="button"
                          className="rounded-lg bg-rose-600 px-2 py-1 text-xs font-semibold text-white hover:bg-rose-700"
                          disabled={deletingFiles}
                          onClick={() => void handleDelete(f.name)}
                        >
                          Удалить
                        </button>
                      </div>
                    </div>

                    <label className="flex items-start justify-center pt-1">
                      <span className="sr-only">{`Выбрать ${f.name}`}</span>
                      <input
                        type="checkbox"
                        className="h-5 w-5 rounded border-border/70 bg-card/90 text-primary"
                        checked={isSelected}
                        disabled={deletingFiles}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSelectedFiles((prev) => {
                            if (checked) {
                              if (prev.includes(f.name)) return prev;
                              return [...prev, f.name];
                            }

                            return prev.filter((name) => name !== f.name);
                          });
                        }}
                      />
                    </label>

                    {baseUrl ? (
                      <div className="overflow-hidden rounded-xl border border-border/70 bg-card/90">
                        <img
                          src={buildPublicFileUrl(baseUrl, f.name)}
                          alt={f.name}
                          className="aspect-square w-full object-cover"
                          loading="lazy"
                        />
                      </div>
                    ) : (
                      <div className="flex aspect-square items-center justify-center rounded-xl border border-border/70 bg-card/90 text-[10px] text-muted-foreground/80">
                        no preview
                      </div>
                    )}
                    </div>
                  );
                })}
              </div>
            )}
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function dateInputToIso(value: string, endOfDay: boolean): string | null {
  if (!value) return null;
  const suffix = endOfDay ? "T23:59:59.999" : "T00:00:00.000";
  const date = new Date(`${value}${suffix}`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function formatPromotionDate(value: string | null): string {
  if (!value) return "без ограничения";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("ru-RU");
}

function formatPromotionCategory(categorySlug: string): string {
  return (
    PROMOTION_CATEGORY_OPTIONS.find((category) => category.value === categorySlug)?.label ??
    categorySlug
  );
}

function formatPromotionBrandScope(brand: string | null): string {
  if (!brand) return "Все бренды";
  return brand.includes(",") ? `Бренды: ${brand}` : `Бренд: ${brand}`;
}

function formatPromotionProductScope(productIds: string[]): string | null {
  if (productIds.length === 0) return null;
  return `Конкретных моделей: ${productIds.length}`;
}

function parseCatalogCitySlug(value: string): CitySlug | null {
  return value === "vvo" || value === "blg" ? value : null;
}

function getCatalogItemCategoryId(item: CatalogItem): string {
  return typeof item.categorySlug === "string" && item.categorySlug.trim().length > 0
    ? normalizeCatalogCategoryId(item.categorySlug) ?? item.categorySlug.trim().toLowerCase()
    : "other";
}

function buildPromotionBrandOptionsFromCatalog(params: {
  items: CatalogItem[];
  citySlug: CitySlug;
  categorySlug: string;
}): AdminPromotionBrandOption[] {
  const selectedCategoryId =
    normalizeCatalogCategoryId(params.categorySlug) ?? params.categorySlug.trim().toLowerCase();
  const stats = new Map<string, { label: string; count: number }>();

  for (const item of params.items) {
    if (!item.inStock) continue;

    const categoryId = getCatalogItemCategoryId(item);
    if (categoryId !== selectedCategoryId) continue;

    const manufacturerLabel = resolveCatalogManufacturerLabel({
      title: item.title,
      categoryId,
      citySlug: params.citySlug,
    });
    const manufacturerId = normalizeManufacturerId(manufacturerLabel);
    const prev = stats.get(manufacturerId);
    if (prev) {
      prev.count += 1;
    } else {
      stats.set(manufacturerId, { label: manufacturerLabel, count: 1 });
    }
  }

  return Array.from(stats.values())
    .map((value) => ({ brand: value.label, count: value.count }))
    .sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand, "ru"));
}

function buildPromotionModelOptionsFromCatalog(params: {
  items: CatalogItem[];
  citySlug: CitySlug;
  categorySlug: string;
  brands: string[];
}): AdminPromotionModelOption[] {
  if (params.brands.length === 0) return [];

  const selectedCategoryId =
    normalizeCatalogCategoryId(params.categorySlug) ?? params.categorySlug.trim().toLowerCase();
  const selectedBrandIds = new Set(params.brands.map((brand) => normalizeManufacturerId(brand)));
  const models = new Map<string, AdminPromotionModelOption>();

  for (const item of params.items) {
    if (!item.inStock) continue;

    const categoryId = getCatalogItemCategoryId(item);
    if (categoryId !== selectedCategoryId) continue;

    const manufacturerLabel = resolveCatalogManufacturerLabel({
      title: item.title,
      categoryId,
      citySlug: params.citySlug,
    });
    const manufacturerId = normalizeManufacturerId(manufacturerLabel);
    if (!selectedBrandIds.has(manufacturerId)) continue;

    models.set(item.id, {
      productId: item.id,
      title: item.title,
      brand: manufacturerLabel,
      price: item.price,
    });
  }

  return Array.from(models.values()).sort(
    (a, b) =>
      a.brand.localeCompare(b.brand, "ru") ||
      a.title.localeCompare(b.title, "ru") ||
      a.productId.localeCompare(b.productId),
  );
}

function AdminPromotionsManager() {
  const [modalOpen, setModalOpen] = useState(false);
  const [promotions, setPromotions] = useState<AdminPromotionRule[]>([]);
  const [cities, setCities] = useState<AdminCity[]>([]);
  const [brandOptions, setBrandOptions] = useState<AdminPromotionBrandOption[]>([]);
  const [promotionCatalogItems, setPromotionCatalogItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [brandsLoading, setBrandsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<AdminPromotionDraft>({
    type: PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE,
    citySlug: "blg",
    categorySlug: "disposable",
    brands: [] as string[],
    modelScope: "brand",
    productIds: [],
    startsAt: "",
    endsAt: "",
  });

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [promotionsData, citiesData] = await Promise.all([
        apiGet<AdminPromotionsResponse>("/api/admin/promotions"),
        apiGet<AdminCity[]>("/api/admin/cities"),
      ]);
      setPromotions(promotionsData.items);
      setCities(citiesData);
      setDraft((prev) => {
        if (citiesData.some((city) => city.slug === prev.citySlug)) return prev;
        return {
          ...prev,
          citySlug: citiesData[0]?.slug ?? "blg",
          brands: [],
          modelScope: "brand",
          productIds: [],
        };
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load promotions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const citySlug = parseCatalogCitySlug(draft.citySlug);
    if (!modalOpen || !citySlug) {
      setBrandOptions([]);
      setPromotionCatalogItems([]);
      setBrandsLoading(false);
      return;
    }

    let cancelled = false;
    setBrandsLoading(true);
    fetchCatalog(citySlug)
      .then((data) => {
        if (cancelled) return;
        setPromotionCatalogItems(data.items);
        const items = buildPromotionBrandOptionsFromCatalog({
          items: data.items,
          citySlug,
          categorySlug: draft.categorySlug,
        });
        setBrandOptions(items);
        setDraft((prev) => {
          const availableBrands = new Set(items.map((item) => item.brand));
          const brands = prev.brands.filter((brand) => availableBrands.has(brand));
          const modelOptions = buildPromotionModelOptionsFromCatalog({
            items: data.items,
            citySlug,
            categorySlug: draft.categorySlug,
            brands,
          });
          const availableProductIds = new Set(
            modelOptions.map((model) => model.productId),
          );
          const productIds = prev.productIds.filter((productId) =>
            availableProductIds.has(productId),
          );
          const modelScope =
            brands.length > 0 && productIds.length > 0 ? prev.modelScope : "brand";

          if (
            brands.length === prev.brands.length &&
            productIds.length === prev.productIds.length &&
            modelScope === prev.modelScope
          ) {
            return prev;
          }
          return { ...prev, brands, productIds, modelScope };
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setBrandOptions([]);
        setPromotionCatalogItems([]);
        setError(e instanceof Error ? e.message : "Failed to load promotion brands");
      })
      .finally(() => {
        if (!cancelled) setBrandsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [modalOpen, draft.citySlug, draft.categorySlug]);

  const latestPromotions = promotions.slice(0, 3);
  const brandTotalCount = brandOptions.reduce((sum, item) => sum + item.count, 0);
  const isPodLiquidDraft =
    draft.type === PROMOTION_TYPE_BUY_POD_GET_LIQUID_CHEAPEST_FREE;
  const canUseModelMode = !isPodLiquidDraft && draft.brands.length > 0;
  const promotionModelOptions = useMemo(() => {
    const citySlug = parseCatalogCitySlug(draft.citySlug);
    if (!citySlug || !canUseModelMode) return [];

    return buildPromotionModelOptionsFromCatalog({
      items: promotionCatalogItems,
      citySlug,
      categorySlug: draft.categorySlug,
      brands: draft.brands,
    });
  }, [
    canUseModelMode,
    draft.brands,
    draft.categorySlug,
    draft.citySlug,
    promotionCatalogItems,
  ]);
  const selectedModelCount = draft.productIds.length;

  useEffect(() => {
    const availableProductIds = new Set(
      promotionModelOptions.map((model) => model.productId),
    );

    setDraft((prev) => {
      const nextProductIds =
        canUseModelMode && prev.modelScope === "models"
          ? prev.productIds.filter((productId) => availableProductIds.has(productId))
          : [];
      const nextModelScope = canUseModelMode ? prev.modelScope : "brand";

      if (
        nextProductIds.length === prev.productIds.length &&
        nextModelScope === prev.modelScope
      ) {
        return prev;
      }

      return {
        ...prev,
        modelScope: nextModelScope,
        productIds: nextProductIds,
      };
    });
  }, [canUseModelMode, promotionModelOptions]);

  async function createPromotion(): Promise<void> {
    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      if (draft.startsAt && draft.endsAt && draft.endsAt < draft.startsAt) {
        setError("Дата окончания должна быть позже даты начала.");
        return;
      }
      if (canUseModelMode && draft.modelScope === "models" && draft.productIds.length === 0) {
        setError("Выберите хотя бы одну модель для режима «Конкретные модели».");
        return;
      }

      const created = await apiPost<AdminPromotionRule>("/api/admin/promotions", {
        type: draft.type,
        citySlug: draft.citySlug,
        categorySlug: draft.categorySlug,
        brands: draft.brands,
        productIds:
          canUseModelMode && draft.modelScope === "models" ? draft.productIds : [],
        startsAt: dateInputToIso(draft.startsAt, false),
        endsAt: dateInputToIso(draft.endsAt, true),
      });

      setPromotions((prev) => [created, ...prev]);
      setNotice("Акция создана.");
      setModalOpen(false);
      setDraft({
        type: PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE,
        citySlug: draft.citySlug,
        categorySlug: "disposable",
        brands: [],
        modelScope: "brand",
        productIds: [],
        startsAt: "",
        endsAt: "",
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create promotion");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Акции</div>
          <div className="mt-1 text-xs text-muted-foreground/80">
            Создание правил для автоматической скидки в корзине.
          </div>
        </div>

        <button
          type="button"
          className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90"
          onClick={() => setModalOpen(true)}
        >
          Создать акцию
        </button>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="mt-3 rounded-xl border border-emerald-400/35 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-500">
          {notice}
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        {loading ? (
          <div className="h-16 animate-pulse rounded-2xl bg-muted/60" />
        ) : latestPromotions.length === 0 ? (
          <div className="rounded-2xl border border-border/70 bg-card/90 p-3 text-sm text-muted-foreground">
            Акций пока нет
          </div>
        ) : (
          latestPromotions.map((promotion) => (
            <div
              key={promotion.id}
              className="rounded-2xl border border-border/70 bg-card/90 p-3 text-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold">
                    {promotion.cityName
                      ? `${promotion.cityName} (${promotion.citySlug?.toUpperCase() ?? ""})`
                      : "Все города"}{" "}
                    · {promotion.adminTitle} · {formatPromotionCategory(promotion.categorySlug)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatPromotionBrandScope(promotion.brand)}
                    {formatPromotionProductScope(promotion.productIds) ? (
                      <> · {formatPromotionProductScope(promotion.productIds)}</>
                    ) : null}{" "}
                    ·{" "}
                    {formatPromotionDate(promotion.startsAt)} -{" "}
                    {formatPromotionDate(promotion.endsAt)}
                  </div>
                </div>
                <span
                  className={[
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                    promotion.isActive
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-muted/60 text-foreground/80",
                  ].join(" ")}
                >
                  {promotion.isActive ? "active" : "off"}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border/70 bg-card p-4 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold">Создать акцию</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  1+1=3 дарит самые дешёвые товары в группе.
                </div>
              </div>
              <button
                type="button"
                className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55"
                disabled={saving}
                onClick={() => setModalOpen(false)}
              >
                Закрыть
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-semibold text-muted-foreground">Вид акции</span>
                <select
                  className="h-10 rounded-xl border border-border/70 bg-card/90 px-3 text-sm"
                  value={draft.type}
                  disabled={saving}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      type: e.target.value as PromotionRuleType,
                      categorySlug:
                        e.target.value === PROMOTION_TYPE_BUY_POD_GET_LIQUID_CHEAPEST_FREE
                          ? "pod"
                          : prev.categorySlug === "pod"
                            ? "disposable"
                            : prev.categorySlug,
                      brands: [],
                      modelScope: "brand",
                      productIds: [],
                    }))
                  }
                >
                  <option value={PROMOTION_TYPE_BUY_2_GET_3_CHEAPEST_FREE}>
                    1+1=3
                  </option>
                  <option value={PROMOTION_TYPE_BUY_POD_GET_LIQUID_CHEAPEST_FREE}>
                    Pod + жижа
                  </option>
                </select>
              </label>

              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-semibold text-muted-foreground">Город</span>
                <select
                  className="h-10 rounded-xl border border-border/70 bg-card/90 px-3 text-sm"
                  value={draft.citySlug}
                  disabled={saving || cities.length === 0}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      citySlug: e.target.value,
                      brands: [],
                      modelScope: "brand",
                      productIds: [],
                    }))
                  }
                >
                  {cities.map((city) => (
                    <option key={city.id} value={city.slug}>
                      {formatCityLabel(city)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-semibold text-muted-foreground">
                  Категория товара
                </span>
                <select
                  className="h-10 rounded-xl border border-border/70 bg-card/90 px-3 text-sm"
                  value={draft.categorySlug}
                  disabled={saving || isPodLiquidDraft}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      categorySlug: e.target.value,
                      brands: [],
                      modelScope: "brand",
                      productIds: [],
                    }))
                  }
                >
                  {PROMOTION_CATEGORY_OPTIONS.map((category) => (
                    <option key={category.value} value={category.value}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </label>

              <fieldset className="grid gap-1.5 text-sm">
                <legend className="text-xs font-semibold text-muted-foreground">
                  Бренд компании
                </legend>
                <div className="max-h-44 overflow-y-auto rounded-xl border border-border/70 bg-card/90 p-2">
                  <label className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm hover:bg-muted/45">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={draft.brands.length === 0}
                      disabled={saving || brandsLoading}
                      onChange={() =>
                        setDraft((prev) => ({
                          ...prev,
                          brands: [],
                          modelScope: "brand",
                          productIds: [],
                        }))
                      }
                    />
                    <span className="min-w-0 flex-1">
                      {brandsLoading ? "Загружаем..." : "Все бренды"}
                    </span>
                    {!brandsLoading && brandTotalCount > 0 ? (
                      <span className="shrink-0 text-xs font-semibold text-muted-foreground">
                        {brandTotalCount}
                      </span>
                    ) : null}
                  </label>
                  {brandOptions.map((option) => {
                    const checked = draft.brands.includes(option.brand);
                    return (
                      <label
                        key={option.brand}
                        className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm hover:bg-muted/45"
                      >
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={checked}
                          disabled={saving || brandsLoading}
                          onChange={(e) =>
                            setDraft((prev) => {
                              const brands = e.target.checked
                                ? [...prev.brands, option.brand]
                                : prev.brands.filter(
                                    (selectedBrand) => selectedBrand !== option.brand,
                                  );
                              return {
                                ...prev,
                                brands,
                                modelScope: brands.length > 0 ? prev.modelScope : "brand",
                                productIds: [],
                              };
                            })
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">{option.brand}</span>
                        <span className="shrink-0 text-xs font-semibold text-muted-foreground">
                          {option.count}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {canUseModelMode ? (
                <fieldset className="grid gap-1.5 text-sm">
                  <legend className="text-xs font-semibold text-muted-foreground">
                    Охват выбранных брендов
                  </legend>
                  <div className="grid grid-cols-2 gap-1 rounded-xl border border-border/70 bg-card/90 p-1">
                    <button
                      type="button"
                      className={[
                        "min-h-9 rounded-lg px-2 text-xs font-semibold",
                        draft.modelScope === "brand"
                          ? "bg-primary text-white"
                          : "text-muted-foreground hover:bg-muted/45",
                      ].join(" ")}
                      disabled={saving}
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          modelScope: "brand",
                          productIds: [],
                        }))
                      }
                    >
                      Все модели брендов
                    </button>
                    <button
                      type="button"
                      className={[
                        "min-h-9 rounded-lg px-2 text-xs font-semibold",
                        draft.modelScope === "models"
                          ? "bg-primary text-white"
                          : "text-muted-foreground hover:bg-muted/45",
                      ].join(" ")}
                      disabled={saving || promotionModelOptions.length === 0}
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          modelScope: "models",
                        }))
                      }
                    >
                      Конкретные модели
                    </button>
                  </div>

                  {draft.modelScope === "models" ? (
                    <div className="rounded-xl border border-border/70 bg-card/90 p-2">
                      <div className="mb-2 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
                        <span>
                          Выбрано {selectedModelCount} из {promotionModelOptions.length}
                        </span>
                        <button
                          type="button"
                          className="font-semibold text-primary disabled:text-muted-foreground"
                          disabled={saving || selectedModelCount === 0}
                          onClick={() =>
                            setDraft((prev) => ({ ...prev, productIds: [] }))
                          }
                        >
                          Сбросить
                        </button>
                      </div>

                      {promotionModelOptions.length === 0 ? (
                        <div className="px-2 py-3 text-xs text-muted-foreground">
                          Для выбранных брендов нет доступных карточек.
                        </div>
                      ) : (
                        <div className="max-h-52 overflow-y-auto">
                          {promotionModelOptions.map((model) => {
                            const checked = draft.productIds.includes(model.productId);
                            return (
                              <label
                                key={model.productId}
                                className="flex min-h-11 items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/45"
                              >
                                <input
                                  type="checkbox"
                                  className="mt-0.5 size-4 shrink-0 accent-primary"
                                  checked={checked}
                                  disabled={saving}
                                  onChange={(e) =>
                                    setDraft((prev) => ({
                                      ...prev,
                                      productIds: e.target.checked
                                        ? [...prev.productIds, model.productId]
                                        : prev.productIds.filter(
                                            (productId) => productId !== model.productId,
                                          ),
                                    }))
                                  }
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-semibold">
                                    {model.title}
                                  </span>
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {model.brand}
                                  </span>
                                </span>
                                <span className="shrink-0 text-xs font-semibold text-muted-foreground">
                                  {formatRub(model.price)}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : null}
                </fieldset>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-semibold text-muted-foreground">Начало</span>
                  <input
                    type="date"
                    className="h-10 rounded-xl border border-border/70 bg-card/90 px-3 text-sm"
                    value={draft.startsAt}
                    disabled={saving}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, startsAt: e.target.value }))
                    }
                  />
                </label>

                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-semibold text-muted-foreground">
                    Окончание
                  </span>
                  <input
                    type="date"
                    className="h-10 rounded-xl border border-border/70 bg-card/90 px-3 text-sm"
                    value={draft.endsAt}
                    disabled={saving}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, endsAt: e.target.value }))
                    }
                  />
                </label>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55"
                disabled={saving}
                onClick={() => setModalOpen(false)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-slate-600"
                disabled={saving || cities.length === 0}
                onClick={() => void createPromotion()}
              >
                {saving ? "Создаём..." : "Создать"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function AdminBusinessReportsManager() {
  const [password, setPassword] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function openReports(): void {
    setError(null);
    setNotice(null);

    if (password !== ADMIN_REPORT_PASSWORD) {
      setError("Неверный пароль.");
      return;
    }

    setModalOpen(true);
  }

  async function downloadReport(): Promise<void> {
    setDownloading(true);
    setError(null);
    setNotice(null);

    try {
      const { blob, filename } = await apiDownloadBlob("/api/admin/reports/business", {
        password,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename ?? "business-report-done-orders.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice("Отчёт скачан.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось скачать отчёт");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Отчётность</div>
          <div className="mt-1 text-xs text-muted-foreground/80">
            Выполненные заказы, товары, клиенты, адреса, рефералка и промокоды.
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          type="password"
          className="h-10 min-w-0 flex-1 rounded-xl border border-border/70 bg-card/90 px-3 text-sm"
          value={password}
          placeholder="Пароль"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") openReports();
          }}
        />
        <button
          type="button"
          className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90"
          onClick={openReports}
        >
          Открыть
        </button>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="mt-3 rounded-xl border border-emerald-400/35 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-500">
          {notice}
        </div>
      ) : null}

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-border/70 bg-card p-4 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold">Бизнес-отчёт</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  XLSX по двум городам только по выполненным заказам.
                </div>
              </div>
              <button
                type="button"
                className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55"
                disabled={downloading}
                onClick={() => setModalOpen(false)}
              >
                Закрыть
              </button>
            </div>

            <div className="mt-4 rounded-xl border border-border/70 bg-muted/25 p-3 text-xs text-muted-foreground">
              Листы: заказы, позиции, города, товары, клиенты, адреса, рефералка, промокоды.
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55"
                disabled={downloading}
                onClick={() => setModalOpen(false)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-slate-600"
                disabled={downloading}
                onClick={() => void downloadReport()}
              >
                {downloading ? "Готовим..." : "Скачать отчёт"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function createDefaultPromoCodeDraft(): AdminPromoCodeDraft {
  return {
    code: "",
    discountAmount: "",
    startsAt: getDateInputValue(),
    endsAt: getDateInputValue(7),
    maxUses: "1",
  };
}

function AdminPromoCodesManager() {
  const [items, setItems] = useState<AdminPromoCode[]>([]);
  const [draft, setDraft] = useState<AdminPromoCodeDraft>(() =>
    createDefaultPromoCodeDraft(),
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<AdminPromoCodesResponse>("/api/admin/promo-codes");
      setItems(data.items);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить промокоды");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function updateDraft(patch: Partial<AdminPromoCodeDraft>): void {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  async function createPromoCode(): Promise<void> {
    const code = draft.code.trim();
    const discountAmount = Number(draft.discountAmount);
    const maxUses = Number(draft.maxUses);
    if (!code || !Number.isFinite(discountAmount) || !Number.isFinite(maxUses)) {
      setError("Заполните код, скидку и лимит использований.");
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const created = await apiPost<AdminPromoCode>("/api/admin/promo-codes", {
        code,
        discountAmount,
        startsAt: draft.startsAt,
        endsAt: draft.endsAt,
        maxUses,
      });
      setItems((prev) => [created, ...prev.filter((item) => item.code !== created.code)]);
      setDraft((prev) => ({ ...createDefaultPromoCodeDraft(), startsAt: prev.startsAt }));
      setNotice(`Промокод ${created.code} создан.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось создать промокод");
    } finally {
      setSaving(false);
    }
  }

  const canCreate =
    draft.code.trim().length > 0 &&
    draft.discountAmount.trim().length > 0 &&
    draft.startsAt.trim().length > 0 &&
    draft.endsAt.trim().length > 0 &&
    draft.maxUses.trim().length > 0 &&
    !saving;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Создание промокодов</div>
          <div className="mt-1 text-xs text-muted-foreground/80">
            Код, период, скидка и лимит использований.
          </div>
        </div>
        <button
          type="button"
          className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={loading || saving}
          onClick={() => void load()}
        >
          Обновить
        </button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="grid gap-1.5 text-sm lg:col-span-2">
          <span className="text-xs font-semibold text-muted-foreground">Название / код</span>
          <input
            className="h-10 rounded-xl border border-border/70 bg-card/90 px-3 text-sm uppercase"
            value={draft.code}
            disabled={saving}
            placeholder="SALE500"
            onChange={(e) => updateDraft({ code: e.target.value })}
          />
        </label>

        <label className="grid gap-1.5 text-sm">
          <span className="text-xs font-semibold text-muted-foreground">Скидка, ₽</span>
          <input
            type="number"
            min={1}
            step={1}
            className="h-10 rounded-xl border border-border/70 bg-card/90 px-3 text-sm"
            value={draft.discountAmount}
            disabled={saving}
            placeholder="500"
            onChange={(e) => updateDraft({ discountAmount: e.target.value })}
          />
        </label>

        <label className="grid gap-1.5 text-sm">
          <span className="text-xs font-semibold text-muted-foreground">Использований</span>
          <input
            type="number"
            min={1}
            step={1}
            className="h-10 rounded-xl border border-border/70 bg-card/90 px-3 text-sm"
            value={draft.maxUses}
            disabled={saving}
            onChange={(e) => updateDraft({ maxUses: e.target.value })}
          />
        </label>

        <div className="grid gap-2 sm:grid-cols-2 lg:col-span-5">
          <label className="grid gap-1.5 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">Начало</span>
            <input
              type="date"
              className="h-10 rounded-xl border border-border/70 bg-card/90 px-3 text-sm"
              value={draft.startsAt}
              disabled={saving}
              onChange={(e) => updateDraft({ startsAt: e.target.value })}
            />
          </label>

          <label className="grid gap-1.5 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">Окончание</span>
            <input
              type="date"
              className="h-10 rounded-xl border border-border/70 bg-card/90 px-3 text-sm"
              value={draft.endsAt}
              disabled={saving}
              onChange={(e) => updateDraft({ endsAt: e.target.value })}
            />
          </label>
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-slate-600"
          disabled={!canCreate}
          onClick={() => void createPromoCode()}
        >
          {saving ? "Создаём..." : "Создать промокод"}
        </button>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="mt-3 rounded-xl border border-emerald-400/35 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-500">
          {notice}
        </div>
      ) : null}

      <div className="mt-4 grid gap-2">
        {loading ? (
          <div className="h-16 animate-pulse rounded-2xl bg-muted/60" />
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-border/70 bg-card/90 p-3 text-sm text-muted-foreground">
            Промокодов пока нет.
          </div>
        ) : (
          items.slice(0, 8).map((item) => (
            <div
              key={item.code}
              className="rounded-2xl border border-border/70 bg-card/90 p-3"
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{item.code}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatDateTime(item.startsAt)} - {formatDateTime(item.endsAt)}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-semibold">
                    -{formatRub(item.discountAmount)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {item.usedCount}/{item.maxUses}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

function AdminProductsManager() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<AdminProductsTab>("active");
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [activeCount, setActiveCount] = useState<number | null>(null);
  const [archiveCount, setArchiveCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<AdminProductsResponse>(
        `/api/admin/products?tab=${tab}&limit=${PRODUCTS_PAGE_SIZE}`,
      );
      setProducts(data.items);
      setActiveCount(data.activeCount);
      setArchiveCount(data.archiveCount);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Ошибка загрузки";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [tab, load]);

  const activeCountLabel =
    activeCount === null ? (loading ? "..." : "—") : String(activeCount);
  const archiveCountLabel =
    archiveCount === null ? (loading ? "..." : "—") : String(archiveCount);

  async function setProductActive(product: AdminProduct, isActive: boolean): Promise<void> {
    setSavingId(product.id);
    setError(null);
    try {
      await apiPut(`/api/admin/products/${product.id}`, {
        title: product.title,
        description: product.description,
        basePrice: product.base_price,
        isActive,
      });

      setProducts((prev) => prev.filter((p) => p.id !== product.id));
      setActiveCount((prev) => {
        if (prev === null) return prev;
        return isActive ? prev + 1 : Math.max(0, prev - 1);
      });
      setArchiveCount((prev) => {
        if (prev === null) return prev;
        return isActive ? Math.max(0, prev - 1) : prev + 1;
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Ошибка сохранения";
      setError(message);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Manage products</div>
          <div className="mt-1 text-xs text-muted-foreground/80">
            Активные: {activeCountLabel} • Архив: {archiveCountLabel}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary/90"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Закрыть" : "Редактировать"}
          </button>

          <button
            type="button"
            className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!open || loading || savingId !== null}
            onClick={() => void load()}
          >
            Обновить
          </button>
        </div>
      </div>

      {open ? (
        <>
          {error ? (
            <div className="mt-3 rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              className={[
                "rounded-xl px-3 py-2 text-xs font-semibold border",
                tab === "active"
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-border/70 bg-card/90 text-foreground hover:bg-muted/55",
              ].join(" ")}
              disabled={loading}
              onClick={() => setTab("active")}
            >
              Активные
            </button>
            <button
              type="button"
              className={[
                "rounded-xl px-3 py-2 text-xs font-semibold border",
                tab === "archive"
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-border/70 bg-card/90 text-foreground hover:bg-muted/55",
              ].join(" ")}
              disabled={loading}
              onClick={() => setTab("archive")}
            >
              Архив
            </button>
          </div>

          {loading ? (
            <div className="mt-3 grid gap-3">
              <div className="h-20 animate-pulse rounded-2xl bg-muted/60" />
              <div className="h-20 animate-pulse rounded-2xl bg-muted/60" />
            </div>
          ) : products.length === 0 ? (
            <div className="mt-3 rounded-2xl border border-border/70 bg-card/90 p-4 text-sm text-muted-foreground">
              Пусто
            </div>
          ) : (
            <div className="mt-3 grid gap-3">
              {products.map((p) => {
                const isSaving = savingId === p.id;
                const nextActive = tab === "archive";

                return (
                  <div
                    key={p.id}
                    className="rounded-2xl border border-border/70 bg-card/90 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{p.title}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {formatRub(p.base_price)}
                        </div>
                      </div>

                      <button
                        type="button"
                        className={[
                          "shrink-0 rounded-xl px-3 py-2 text-xs font-semibold",
                          tab === "active"
                            ? "bg-rose-600 text-white hover:bg-rose-700"
                            : "bg-emerald-600 text-white hover:bg-emerald-700",
                          "disabled:cursor-not-allowed disabled:bg-slate-600",
                        ].join(" ")}
                        disabled={loading || isSaving}
                        onClick={() => void setProductActive(p, nextActive)}
                      >
                        {isSaving ? "..." : tab === "active" ? "В архив" : "В активные"}
                      </button>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.inventory.map((inv) => (
                        <span
                          key={`${p.id}:${inv.city_slug}`}
                          className={[
                            "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                            inv.in_stock
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-muted/60 text-foreground/80",
                          ].join(" ")}
                        >
                          {inv.city_slug.toUpperCase()}: {inv.in_stock ? "в наличии" : "нет"}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </Card>
  );
}

function AdminOrdersView() {
  const [status, setStatus] = useState<OrderStatus>("new");
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextStatus: OrderStatus): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<Order[]>(
        `/api/admin/orders?status=${nextStatus}&limit=${ORDERS_PAGE_SIZE}`,
      );
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
    <Card>
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="flex min-w-max items-center justify-between gap-4">
          <div className="text-lg font-semibold">Заказы</div>
          <div className="flex items-center gap-2">
            <select
              className="h-10 rounded-xl border border-border/70 bg-card/90 px-3 text-sm font-semibold"
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
              className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55"
              onClick={() => void load(status)}
              disabled={loading}
            >
              Обновить
            </button>
          </div>
        </div>
      </div>
      {error ? (
        <div className="mt-3 rounded-2xl border border-destructive/35 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-3 grid gap-3">
          <div className="h-24 animate-pulse rounded-2xl bg-muted/60" />
          <div className="h-24 animate-pulse rounded-2xl bg-muted/60" />
        </div>
      ) : orders.length === 0 ? (
        <div className="mt-3 text-sm text-muted-foreground">Пусто</div>
      ) : (
        <div className="mt-3 grid min-w-0 gap-3">
          {orders.map((o) => (
            <Card key={o.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">
                    {formatDateTime(o.created_at)} •{" "}
                    {o.city_slug ? o.city_slug.toUpperCase() : "—"} •{" "}
                    <span className="text-muted-foreground">{o.status}</span>
                  </div>
                  <div className="mt-1 break-words text-xs text-muted-foreground">
                    Юзер:{" "}
                    {o.tg_username ? `@${o.tg_username} (${o.tg_user_id})` : o.tg_user_id}
                    {" • "}
                    {formatRub(o.total_price)}
                    {" • "}
                    {formatDeliveryMethodLabel(o.delivery_method)}
                  </div>
                </div>

                <div className="flex items-center gap-2">
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

              <div className="mt-3 border-t border-border/70 pt-3">
                <div className="text-xs font-semibold text-muted-foreground/80">Позиции</div>
                <div className="mt-2 space-y-1 text-sm">
                  {o.items.map((it, idx) => (
                    <div key={`${o.id}:${idx}`} className="flex min-w-0 justify-between gap-3">
                      <div className="min-w-0 truncate">
                        {it.title ?? it.product_id ?? "unknown"} ×{it.qty}
                      </div>
                      <div className="shrink-0 font-semibold text-foreground/80">
                        {formatRub(it.unit_price)}
                      </div>
                    </div>
                  ))}
                </div>

                {o.comment ? (
                  <div className="mt-3 whitespace-pre-line rounded-xl bg-muted/55 px-3 py-2 text-sm text-foreground/80">
                    <span className="text-xs font-semibold text-muted-foreground/80">
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
    </Card>
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
        <div className="mt-1 text-sm text-muted-foreground">
          {accessState === "ok"
            ? `Logged in as ${me?.username ? `@${me.username}` : me?.tgUserId} (role: ${me?.role})`
            : "Admin access is restricted to allowlist users."}
        </div>
      </div>

      {accessState === "loading" ? (
        <div className="h-24 animate-pulse rounded-2xl bg-muted/60" />
      ) : null}

      {accessState !== "ok" && accessState !== "loading" ? (
        <Card>
          <div className="text-sm font-semibold">No access</div>
          <div className="mt-2 text-sm text-muted-foreground">
            {accessState === "forbidden"
              ? "Your tg_user_id is not in the admins table."
              : accessState === "unauthorized"
                ? "Telegram initData required (open the mini app inside Telegram)."
                : "Failed to check access."}
          </div>

          {!isTelegram && import.meta.env.DEV ? (
            <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              DEV: enable bypass (server): `DEV_ADMIN_TG_USER_ID` + header `x-dev-admin=1` (frontend sends automatically
              in dev).
            </div>
          ) : null}
        </Card>
      ) : null}

      {accessState === "ok" ? (
        <>
          <AdminImportProductsCsv />
          <AdminUploadImages />
          <AdminPromotionsManager />
          <AdminBusinessReportsManager />
          <AdminPromoCodesManager />
          <AdminProductsManager />
          <AdminOrdersView />
        </>
      ) : null}
    </div>
  );
}

