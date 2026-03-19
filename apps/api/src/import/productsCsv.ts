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

const TRUE_BOOL_VALUES = new Set([
  "true",
  "1",
  "yes",
  "y",
  "\u0434\u0430", // да
  "\u0438\u0441\u0442\u0438\u043d\u0430", // истина
]);

const FALSE_BOOL_VALUES = new Set([
  "false",
  "0",
  "no",
  "n",
  "\u043d\u0435\u0442", // нет
  "\u043b\u043e\u0436\u044c", // ложь
]);

function parseBool(value: string, fallback: boolean): boolean {
  const v = value.trim().toLowerCase();
  if (v.length === 0) return fallback;
  if (TRUE_BOOL_VALUES.has(v)) return true;
  if (FALSE_BOOL_VALUES.has(v)) return false;
  throw new Error(`Invalid boolean: ${value}`);
}

const CATEGORY_ALIAS_MAP: Record<string, string> = {
  other: "other",
  disposable: "disposable",
  disposables: "disposable",
  accessory: "accessory",
  accessories: "accessory",
  liquid: "liquid",
  liquids: "liquid",
  cartridge: "cartridge",
  cartridges: "cartridge",
  "\u043e\u0434\u043d\u043e\u0440\u0430\u0437\u043a\u0438": "disposable", // одноразки
  "\u043e\u0434\u043d\u043e\u0440\u0430\u0437\u043a\u0430": "disposable", // одноразка
  "\u0430\u043a\u0441\u0435\u0441\u0441\u0443\u0430\u0440\u044b": "accessory", // аксессуары
  "\u0430\u043a\u0441\u0435\u0441\u0441\u0443\u0430\u0440": "accessory", // аксессуар
  "\u0436\u0438\u0434\u043a\u043e\u0441\u0442\u0438": "liquid", // жидкости
  "\u0436\u0438\u0434\u043a\u043e\u0441\u0442\u044c": "liquid", // жидкость
  "\u043a\u0430\u0440\u0442\u0440\u0438\u0434\u0436\u0438": "cartridge", // картриджи
  "\u043a\u0430\u0440\u0442\u0440\u0438\u0434\u0436": "cartridge", // картридж
  "\u0438\u0441\u043f\u0430\u0440\u0438\u0442\u0435\u043b\u0438": "cartridge", // испарители
  "\u0438\u0441\u043f\u0430\u0440\u0438\u0442\u0435\u043b\u044c": "cartridge", // испаритель
};

function normalizeCategorySlug(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.length === 0) return "other";
  return CATEGORY_ALIAS_MAP[v] ?? v;
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

type ExistingProductUsage = {
  exists: boolean;
  cityIds: Set<number>;
};

function addCityUsage(
  usageByProductId: Map<string, ExistingProductUsage>,
  productId: string,
  cityId: number,
): void {
  const usage = usageByProductId.get(productId) ?? { exists: true, cityIds: new Set<number>() };
  usage.exists = true;
  usage.cityIds.add(cityId);
  usageByProductId.set(productId, usage);
}

function parseJoinedCityIds(value: unknown): number[] {
  const rows = Array.isArray(value) ? value : [value];
  const cityIds: number[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const maybeCityId = (row as { city_id?: unknown }).city_id;
    if (typeof maybeCityId === "number" && Number.isFinite(maybeCityId)) {
      cityIds.push(maybeCityId);
    }
  }

  return cityIds;
}

async function fetchExistingProductUsageByCity(
  supabase: SupabaseClient<Database>,
  ids: string[],
): Promise<Map<string, ExistingProductUsage>> {
  const usageByProductId = new Map<string, ExistingProductUsage>();

  for (const part of chunk(ids, 500)) {
    const [
      { data: products, error: productsError },
      { data: inventory, error: inventoryError },
      { data: orderItems, error: orderItemsError },
    ] = await Promise.all([
      supabase.from("products").select("id").in("id", part),
      supabase.from("inventory").select("product_id,city_id").in("product_id", part),
      supabase
        .from("order_items")
        .select("product_id,orders!inner(city_id)")
        .in("product_id", part),
    ]);

    if (productsError) throw new Error(`Failed to query products: ${productsError.message}`);
    if (inventoryError) throw new Error(`Failed to query inventory: ${inventoryError.message}`);
    if (orderItemsError) throw new Error(`Failed to query order history: ${orderItemsError.message}`);

    for (const row of products ?? []) {
      const usage = usageByProductId.get(row.id) ?? { exists: true, cityIds: new Set<number>() };
      usage.exists = true;
      usageByProductId.set(row.id, usage);
    }

    for (const row of (inventory ?? []) as Array<{ product_id: string; city_id: number }>) {
      addCityUsage(usageByProductId, row.product_id, row.city_id);
    }

    for (const row of (orderItems ?? []) as Array<{ product_id: string | null; orders: unknown }>) {
      if (typeof row.product_id !== "string") continue;
      const joinedCityIds = parseJoinedCityIds(row.orders);
      if (joinedCityIds.length === 0) {
        const usage =
          usageByProductId.get(row.product_id) ?? { exists: true, cityIds: new Set<number>() };
        usage.exists = true;
        usageByProductId.set(row.product_id, usage);
        continue;
      }
      for (const cityId of joinedCityIds) {
        addCityUsage(usageByProductId, row.product_id, cityId);
      }
    }
  }

  return usageByProductId;
}

