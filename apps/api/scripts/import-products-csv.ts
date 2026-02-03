import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

type CityRow = { id: number; slug: string; name: string };

type RowError = {
  rowNum: number;
  id: string | null;
  title: string | null;
  messages: string[];
};

type ParsedProductRow = {
  rowNum: number;
  generatedId: boolean;
  record: Record<string, string>;
  product: {
    id: string;
    title: string;
    description: string | null;
    base_price: number;
    image_url: string | null;
    is_active: boolean;
  };
  inventoryRows: Array<{
    product_id: string;
    city_id: number;
    in_stock: boolean;
    stock_qty: number | null;
    price_override: number | null;
  }>;
};

type Args = {
  file: string;
  dryRun: boolean;
  strict: boolean;
  out: string | null;
};

function parseArgs(argv: string[]): Args {
  let file: string | null = null;
  let dryRun = false;
  let strict = false;
  let out: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--out") {
      const next = argv[i + 1];
      if (!next) throw new Error("Missing value for --out");
      out = next;
      i++;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (!file) {
      file = arg;
      continue;
    }
    throw new Error(`Unexpected extra argument: ${arg}`);
  }

  if (!file) {
    throw new Error(
      "Usage: pnpm -C apps/api tsx scripts/import-products-csv.ts <file.csv> [--dry-run] [--strict] [--out out.csv]",
    );
  }

  return { file, dryRun, strict, out };
}

function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    const markerA = path.join(dir, "pnpm-workspace.yaml");
    const markerB = path.join(dir, ".git");
    if (fs.existsSync(markerA) || fs.existsSync(markerB)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

function loadEnvFromRepoRoot(): void {
  const repoRoot = findRepoRoot(process.cwd());
  const envLocal = path.join(repoRoot, ".env.local");
  const envDefault = path.join(repoRoot, ".env");

  if (fs.existsSync(envLocal)) {
    dotenv.config({ path: envLocal });
    return;
  }
  if (fs.existsSync(envDefault)) {
    dotenv.config({ path: envDefault });
  }
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim().length === 0) throw new Error(`Missing required env: ${key}`);
  return v.trim();
}

function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = {
    ";": (firstLine.match(/;/g) ?? []).length,
    ",": (firstLine.match(/,/g) ?? []).length,
    "\t": (firstLine.match(/\t/g) ?? []).length,
  };

  let best: string = ";";
  let bestCount = -1;
  for (const [delim, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = delim;
      bestCount = count;
    }
  }
  return bestCount <= 0 ? ";" : best;
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
    if (ch === "\r") {
      continue;
    }
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

  // final row
  row.push(value);
  rows.push(row);

  // Remove trailing empty rows
  while (rows.length > 0) {
    const last = rows[rows.length - 1] ?? [];
    const isEmpty = last.every((c) => c.trim().length === 0);
    if (!isEmpty) break;
    rows.pop();
  }

  return rows;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function getCell(record: Record<string, string>, key: string): string {
  return (record[key] ?? "").trim();
}

function parseUuid(value: string): boolean {
  // RFC 4122-ish UUID v4/v1 format check. Accept any version.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function parseBool(value: string, fallback: boolean): boolean {
  const v = value.trim().toLowerCase();
  if (v.length === 0) return fallback;
  if (v === "true" || v === "1" || v === "yes" || v === "y" || v === "да") return true;
  if (v === "false" || v === "0" || v === "no" || v === "n" || v === "нет") return false;
  throw new Error(`Invalid boolean: ${value}`);
}

