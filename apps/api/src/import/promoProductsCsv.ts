import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/serviceClient.js";

export type ImportPromoProductsCsvResult = {
  delimiter: ";" | "," | "\t";
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

type CityRow = { id: number; slug: string; name: string };
type CsvRowError = ImportPromoProductsCsvResult["errors"][number];

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\uFEFF/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

function detectDelimiter(text: string): ";" | "," | "\t" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = {
    ";": (firstLine.match(/;/g) ?? []).length,
    ",": (firstLine.match(/,/g) ?? []).length,
    "\t": (firstLine.match(/\t/g) ?? []).length,
  };

  if (counts["\t"] >= counts[";"] && counts["\t"] >= counts[","] && counts["\t"] > 0) {
    return "\t";
  }
  if (counts[","] > counts[";"]) return ",";
  return ";";
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += ch;
  }

  row.push(cell);
  if (row.some((c) => c.trim().length > 0)) rows.push(row);
  return rows;
}

function parseUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function parseNumber(value: string): number {
  const normalized = value.trim().replace(/\s+/g, "").replace(",", ".");
  if (normalized.length === 0) throw new Error("required");
  const n = Number(normalized);
  if (!Number.isFinite(n)) throw new Error(`invalid number: ${value}`);
  return n;
}

function parseNullableInt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed.replace(/\s+/g, ""));
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`invalid integer: ${value}`);
  }
  return n;
}

function parseBool(value: string, defaultValue: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return defaultValue;
  if (["1", "true", "yes", "y", "да", "д", "active", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "нет", "н", "inactive", "off"].includes(normalized)) return false;
  throw new Error(`invalid boolean: ${value}`);
}

