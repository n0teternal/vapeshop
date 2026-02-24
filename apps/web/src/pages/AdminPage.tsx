import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, apiDelete, apiGet, apiPost, apiPut, apiUpload } from "../api/client";
import { buildApiUrl } from "../config";

type AdminMe = {
  tgUserId: number;
  username: string | null;
  role: string;
};

type ImportProductsCsvResult = {
  delimiter: ";" | "," | "\t";
  decodedEncoding?: "utf-8" | "windows-1251" | "ibm866" | "koi8-r" | "xlsx";
  cities: Array<{ id: number; slug: string; name: string }>;
  rows: { total: number; valid: number; invalid: number };
  products: { inserted: number; updated: number };
  inventoryRows: number;
  generatedIds: boolean;
  outputXlsxBase64: string | null;
  errors: Array<{
    rowNum: number;
    id: string | null;
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

const PRODUCTS_PAGE_SIZE = 120;
const ORDERS_PAGE_SIZE = 50;

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
    <div className="rounded-2xl border border-border/70 bg-card/90 p-4 shadow-sm">
      {children}
    </div>
  );
}

function AdminImportProductsCsv() {
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

        const base = file.name.replace(/\.csv$/i, "");
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

      const res = await fetch(buildApiUrl("/api/admin/export/products.xlsx"), {
        method: "GET",
        headers,
      });

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
      const fallbackName = `products.latest.${new Date().toISOString().slice(0, 10)}.xlsx`;
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

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Import products (CSV/XLSX)</div>
          <div className="mt-1 text-xs text-muted-foreground/80">
            Upload CSV/XLSX based on `CUSTOMER_PRODUCTS_TEMPLATE.csv`.
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
            {downloadingLastXlsx ? "Preparing..." : "Upload last XLSX"}
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
          <div>
            Rows: total={result.rows.total} valid={result.rows.valid} invalid={result.rows.invalid}
          </div>
          {result.decodedEncoding ? <div>Decoded encoding: {result.decodedEncoding}</div> : null}
          <div>
            Products: inserted={result.products.inserted} updated={result.products.updated}
          </div>
          <div>Inventory rows: {result.inventoryRows}</div>
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
    </Card>
  );
}

function AdminUploadImages() {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadImagesResult | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [files, setFiles] = useState<UploadedImageFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const [filesOpen, setFilesOpen] = useState(false);

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
    try {
      await apiDelete(`/api/admin/upload/items/${encodeURIComponent(name)}`);
      await loadFiles();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Delete failed";
      setError(message);
    }
  }

  async function handleDeleteAll(): Promise<void> {
    if (files.length === 0) return;
    const confirmed = window.confirm(`Delete all files (${files.length})?`);
    if (!confirmed) return;

    setDeletingAll(true);
    setError(null);
    const failed: string[] = [];
    try {
      for (const file of files) {
        try {
          await apiDelete(`/api/admin/upload/items/${encodeURIComponent(file.name)}`);
        } catch {
          failed.push(file.name);
        }
      }

      await loadFiles();
      if (failed.length > 0) {
        setError(`Failed to delete ${failed.length} of ${files.length} files`);
      }
    } finally {
      setDeletingAll(false);
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
        <div className="fixed inset-0 z-50 flex items-start justify-center px-4 py-10">
          <button
            type="button"
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setFilesOpen(false)}
            aria-label="Закрыть"
          />
          <div className="relative w-full max-w-3xl rounded-2xl bg-card/90 p-4 shadow-xl">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold">Файлы</div>
                {baseUrl ? (
                  <div className="mt-1 text-xs text-muted-foreground/80">Base URL: {baseUrl}</div>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-border/70 bg-card/90 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/55"
                  disabled={loadingFiles || deletingAll}
                  onClick={() => void loadFiles()}
                >
                  Обновить
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={loadingFiles || deletingAll || files.length === 0}
                  onClick={() => void handleDeleteAll()}
                >
                  {deletingAll ? "Deleting..." : "Delete all"}
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
                {files.map((f) => (
                  <div
                    key={f.name}
                    className="grid grid-cols-[1fr_128px] gap-3 rounded-xl border border-border/70 bg-muted/55 p-3 text-xs sm:grid-cols-[1fr_200px]"
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
                          disabled={deletingAll}
                          onChange={(e) =>
                            setRenameDrafts((prev) => ({ ...prev, [f.name]: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="rounded-lg border border-border/70 bg-card/90 px-2 py-1 text-xs font-semibold text-foreground hover:bg-muted/60"
                          disabled={deletingAll}
                          onClick={() => void handleRename(f.name)}
                        >
                          Переименовать
                        </button>
                        <button
                          type="button"
                          className="rounded-lg bg-rose-600 px-2 py-1 text-xs font-semibold text-white hover:bg-rose-700"
                          disabled={deletingAll}
                          onClick={() => void handleDelete(f.name)}
                        >
                          Удалить
                        </button>
                      </div>
                    </div>

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
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
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
      <div className="flex items-center justify-between">
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
        <div className="mt-3 grid gap-3">
          {orders.map((o) => (
            <Card key={o.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">
                    {formatDateTime(o.created_at)} •{" "}
                    {o.city_slug ? o.city_slug.toUpperCase() : "—"} •{" "}
                    <span className="text-muted-foreground">{o.status}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Юзер:{" "}
                    {o.tg_username ? `@${o.tg_username} (${o.tg_user_id})` : o.tg_user_id}
                    {" • "}
                    {formatRub(o.total_price)}
                    {" • "}
                    {o.delivery_method}
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
                    <div key={`${o.id}:${idx}`} className="flex justify-between gap-3">
                      <div className="truncate">
                        {it.title ?? it.product_id ?? "unknown"} ×{it.qty}
                      </div>
                      <div className="shrink-0 font-semibold text-foreground/80">
                        {formatRub(it.unit_price)}
                      </div>
                    </div>
                  ))}
                </div>

                {o.comment ? (
                  <div className="mt-3 rounded-xl bg-muted/55 px-3 py-2 text-sm text-foreground/80">
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
          <AdminProductsManager />
          <AdminOrdersView />
        </>
      ) : null}
    </div>
  );
}