function parseNumber(value: string): number {
  const raw = value.trim();
  if (raw.length === 0) throw new Error("Empty number");

  // Excel/Sheets often export NBSP or spaces as thousands separators.
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

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function fetchExistingProductIds(
  supabase: ReturnType<typeof createClient>,
  ids: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const part of chunk(ids, 500)) {
    const { data, error } = await supabase.from("products").select("id").in("id", part);
    if (error) throw new Error(`Failed to query products: ${error.message}`);
    for (const row of data ?? []) {
      const id = (row as { id?: unknown }).id;
      if (typeof id === "string") existing.add(id);
    }
  }
  return existing;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  loadEnvFromRepoRoot();
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const filePath = path.resolve(process.cwd(), args.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${filePath}`);
  }

  const fileRaw = fs.readFileSync(filePath, "utf8");
  const delimiter = detectDelimiter(fileRaw);
  const table = parseDelimited(fileRaw, delimiter);
  if (table.length === 0) throw new Error("CSV is empty");

  const headers = (table[0] ?? []).map(normalizeHeader);
  const headerSet = new Set(headers);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: cities, error: citiesError } = await supabase
    .from("cities")
    .select("id,slug,name");
  if (citiesError) throw new Error(`Failed to load cities: ${citiesError.message}`);

  const cityRows: CityRow[] = (cities ?? []) as CityRow[];
  if (cityRows.length === 0) {
    throw new Error("No cities found in DB. Seed cities first.");
  }
  cityRows.sort((a, b) => a.slug.localeCompare(b.slug));

  const requiredBaseCols = ["id", "title", "description", "base_price", "image_url", "is_active"];
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
    throw new Error(
      `CSV is missing city columns: ${missingCityCols.join(", ")} (update the template to match DB cities)`,
    );
  }

  const inputRecords: Array<{ rowNum: number; record: Record<string, string> }> = [];
  const parsed: ParsedProductRow[] = [];
  const errors: RowError[] = [];

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

    const rowNum = i + 1; // CSV line number (1-based), header is line 1.
    inputRecords.push({ rowNum, record });

    const rowMessages: string[] = [];

    let id = getCell(record, "id");
    let generatedId = false;
    if (id.length === 0) {
      id = crypto.randomUUID();
      record["id"] = id;
      generatedId = true;
    } else if (!parseUuid(id)) {
      rowMessages.push(`id must be a UUID (got: ${id})`);
    }

    const title = getCell(record, "title");
    if (title.length === 0) rowMessages.push("title is required");

    const descriptionRaw = getCell(record, "description");
    const description = descriptionRaw.length > 0 ? descriptionRaw : null;

    const imageUrlRaw = getCell(record, "image_url");
    const image_url = imageUrlRaw.length > 0 ? imageUrlRaw : null;
    if (image_url) {
      try {
        // eslint-disable-next-line no-new
        new URL(image_url);
      } catch {
        rowMessages.push(`image_url is not a valid URL (got: ${image_url})`);
      }
    }

    let base_price: number | null = null;
    try {
      base_price = parseNumber(getCell(record, "base_price"));
      if (base_price < 0) rowMessages.push("base_price must be >= 0");
    } catch (e: unknown) {
      rowMessages.push(e instanceof Error ? `base_price: ${e.message}` : "base_price: invalid value");
    }

    let is_active = true;
    try {
      is_active = parseBool(getCell(record, "is_active"), true);
    } catch (e: unknown) {
      rowMessages.push(e instanceof Error ? `is_active: ${e.message}` : "is_active: invalid value");
    }

    const inventoryRows: ParsedProductRow["inventoryRows"] = [];
    for (const c of cityRows) {
      let in_stock = false;
      try {
        in_stock = parseBool(getCell(record, `${c.slug}_in_stock`), false);
      } catch (e: unknown) {
        rowMessages.push(
          e instanceof Error ? `${c.slug}_in_stock: ${e.message}` : `${c.slug}_in_stock: invalid value`,
        );
      }

      let stock_qty: number | null = null;
      try {
        stock_qty = parseNullableInt(getCell(record, `${c.slug}_stock_qty`));
        if (stock_qty !== null && stock_qty < 0) {
          rowMessages.push(`${c.slug}_stock_qty must be >= 0`);
        }
      } catch (e: unknown) {
        rowMessages.push(
          e instanceof Error ? `${c.slug}_stock_qty: ${e.message}` : `${c.slug}_stock_qty: invalid value`,
        );
      }

      let price_override: number | null = null;
      try {
        price_override = parseNullableNumber(getCell(record, `${c.slug}_price_override`));
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

      inventoryRows.push({
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

    parsed.push({
      rowNum,
      generatedId,
      record,
      product: {
        id,
        title,
        description,
        base_price,
        image_url,
        is_active,
      },
      inventoryRows,
    });
  }

  if (parsed.length === 0) {
    console.error("No valid rows to import.");
    if (errors.length > 0) {
      for (const e of errors) {
        console.error(
          `- row ${e.rowNum}${e.title ? ` (${e.title})` : ""}: ${e.messages.join("; ")}`,
        );
      }
    }
    process.exitCode = 1;
    return;
  }

  if (args.strict && errors.length > 0) {
    console.error(`Found ${errors.length} invalid row(s) (strict mode, aborting).`);
    for (const e of errors) {
      console.error(
        `- row ${e.rowNum}${e.title ? ` (${e.title})` : ""}: ${e.messages.join("; ")}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const existingIds = await fetchExistingProductIds(
    supabase,
    parsed.map((r) => r.product.id),
  );

  const toInsert = parsed.filter((r) => !existingIds.has(r.product.id)).length;
  const toUpdate = parsed.length - toInsert;

  if (!args.dryRun) {
    for (const part of chunk(parsed.map((r) => r.product), 200)) {
      const { error } = await supabase.from("products").upsert(part, { onConflict: "id" });
      if (error) throw new Error(`Failed to upsert products: ${error.message}`);
    }

    const invRows = parsed.flatMap((r) => r.inventoryRows);
    for (const part of chunk(invRows, 500)) {
      const { error } = await supabase
        .from("inventory")
        .upsert(part, { onConflict: "product_id,city_id" });
      if (error) throw new Error(`Failed to upsert inventory: ${error.message}`);
    }
  }

  const generatedAny = parsed.some((r) => r.generatedId);
  const outputPath =
    args.out ??
    (generatedAny
      ? path.join(
          path.dirname(filePath),
          `${path.basename(filePath, path.extname(filePath))}.with_ids${path.extname(filePath) || ".csv"}`,
        )
      : null);

  if (outputPath) {
    const headerLine = stringifyDelimitedRow(headers, delimiter);
    const lines: string[] = [headerLine];
    for (const { record } of inputRecords) {
      const row = headers.map((h) => record[h] ?? "");
      lines.push(stringifyDelimitedRow(row, delimiter));
    }
    fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
  }

  console.log(`File: ${filePath}`);
  console.log(`Cities: ${cityRows.map((c) => c.slug).join(", ")}`);
  console.log(`Rows: total=${inputRecords.length} valid=${parsed.length} skipped=${errors.length}`);
  console.log(`Products: add=${toInsert} update=${toUpdate}`);
  console.log(
    `Inventory rows: ${parsed.length * cityRows.length} (${args.dryRun ? "dry-run" : "written"})`,
  );
  if (outputPath) console.log(`Output: ${outputPath}`);

  if (errors.length > 0) {
    console.warn(`Errors (${errors.length}):`);
    for (const e of errors) {
      console.warn(
        `- row ${e.rowNum}${e.title ? ` (${e.title})` : ""}: ${e.messages.join("; ")}`,
      );
    }
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});