export async function importProductsCsv(params: {
  supabase: SupabaseClient<Database>;
  csvText: string;
  dryRun?: boolean;
  citySlug?: string | null;
  imageBaseUrl?: string | null;
  imageItemsDir?: string | null;
  imageFileNames?: Iterable<string> | null;
}): Promise<ImportProductsCsvResult> {
  const dryRun = params.dryRun === true;
  const imageBaseUrlRaw = params.imageBaseUrl?.trim() ?? "";
  const normalizedImageFileNames = params.imageFileNames
    ? new Set(Array.from(params.imageFileNames, (x) => x.toLowerCase()))
    : null;
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
  const normalizedTargetCitySlug = params.citySlug?.trim().toLowerCase() ?? null;
  const targetCity =
    normalizedTargetCitySlug === null
      ? null
      : cityRows.find((city) => city.slug.toLowerCase() === normalizedTargetCitySlug) ?? null;
  if (normalizedTargetCitySlug !== null && targetCity === null) {
    throw new Error(`Unknown citySlug: ${params.citySlug}`);
  }

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

  const inventorySuffixes = ["in_stock", "stock_qty", "price_override"] as const;
  const inventoryCities = targetCity ? [targetCity] : cityRows;
  const inventoryColumnByCitySlug = new Map<
    string,
    Record<(typeof inventorySuffixes)[number], string>
  >();
  const missingCityCols: string[] = [];

  for (const c of inventoryCities) {
    const columnMap = {
      in_stock: "",
      stock_qty: "",
      price_override: "",
    } satisfies Record<(typeof inventorySuffixes)[number], string>;

    for (const suffix of inventorySuffixes) {
      const genericCol = suffix;
      const prefixedCol = `${c.slug}_${suffix}`;

      if (targetCity && headerSet.has(genericCol)) {
        columnMap[suffix] = genericCol;
        continue;
      }
      if (headerSet.has(prefixedCol)) {
        columnMap[suffix] = prefixedCol;
        continue;
      }
      missingCityCols.push(targetCity ? genericCol : prefixedCol);
    }

    inventoryColumnByCitySlug.set(c.slug, columnMap);
  }
  if (missingCityCols.length > 0) {
    throw new Error(`CSV is missing city columns: ${missingCityCols.join(", ")}`);
  }

  const inputRecords: Array<{ rowNum: number; record: Record<string, string> }> = [];
  const parsedProducts: Array<{
    rowNum: number;
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

    const categorySlugRaw = record["category_slug"] ?? "";
    const category_slug = normalizeCategorySlug(categorySlugRaw);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(category_slug)) {
      rowMessages.push(
        `category_slug must match [a-z0-9_-] and not be empty (got: ${category_slug})`,
      );
    }

    const imageUrlRaw = (record["image_url"] ?? "").trim();
    let image_url: string | null = imageUrlRaw.length > 0 ? imageUrlRaw : null;
    if (image_url) {
      let parsedImageUrl: URL | null = null;
      try {
        const u = new URL(image_url);
        if (u.protocol === "http:" || u.protocol === "https:") {
          parsedImageUrl = u;
        }
      } catch {
        parsedImageUrl = null;
      }

      const resolveFileNameExtension = (inputName: string): string => {
        const trimmed = inputName.trim().replace(/^\/+/, "");
        if (!trimmed || hasFileExtension(trimmed)) return trimmed;

        const variants = [".webp", ".jpg", ".jpeg", ".png"];
        if (normalizedImageFileNames) {
          for (const ext of variants) {
            const candidate = trimmed + ext;
            if (normalizedImageFileNames.has(candidate.toLowerCase())) {
              return candidate;
            }
          }
        }

        if (params.imageItemsDir) {
          for (const ext of variants) {
            const candidate = trimmed + ext;
            const fullPath = path.join(params.imageItemsDir, candidate);
            if (fs.existsSync(fullPath)) {
              return candidate;
            }
          }
        }

        return trimmed;
      };

      if (normalizedImageBaseUrl) {
        let fileNameForBase: string | null = null;

        if (parsedImageUrl) {
          let baseUrl: URL | null = null;
          try {
            baseUrl = new URL(normalizedImageBaseUrl);
          } catch {
            baseUrl = null;
          }

          if (
            baseUrl &&
            parsedImageUrl.origin === baseUrl.origin &&
            parsedImageUrl.pathname.startsWith(baseUrl.pathname)
          ) {
            const rawRelative = parsedImageUrl.pathname.slice(baseUrl.pathname.length);
            try {
              fileNameForBase = decodeURIComponent(rawRelative).replace(/^\/+/, "");
            } catch {
              fileNameForBase = rawRelative.replace(/^\/+/, "");
            }
          }
        } else {
          fileNameForBase = image_url;
        }

        if (fileNameForBase) {
          const resolvedFileName = resolveFileNameExtension(fileNameForBase);
          const encodedName = resolvedFileName
            .split("/")
            .filter((part) => part.length > 0)
            .map((part) => encodeURIComponent(part))
            .join("/");
          image_url = `${normalizedImageBaseUrl}${encodedName}`;
        } else if (!parsedImageUrl) {
          rowMessages.push(`image_url is not a valid URL (got: ${image_url})`);
        }
      } else if (!parsedImageUrl) {
        rowMessages.push(`image_url is not a valid URL (got: ${image_url})`);
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
    for (const c of inventoryCities) {
      const cityColumns = inventoryColumnByCitySlug.get(c.slug);
      if (!cityColumns) {
        rowMessages.push(`Missing inventory column mapping for city: ${c.slug}`);
        continue;
      }

      let in_stock = false;
      try {
        in_stock = parseBool(record[cityColumns.in_stock] ?? "", false);
      } catch (e: unknown) {
        rowMessages.push(
          e instanceof Error ? `${c.slug}_in_stock: ${e.message}` : `${c.slug}_in_stock: invalid value`,
        );
      }

      let stock_qty: number | null = null;
      try {
        stock_qty = parseNullableInt(record[cityColumns.stock_qty] ?? "");
        if (stock_qty !== null && stock_qty < 0) rowMessages.push(`${c.slug}_stock_qty must be >= 0`);
      } catch (e: unknown) {
        rowMessages.push(
          e instanceof Error ? `${c.slug}_stock_qty: ${e.message}` : `${c.slug}_stock_qty: invalid value`,
        );
      }

      let price_override: number | null = null;
      try {
        price_override = parseNullableNumber(record[cityColumns.price_override] ?? "");
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
      rowNum,
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

  const inputRecordByRowNum = new Map(inputRecords.map((item) => [item.rowNum, item.record]));
  const detachedSourceProductIds = new Set<string>();

  if (targetCity) {
    const usageByProductId = await fetchExistingProductUsageByCity(
      params.supabase,
      parsedProducts.map((p) => p.id),
    );

    for (const product of parsedProducts) {
      const usage = usageByProductId.get(product.id);
      if (!usage?.exists) continue;

      const hasOtherCityUsage = Array.from(usage.cityIds).some((cityId) => cityId !== targetCity.id);
      if (!hasOtherCityUsage) continue;

      const sourceProductId = product.id;
      const nextProductId = crypto.randomUUID();

      product.id = nextProductId;
      const sourceRecord = inputRecordByRowNum.get(product.rowNum);
      if (sourceRecord) {
        sourceRecord["id"] = nextProductId;
      }

      for (const inv of parsedInventory) {
        if (inv.product_id === sourceProductId && inv.city_id === targetCity.id) {
          inv.product_id = nextProductId;
        }
      }

      detachedSourceProductIds.add(sourceProductId);
      generatedIds = true;
    }
  }

  const existingIds = await fetchExistingProductIds(
    params.supabase,
    parsedProducts.map((p) => p.id),
  );
  const inserted = parsedProducts.filter((p) => !existingIds.has(p.id)).length;
  const updated = parsedProducts.length - inserted;

  if (!dryRun) {
    if (targetCity && detachedSourceProductIds.size > 0) {
      for (const part of chunk(Array.from(detachedSourceProductIds), 500)) {
        const { error } = await params.supabase
          .from("inventory")
          .delete()
          .eq("city_id", targetCity.id)
          .in("product_id", part);

        if (error) {
          throw new Error(`Failed to detach city inventory from shared products: ${error.message}`);
        }
      }
    }

    for (const part of chunk(parsedProducts, 200)) {
      const payload = part.map(({ rowNum: _rowNum, ...product }) => product);
      const { error } = await params.supabase.from("products").upsert(payload, { onConflict: "id" });
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
    cities: inventoryCities.map((c) => ({ id: c.id, slug: c.slug, name: c.name })),
    rows: { total: inputRecords.length, valid: parsedProducts.length, invalid: errors.length },
    products: { inserted, updated },
    inventoryRows: parsedInventory.length,
    generatedIds,
    outputXlsxBase64,
    errors,
  };
}