function pickColumn(headers: Set<string>, names: string[]): string | null {
  for (const name of names) {
    if (headers.has(name)) return name;
  }
  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function fetchCity(params: {
  supabase: SupabaseClient<Database>;
  citySlug: string;
}): Promise<CityRow> {
  const { data, error } = await params.supabase
    .from("cities")
    .select("id,slug,name")
    .eq("slug", params.citySlug)
    .maybeSingle();

  if (error) throw new Error(`Failed to load city: ${error.message}`);
  if (!data) throw new Error(`Unknown citySlug: ${params.citySlug}`);
  return data;
}

async function fetchInventoryProductIds(params: {
  supabase: SupabaseClient<Database>;
  cityId: number;
  productIds: string[];
}): Promise<Set<string>> {
  const result = new Set<string>();
  if (params.productIds.length === 0) return result;

  for (const part of chunk(params.productIds, 500)) {
    const { data, error } = await params.supabase
      .from("inventory")
      .select("product_id")
      .eq("city_id", params.cityId)
      .in("product_id", part);

    if (error) throw new Error(`Failed to load city inventory: ${error.message}`);
    for (const row of data ?? []) {
      result.add(row.product_id);
    }
  }

  return result;
}

export async function importPromoProductsCsv(params: {
  supabase: SupabaseClient<Database>;
  csvText: string;
  citySlug: string;
  dryRun?: boolean;
}): Promise<ImportPromoProductsCsvResult> {
  const dryRun = params.dryRun === true;
  const city = await fetchCity({ supabase: params.supabase, citySlug: params.citySlug });

  const delimiter = detectDelimiter(params.csvText);
  const table = parseDelimited(params.csvText, delimiter);
  if (table.length === 0) throw new Error("CSV is empty");

  const headers = (table[0] ?? []).map(normalizeHeader);
  const headerSet = new Set(headers);
  const productIdColumn = pickColumn(headerSet, ["product_id", "id"]);
  const titleColumn = pickColumn(headerSet, ["title", "name", "product_title"]);
  const oldPriceColumn = pickColumn(headerSet, ["promo_old_price", "old_price", "old"]);
  const newPriceColumn = pickColumn(headerSet, ["promo_new_price", "new_price", "new"]);
  const activeColumn = pickColumn(headerSet, ["promo_active", "is_active", "active"]);
  const sortOrderColumn = pickColumn(headerSet, ["promo_sort_order", "sort_order", "order"]);

  const missing = [
    productIdColumn ? null : "product_id",
    oldPriceColumn ? null : "promo_old_price",
    newPriceColumn ? null : "promo_new_price",
  ].filter((value): value is string => value !== null);
  if (missing.length > 0) {
    throw new Error(`CSV is missing required columns: ${missing.join(", ")}`);
  }

  const inputRecords: Array<{ rowNum: number; record: Record<string, string> }> = [];
  const errors: CsvRowError[] = [];
  const validRows: Array<{
    rowNum: number;
    productId: string;
    title: string | null;
    oldPrice: number | null;
    newPrice: number | null;
    isActive: boolean;
    sortOrder: number;
  }> = [];

  for (let i = 1; i < table.length; i += 1) {
    const rowCells = table[i] ?? [];
    const isBlank = rowCells.every((c) => c.trim().length === 0);
    if (isBlank) continue;

    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j += 1) {
      const key = headers[j] ?? "";
      if (!key) continue;
      record[key] = (rowCells[j] ?? "").trim();
    }

    const rowNum = i + 1;
    inputRecords.push({ rowNum, record });
    const rowMessages: string[] = [];
    const productId = (record[productIdColumn ?? ""] ?? "").trim();
    const title = titleColumn ? (record[titleColumn] ?? "").trim() || null : null;

    if (!productId) {
      rowMessages.push("product_id is required");
    } else if (!parseUuid(productId)) {
      rowMessages.push(`product_id must be a UUID (got: ${productId})`);
    }

    let isActive = true;
    try {
      isActive = parseBool(activeColumn ? record[activeColumn] ?? "" : "", true);
    } catch (e: unknown) {
      rowMessages.push(e instanceof Error ? `promo_active: ${e.message}` : "promo_active: invalid value");
    }

    let sortOrder = validRows.length + 1;
    try {
      sortOrder = parseNullableInt(sortOrderColumn ? record[sortOrderColumn] ?? "" : "") ?? sortOrder;
    } catch (e: unknown) {
      rowMessages.push(e instanceof Error ? `promo_sort_order: ${e.message}` : "promo_sort_order: invalid value");
    }

    const oldRaw = oldPriceColumn ? record[oldPriceColumn] ?? "" : "";
    const newRaw = newPriceColumn ? record[newPriceColumn] ?? "" : "";
    const hasAnyPrice = oldRaw.trim().length > 0 || newRaw.trim().length > 0;
    let oldPrice: number | null = null;
    let newPrice: number | null = null;

    if (isActive && hasAnyPrice) {
      try {
        oldPrice = parseNumber(oldRaw);
      } catch (e: unknown) {
        rowMessages.push(e instanceof Error ? `promo_old_price: ${e.message}` : "promo_old_price: invalid value");
      }
      try {
        newPrice = parseNumber(newRaw);
      } catch (e: unknown) {
        rowMessages.push(e instanceof Error ? `promo_new_price: ${e.message}` : "promo_new_price: invalid value");
      }

      if (oldPrice !== null && oldPrice <= 0) rowMessages.push("promo_old_price must be > 0");
      if (newPrice !== null && newPrice <= 0) rowMessages.push("promo_new_price must be > 0");
      if (oldPrice !== null && newPrice !== null && oldPrice <= newPrice) {
        rowMessages.push("promo_old_price must be greater than promo_new_price");
      }
    }

    if (rowMessages.length > 0) {
      errors.push({
        rowNum,
        productId: productId || null,
        title,
        messages: rowMessages,
      });
      continue;
    }

    validRows.push({
      rowNum,
      productId,
      title,
      oldPrice,
      newPrice,
      isActive,
      sortOrder,
    });
  }

  const activePromoRows = validRows.filter(
    (row): row is typeof row & { oldPrice: number; newPrice: number } =>
      row.isActive && row.oldPrice !== null && row.newPrice !== null,
  );

  const inventoryProductIds = await fetchInventoryProductIds({
    supabase: params.supabase,
    cityId: city.id,
    productIds: Array.from(new Set(activePromoRows.map((row) => row.productId))),
  });

  const activeRowsToImport = activePromoRows.filter((row) => {
    if (inventoryProductIds.has(row.productId)) return true;
    errors.push({
      rowNum: row.rowNum,
      productId: row.productId,
      title: row.title,
      messages: [`Product is not present in city inventory: ${city.slug}`],
    });
    return false;
  });

  const nowIso = new Date().toISOString();
  const activeProductIds = new Set(activeRowsToImport.map((row) => row.productId));
  let deleted = 0;

  if (!dryRun) {
    const { data: existingPromos, error: existingError } = await params.supabase
      .from("promo_products")
      .select("id,product_id")
      .eq("city_id", city.id);

    if (existingError) throw new Error(`Failed to load existing promo products: ${existingError.message}`);

    const obsoleteIds = (existingPromos ?? [])
      .filter((row) => !activeProductIds.has(row.product_id))
      .map((row) => row.id);

    for (const part of chunk(obsoleteIds, 500)) {
      const { error } = await params.supabase.from("promo_products").delete().in("id", part);
      if (error) throw new Error(`Failed to delete obsolete promo products: ${error.message}`);
      deleted += part.length;
    }

    const payload = activeRowsToImport.map((row) => ({
      city_id: city.id,
      product_id: row.productId,
      old_price: row.oldPrice,
      new_price: row.newPrice,
      sort_order: row.sortOrder,
      is_active: true,
      updated_at: nowIso,
    }));

    for (const part of chunk(payload, 500)) {
      const { error } = await params.supabase
        .from("promo_products")
        .upsert(part, { onConflict: "city_id,product_id" });
      if (error) throw new Error(`Failed to upsert promo products: ${error.message}`);
    }
  }

  return {
    delimiter,
    cities: [{ id: city.id, slug: city.slug, name: city.name }],
    rows: {
      total: inputRecords.length,
      valid: validRows.length,
      invalid: errors.length,
    },
    promos: {
      upserted: activeRowsToImport.length,
      deleted,
    },
    errors,
  };
}
