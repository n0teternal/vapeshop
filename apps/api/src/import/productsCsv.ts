import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import type { Database } from "../supabase/serviceClient.js";

export type CsvRowError = {
  rowNum: number;
  id: string | null;
  title: string | null;
  messages: string[];
};

export type ImportProductsCsvResult = {
  delimiter: ";" | "," | "\t";
  cities: Array<{ id: number; slug: string; name: string }>;
  rows: {
    total: number;
    valid: number;
    invalid: number;
  };
  products: {
    inserted: number;
    updated: number;
  };
  inventoryRows: number;
  generatedIds: boolean;
  outputXlsxBase64: string | null;
  errors: CsvRowError[];
};

function detectDelimiter(text: string): ";" | "," | "\t" {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const countSemi = (firstLine.match(/;/g) ?? []).length;
  const countComma = (firstLine.match(/,/g) ?? []).length;
  const countTab = (firstLine.match(/\t/g) ?? []).length;

  if (countTab >= countSemi && countTab >= countComma) return "\t";
  if (countComma >= countSemi) return ",";
  return ";";
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  const normalized = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i] ?? "";

    if (inQuotes) {
      if (ch === "\"") {
        const next = normalized[i + 1] ?? "";
        if (next === "\"") {
          value += "\"";
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }
      value += ch;
      continue;
    }

    if (ch === "\"") {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(value);
      value = "";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(value);
      value = "";
      rows.push(row);
      row = [];
      continue;
    }
    value += ch;
  }

  if (inQuotes) {
    throw new Error("CSV parse error: unclosed quote");
  }

  row.push(value);
  rows.push(row);

  while (rows.length > 0) {
    const last = rows[rows.length - 1] ?? [];
    const isEmpty = last.every((c) => c.trim().length === 0);
    if (!isEmpty) break;
    rows.pop();
  }

  return rows;
}

function stringifyDelimitedRow(values: string[], delimiter: string): string {
  const out: string[] = [];
  for (const v of values) {
    const needsQuotes =
      v.includes("\"") || v.includes("\n") || v.includes("\r") || v.includes(delimiter);
    if (!needsQuotes) {
      out.push(v);
      continue;
    }
    out.push(`\"${v.replace(/\"/g, '\"\"')}\"`);
  }
  return out.join(delimiter);
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function parseUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function hasFileExtension(value: string): boolean {
  return /\.[a-z0-9]{2,10}$/i.test(value);
}

function parseBool(value: string, fallback: boolean): boolean {
  const v = value.trim().toLowerCase();
  if (v.length === 0) return fallback;
  if (v === "true" || v === "1" || v === "yes" || v === "y") return true;
  if (v === "false" || v === "0" || v === "no" || v === "n") return false;
  throw new Error(`Invalid boolean: ${value}`);
}

function parseNumber(value: string): number {
  const raw = value.trim();
  if (raw.length === 0) throw new Error("Empty number");
  const compact = raw.replace(/\u00A0/g, " ").replace(/ /g, "");
  const normalized = compact.includes(".") ? compact : compact.replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n)) throw new Error(`Invalid number: ${value}`);
  return n;
}

function parseNullableNumber(value: string): number | null {
  const v = value.trim();
  if (v.length === 0) return null;
  return parseNumber(v);
}

function parseNullableInt(value: string): number | null {
  const v = value.trim();
  if (v.length === 0) return null;
  const n = Number(v.replace(/\u00A0/g, " ").replace(/ /g, ""));
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return n;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function fetchExistingProductIds(
  supabase: SupabaseClient<Database>,
  ids: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const part of chunk(ids, 500)) {
    const { data, error } = await supabase.from("products").select("id").in("id", part);
    if (error) throw new Error(`Failed to query products: ${error.message}`);
    for (const row of data ?? []) {
      existing.add(row.id);
    }
  }
  return existing;
}

export async function importProductsCsv(params: {
  supabase: SupabaseClient<Database>;
  csvText: string;
  dryRun?: boolean;
  imageBaseUrl?: string | null;
  imageItemsDir?: string | null;
}): Promise<ImportProductsCsvResult> {
  const dryRun = params.dryRun === true;
  const imageBaseUrlRaw = params.imageBaseUrl?.trim() ?? "";
  let normalizedImageBaseUrl: string | null = null;
  if (imageBaseUrlRaw) {
    try {
      const url = new URL(imageBaseUrlRaw);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Invalid protocol");
      }
      normalizedImageBaseUrl = imageBaseUrlRaw.replace(/\/+$/, "") + "/";
    } catch {
      throw new Error(`imageBaseUrl is not a valid URL: ${imageBaseUrlRaw}`);
    }
  }

  const delimiter = detectDelimiter(params.csvText);
  const table = parseDelimited(params.csvText, delimiter);
  if (table.length === 0) throw new Error("CSV is empty");

  const headers = (table[0] ?? []).map(normalizeHeader);
  const headerSet = new Set(headers);

  const { data: cities, error: citiesError } = await params.supabase
    .from("cities")
    .select("id,slug,name");
  if (citiesError) throw new Error(`Failed to load cities: ${citiesError.message}`);

  const cityRows = (cities ?? []).slice().sort((a, b) => a.slug.localeCompare(b.slug));
  if (cityRows.length === 0) throw new Error("No cities found in DB");

  const requiredBaseCols = [
    "id",
    "title",
    "description",
    "category_slug",
    "base_price",
    "image_url",
    "is_active",
  ];
  const missingBase = requiredBaseCols.filter((c) => !headerSet.has(c));
  if (missingBase.length > 0) {
    throw new Error(`CSV is missing required columns: ${missingBase.join(", ")}`);
  }

  const missingCityCols: string[] = [];
  for (const c of cityRows) {
    for (const suffix of ["in_stock", "stock_qty", "price_override"] as const) {
      const col = `${c.slug}_${suffix}`;
      if (!headerSet.has(col)) missingCityCols.push(col);
    }
  }
  if (missingCityCols.length > 0) {
    throw new Error(`CSV is missing city columns: ${missingCityCols.join(", ")}`);
  }

  const inputRecords: Array<{ rowNum: number; record: Record<string, string> }> = [];
  const parsedProducts: Array<{
    id: string;
    title: string;
    description: string | null;
    category_slug: string;
    base_price: number;
    image_url: string | null;
    is_active: boolean;
  }> = [];
  const parsedInventory: Array<{
    product_id: string;
    city_id: number;
    in_stock: boolean;
    stock_qty: number | null;
    price_override: number | null;
  }> = [];
  const errors: CsvRowError[] = [];

  let generatedIds = false;

  for (let i = 1; i < table.length; i++) {
    const rowCells = table[i] ?? [];
    const isBlank = rowCells.every((c) => c.trim().length === 0);
    if (isBlank) continue;

    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j] ?? "";
      if (!key) continue;
      record[key] = (rowCells[j] ?? "").trim();
    }

    const rowNum = i + 1; // header is line 1
    inputRecords.push({ rowNum, record });

    const rowMessages: string[] = [];

    let id = (record["id"] ?? "").trim();
    if (id.length === 0) {
      id = crypto.randomUUID();
      record["id"] = id;
      generatedIds = true;
    } else if (!parseUuid(id)) {
      rowMessages.push(`id must be a UUID (got: ${id})`);
    }

    const title = (record["title"] ?? "").trim();
    if (title.length === 0) rowMessages.push("title is required");

    const descriptionRaw = (record["description"] ?? "").trim();
    const description = descriptionRaw.length > 0 ? descriptionRaw : null;

    const categorySlugRaw = (record["category_slug"] ?? "").trim().toLowerCase();
    const category_slug = categorySlugRaw.length > 0 ? categorySlugRaw : "other";
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(category_slug)) {
      rowMessages.push(
        `category_slug must match [a-z0-9_-] and not be empty (got: ${category_slug})`,
      );
    }

    const imageUrlRaw = (record["image_url"] ?? "").trim();
    let image_url: string | null = imageUrlRaw.length > 0 ? imageUrlRaw : null;
    if (image_url) {
      let isValidUrl = false;
      try {
        const u = new URL(image_url);
        isValidUrl = u.protocol === "http:" || u.protocol === "https:";
      } catch {
        isValidUrl = false;
      }

      if (!isValidUrl) {
        if (normalizedImageBaseUrl) {
          let fileName = image_url.replace(/^\/+/, "");
          if (!hasFileExtension(fileName) && params.imageItemsDir) {
            const base = fileName;
            const variants = [".jpg", ".jpeg", ".png", ".webp"];
            for (const ext of variants) {
              const candidate = base + ext;
              const fullPath = path.join(params.imageItemsDir, candidate);
              if (fs.existsSync(fullPath)) {
                fileName = candidate;
                break;
              }
            }
          }
          const encodedName = encodeURIComponent(fileName);
          image_url = `${normalizedImageBaseUrl}${encodedName}`;
        } else {
          rowMessages.push(`image_url is not a valid URL (got: ${image_url})`);
        }
      }
    }

    let base_price: number | null = null;
    try {
      base_price = parseNumber(record["base_price"] ?? "");
      if (base_price < 0) rowMessages.push("base_price must be >= 0");
    } catch (e: unknown) {
      rowMessages.push(e instanceof Error ? `base_price: ${e.message}` : "base_price: invalid value");
    }

    let is_active = true;
    try {
      is_active = parseBool(record["is_active"] ?? "", true);
    } catch (e: unknown) {
      rowMessages.push(e instanceof Error ? `is_active: ${e.message}` : "is_active: invalid value");
    }

    const invRows: typeof parsedInventory = [];
    for (const c of cityRows) {
      let in_stock = false;
      try {
        in_stock = parseBool(record[`${c.slug}_in_stock`] ?? "", false);
      } catch (e: unknown) {
        rowMessages.push(
          e instanceof Error ? `${c.slug}_in_stock: ${e.message}` : `${c.slug}_in_stock: invalid value`,
        );
      }

      let stock_qty: number | null = null;
      try {
        stock_qty = parseNullableInt(record[`${c.slug}_stock_qty`] ?? "");
        if (stock_qty !== null && stock_qty < 0) rowMessages.push(`${c.slug}_stock_qty must be >= 0`);
      } catch (e: unknown) {
        rowMessages.push(
          e instanceof Error ? `${c.slug}_stock_qty: ${e.message}` : `${c.slug}_stock_qty: invalid value`,
        );
      }

      let price_override: number | null = null;
      try {
        price_override = parseNullableNumber(record[`${c.slug}_price_override`] ?? "");
        if (price_override !== null && price_override < 0) {
          rowMessages.push(`${c.slug}_price_override must be >= 0`);
        }
      } catch (e: unknown) {
        rowMessages.push(
          e instanceof Error
            ? `${c.slug}_price_override: ${e.message}`
            : `${c.slug}_price_override: invalid value`,
        );
      }

      invRows.push({
        product_id: id,
        city_id: c.id,
        in_stock,
        stock_qty,
        price_override,
      });
    }

    if (rowMessages.length > 0 || base_price === null) {
      errors.push({
        rowNum,
        id: id.length > 0 ? id : null,
        title: title.length > 0 ? title : null,
        messages: rowMessages.length > 0 ? rowMessages : ["Invalid row"],
      });
      continue;
    }

    parsedProducts.push({
      id,
      title,
      description,
      category_slug,
      base_price,
      image_url,
      is_active,
    });
    parsedInventory.push(...invRows);
  }

  if (parsedProducts.length === 0) {
    throw new Error("No valid rows to import");
  }

  const existingIds = await fetchExistingProductIds(
    params.supabase,
    parsedProducts.map((p) => p.id),
  );
  const inserted = parsedProducts.filter((p) => !existingIds.has(p.id)).length;
  const updated = parsedProducts.length - inserted;

  if (!dryRun) {
    for (const part of chunk(parsedProducts, 200)) {
      const { error } = await params.supabase.from("products").upsert(part, { onConflict: "id" });
      if (error) throw new Error(`Failed to upsert products: ${error.message}`);
    }
    for (const part of chunk(parsedInventory, 500)) {
      const { error } = await params.supabase
        .from("inventory")
        .upsert(part, { onConflict: "product_id,city_id" });
      if (error) throw new Error(`Failed to upsert inventory: ${error.message}`);
    }
  }

  let outputXlsxBase64: string | null = null;
  if (generatedIds) {
    const aoa: string[][] = [headers];
    for (const { record } of inputRecords) {
      aoa.push(headers.map((h) => record[h] ?? ""));
    }
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "products");
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    outputXlsxBase64 = buffer.toString("base64");
  }

  return {
    delimiter,
    cities: cityRows.map((c) => ({ id: c.id, slug: c.slug, name: c.name })),
    rows: { total: inputRecords.length, valid: parsedProducts.length, invalid: errors.length },
    products: { inserted, updated },
    inventoryRows: parsedInventory.length,
    generatedIds,
    outputXlsxBase64,
    errors,
  };
}
