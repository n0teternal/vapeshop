import type { FastifyInstance, FastifyRequest } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { z } from "zod";
import { config } from "../config.js";
import { HttpError, isHttpError } from "../httpError.js";
import { decodeCsvBuffer } from "../import/decodeCsvBuffer.js";
import { importProductsCsv } from "../import/productsCsv.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import { deleteMessage } from "../telegram/api.js";
import { requireAdmin } from "./requireAdmin.js";

type ApiSuccess<T> = { ok: true; data: T };
type ApiFailure = { ok: false; error: { code: string; message: string } };

function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ApiFailure {
  return { ok: false, error: { code, message } };
}

function toNumber(value: unknown, fieldName: string): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(n)) {
    throw new HttpError(500, "DB", `Invalid numeric field ${fieldName}`);
  }
  return n;
}

function toCount(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

function decodeSpreadsheetBuffer(buffer: Buffer): string {
  const book = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = book.SheetNames[0];
  if (!firstSheetName) {
    throw new HttpError(400, "BAD_REQUEST", "Spreadsheet is empty");
  }

  const sheet = book.Sheets[firstSheetName];
  if (!sheet) {
    throw new HttpError(400, "BAD_REQUEST", "Spreadsheet sheet is missing");
  }

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new HttpError(400, "BAD_REQUEST", "Spreadsheet has no rows");
  }

  return rows
    .map((row) => {
      const cells = Array.isArray(row)
        ? row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)))
        : [];
      return stringifyDelimitedRow(cells, ";");
    })
    .join("\n");
}

function sanitizeFileName(filename: string): string {
  const base = path.basename(filename);
  // Keep Unicode letters/numbers; replace only truly unsafe filename chars.
  return base
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]+/g, "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120);
}

function inferMimeType(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".heic") return "image/heic";
  if (ext === ".avif") return "image/avif";
  return null;
}

type ListedImageFile = { name: string; size: number; updatedAt: string };
type StorageLocation = { bucket: string; prefix: string };

function parseStorageLocationFromBaseUrl(baseUrl: string | null): StorageLocation | null {
  if (!baseUrl) return null;

  try {
    const url = new URL(baseUrl);
    const marker = "/storage/v1/object/public/";
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex < 0) return null;

    const tail = url.pathname
      .slice(markerIndex + marker.length)
      .replace(/^\/+|\/+$/g, "");
    if (!tail) return null;

    const [bucket, ...prefixParts] = tail.split("/").map((part) => decodeURIComponent(part));
    if (!bucket) return null;

    return { bucket, prefix: prefixParts.join("/") };
  } catch {
    return null;
  }
}

function joinStoragePath(prefix: string, filename: string): string {
  return prefix ? `${prefix}/${filename}` : filename;
}

function isStorageNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { message?: unknown; statusCode?: unknown };
  const message =
    typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
  const statusCode = maybeError.statusCode;
  return message.includes("not found") || statusCode === 404 || statusCode === "404";
}

async function listLocalItemFiles(itemsDir: string): Promise<ListedImageFile[]> {
  await fs.mkdir(itemsDir, { recursive: true });
  const entries = await fs.readdir(itemsDir, { withFileTypes: true });
  const files: ListedImageFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === ".gitkeep") continue;
    const fullPath = path.join(itemsDir, name);
    const stat = await fs.stat(fullPath);
    files.push({ name, size: stat.size, updatedAt: stat.mtime.toISOString() });
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

async function listStorageItemFiles(location: StorageLocation): Promise<ListedImageFile[]> {
  const supabase = createServiceSupabaseClient();
  const files: ListedImageFile[] = [];
  const pageSize = 1000;
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase.storage.from(location.bucket).list(location.prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });

    if (error) {
      throw new HttpError(500, "STORAGE", `Failed to list storage files: ${error.message}`);
    }

    const page = data ?? [];
    for (const entry of page) {
      if (!entry || typeof entry.name !== "string") continue;
      if (entry.name === ".gitkeep") continue;
      if (entry.id === null) continue;

      const size =
        entry.metadata && typeof entry.metadata === "object" && "size" in entry.metadata
          ? Number((entry.metadata as { size?: unknown }).size ?? 0)
          : 0;
      const updatedAt =
        typeof entry.updated_at === "string" && entry.updated_at.length > 0
          ? entry.updated_at
          : new Date(0).toISOString();

      files.push({
        name: entry.name,
        size: Number.isFinite(size) ? size : 0,
        updatedAt,
      });
    }

    if (page.length < pageSize) break;
    offset += page.length;
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

function getParamId(request: FastifyRequest): string {
  const params = request.params as unknown;
  const parsed = z.object({ id: z.string().uuid() }).safeParse(params);
  if (!parsed.success) {
    throw new HttpError(400, "BAD_REQUEST", "Invalid id");
  }
  return parsed.data.id;
}

function errorToResponse(e: unknown): { statusCode: number; body: ApiFailure } {
  if (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE"
  ) {
    return {
      statusCode: 400,
      body: fail("BAD_REQUEST", "File too large (max 5MB)"),
    };
  }

  if (isHttpError(e)) {
    return { statusCode: e.statusCode, body: fail(e.code, e.message) };
  }
  const message = e instanceof Error ? e.message : "Unexpected error";
  return { statusCode: 500, body: fail("INTERNAL", message) };
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const itemsDir = path.resolve(process.cwd(), "static", "items");

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/me",
    async (request, reply) => {
      try {
        const me = await requireAdmin(request);
        return reply.code(200).send(ok(me));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/cities",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("cities")
          .select("id,name,slug")
          .order("slug", { ascending: true });

        if (error) {
          throw new HttpError(500, "DB", `Failed to load cities: ${error.message}`);
        }

        return reply.code(200).send(ok(data ?? []));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const querySchema = z.object({
          tab: z.enum(["active", "archive"]).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        });
        const parsedQuery = querySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid query");
        }

        const tab = parsedQuery.data.tab ?? "active";
        const limit = parsedQuery.data.limit ?? 120;
        const isActive = tab === "active";
        const supabase = createServiceSupabaseClient();

        const [
          { data: cities, error: citiesError },
          { data: products, error: productsError },
          { count: activeCountRaw, error: activeCountError },
          { count: archiveCountRaw, error: archiveCountError },
        ] =
          await Promise.all([
            supabase.from("cities").select("id,slug").order("slug", { ascending: true }),
            supabase
              .from("products")
              .select("id,title,description,base_price,image_url,is_active,created_at")
              .eq("is_active", isActive)
              .order("created_at", { ascending: false })
              .limit(limit),
            supabase
              .from("products")
              .select("id", { count: "exact", head: true })
              .eq("is_active", true),
            supabase
              .from("products")
              .select("id", { count: "exact", head: true })
              .eq("is_active", false),
          ]);

        if (citiesError) {
          throw new HttpError(500, "DB", `Failed to load cities: ${citiesError.message}`);
        }
        if (productsError) {
          throw new HttpError(
            500,
            "DB",
            `Failed to load products: ${productsError.message}`,
          );
        }
        if (activeCountError) {
          throw new HttpError(500, "DB", `Failed to count active products: ${activeCountError.message}`);
        }
        if (archiveCountError) {
          throw new HttpError(
            500,
            "DB",
            `Failed to count archive products: ${archiveCountError.message}`,
          );
        }

        const cityList = (cities ?? []).map((c) => ({ id: c.id, slug: c.slug }));
        const productList = products ?? [];
        const productIds = productList.map((p) => p.id);

        const { data: inventory, error: inventoryError } =
          productIds.length > 0
            ? await supabase
                .from("inventory")
                .select("product_id,city_id,in_stock,stock_qty,price_override")
                .in("product_id", productIds)
            : { data: [], error: null };

        if (inventoryError) {
          throw new HttpError(
            500,
            "DB",
            `Failed to load inventory: ${inventoryError.message}`,
          );
        }

        type InventoryRow = {
          product_id: string;
          city_id: number;
          in_stock: boolean;
          stock_qty: number | null;
          price_override: unknown;
        };
        const invList = (inventory ?? []) as unknown as InventoryRow[];
        const invByKey = new Map<string, InventoryRow>();
        for (const row of invList) {
          invByKey.set(`${row.product_id}:${row.city_id}`, row);
        }

        const result = productList.map((p) => {
          const basePrice = toNumber(p.base_price, "products.base_price");

          return {
            id: p.id,
            title: p.title,
            description: p.description,
            base_price: basePrice,
            image_url: p.image_url,
            is_active: p.is_active,
            inventory: cityList.map((c) => {
              const inv = invByKey.get(`${p.id}:${c.id}`);
              return {
                city_id: c.id,
                city_slug: c.slug,
                in_stock: inv?.in_stock ?? false,
                stock_qty: inv?.stock_qty ?? null,
                price_override:
                  inv?.price_override === null || inv?.price_override === undefined
                    ? null
                    : toNumber(inv.price_override, "inventory.price_override"),
              };
            }),
          };
        });

        const activeCount = toCount(activeCountRaw);
        const archiveCount = toCount(archiveCountRaw);

        return reply.code(200).send(
          ok({
            tab,
            limit,
            total: tab === "active" ? activeCount : archiveCount,
            activeCount,
            archiveCount,
            items: result,
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const schema = z.object({
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(10_000).nullable().optional(),
          basePrice: z.number().finite().nonnegative(),
          isActive: z.boolean().optional(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("products")
          .insert({
            title: parsed.data.title,
            description: parsed.data.description ?? null,
            base_price: parsed.data.basePrice,
            is_active: parsed.data.isActive ?? true,
          })
          .select("id,title,description,base_price,image_url,is_active,created_at")
          .single();

        if (error) {
          throw new HttpError(500, "DB", `Failed to create product: ${error.message}`);
        }
        if (!data) {
          throw new HttpError(500, "DB", "Failed to create product (empty response)");
        }

        return reply.code(200).send(
          ok({
            id: data.id,
            title: data.title,
            description: data.description,
            base_price: toNumber(data.base_price, "products.base_price"),
            image_url: data.image_url,
            is_active: data.is_active,
            created_at: data.created_at,
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.put<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products/:id",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const productId = getParamId(request);

        const schema = z.object({
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(10_000).nullable(),
          basePrice: z.number().finite().nonnegative(),
          isActive: z.boolean(),
          imageUrl: z.string().trim().url().nullable().optional(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const update: Record<string, unknown> = {
          title: parsed.data.title,
          description: parsed.data.description,
          base_price: parsed.data.basePrice,
          is_active: parsed.data.isActive,
        };
        if (Object.prototype.hasOwnProperty.call(parsed.data, "imageUrl")) {
          update.image_url = parsed.data.imageUrl ?? null;
        }

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("products")
          .update(update)
          .eq("id", productId)
          .select("id,title,description,base_price,image_url,is_active,created_at")
          .single();

        if (error) {
          throw new HttpError(500, "DB", `Failed to update product: ${error.message}`);
        }
        if (!data) {
          throw new HttpError(404, "NOT_FOUND", "Product not found");
        }

        return reply.code(200).send(
          ok({
            id: data.id,
            title: data.title,
            description: data.description,
            base_price: toNumber(data.base_price, "products.base_price"),
            image_url: data.image_url,
            is_active: data.is_active,
            created_at: data.created_at,
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products/:id/image",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const productId = getParamId(request);

        const file = await request.file();
        if (!file) {
          throw new HttpError(400, "BAD_REQUEST", "file is required");
        }

        const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
        const inferredMime = inferMimeType(file.filename ?? "");
        const mimeType =
          typeof file.mimetype === "string" && file.mimetype.trim().length > 0
            ? file.mimetype.trim().toLowerCase()
            : inferredMime;
        if (!mimeType || !allowedTypes.has(mimeType)) {
          throw new HttpError(400, "BAD_REQUEST", "Only jpeg/png/webp allowed");
        }

        const buffer = await file.toBuffer();
        const maxSize = 5 * 1024 * 1024;
        if (buffer.byteLength > maxSize) {
          throw new HttpError(400, "BAD_REQUEST", "File too large (max 5MB)");
        }

        const supabase = createServiceSupabaseClient();

        const { data: existing, error: existingError } = await supabase
          .from("products")
          .select("id")
          .eq("id", productId)
          .maybeSingle();

        if (existingError) {
          throw new HttpError(500, "DB", `Failed to load product: ${existingError.message}`);
        }
        if (!existing) {
          throw new HttpError(404, "NOT_FOUND", "Product not found");
        }

        const safeName = sanitizeFileName(file.filename);
        const objectPath = `${productId}/${Date.now()}_${safeName}`;

        const { error: uploadError } = await supabase.storage
          .from("product-images")
          .upload(objectPath, buffer, {
            contentType: mimeType,
            upsert: false,
          });

        if (uploadError) {
          throw new HttpError(500, "STORAGE", `Upload failed: ${uploadError.message}`);
        }

        const { data: publicData } = supabase.storage
          .from("product-images")
          .getPublicUrl(objectPath);

        const imageUrl = publicData.publicUrl;

        const { data: updated, error: updateError } = await supabase
          .from("products")
          .update({ image_url: imageUrl })
          .eq("id", productId)
          .select("id")
          .single();

        if (updateError) {
          throw new HttpError(500, "DB", `Failed to set image_url: ${updateError.message}`);
        }
        if (!updated) {
          throw new HttpError(404, "NOT_FOUND", "Product not found");
        }

        return reply.code(200).send(ok({ imageUrl }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.put<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/inventory",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const schema = z.object({
          productId: z.string().uuid(),
          citySlug: z.string().trim().min(1).max(50),
          inStock: z.boolean(),
          stockQty: z.number().int().nonnegative().nullable().optional(),
          priceOverride: z.number().finite().nonnegative().nullable().optional(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const { data: city, error: cityError } = await supabase
          .from("cities")
          .select("id,slug")
          .eq("slug", parsed.data.citySlug)
          .single();

        if (cityError) {
          throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
        }
        if (!city) {
          throw new HttpError(400, "CITY_NOT_FOUND", "City not found");
        }

        const { error } = await supabase.from("inventory").upsert(
          {
            product_id: parsed.data.productId,
            city_id: city.id,
            in_stock: parsed.data.inStock,
            stock_qty: parsed.data.stockQty ?? null,
            price_override: parsed.data.priceOverride ?? null,
          },
          { onConflict: "product_id,city_id" },
        );

        if (error) {
          throw new HttpError(500, "DB", `Failed to upsert inventory: ${error.message}`);
        }

        return reply.code(200).send(
          ok({ productId: parsed.data.productId, citySlug: parsed.data.citySlug }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: Buffer | ApiFailure }>(
    "/api/admin/export/products.xlsx",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const supabase = createServiceSupabaseClient();
        const [{ data: cities, error: citiesError }, { data: products, error: productsError }] =
          await Promise.all([
            supabase.from("cities").select("id,slug,name").order("slug", { ascending: true }),
            supabase
              .from("products")
              .select(
                "id,title,description,category_slug,base_price,image_url,is_active,created_at",
              )
              .order("title", { ascending: true }),
          ]);

        if (citiesError) {
          throw new HttpError(500, "DB", `Failed to load cities: ${citiesError.message}`);
        }
        if (productsError) {
          throw new HttpError(500, "DB", `Failed to load products: ${productsError.message}`);
        }

        const cityList = (cities ?? []).map((c) => ({ id: c.id, slug: c.slug, name: c.name }));
        const productList = products ?? [];
        const productIds = productList.map((p) => p.id);

        const { data: inventory, error: inventoryError } =
          productIds.length > 0
            ? await supabase
                .from("inventory")
                .select("product_id,city_id,in_stock,stock_qty,price_override")
                .in("product_id", productIds)
            : { data: [], error: null };

        if (inventoryError) {
          throw new HttpError(500, "DB", `Failed to load inventory: ${inventoryError.message}`);
        }

        type ExportInventoryRow = {
          product_id: string;
          city_id: number;
          in_stock: boolean;
          stock_qty: number | null;
          price_override: number | null;
        };
        const invRows = (inventory ?? []) as unknown as ExportInventoryRow[];
        const invByKey = new Map<string, ExportInventoryRow>();
        for (const row of invRows) {
          invByKey.set(`${row.product_id}:${row.city_id}`, row);
        }

        const headers = [
          "id",
          "title",
          "description",
          "category_slug",
          "base_price",
          "image_url",
          "is_active",
          ...cityList.flatMap((c) => [
            `${c.slug}_in_stock`,
            `${c.slug}_stock_qty`,
            `${c.slug}_price_override`,
          ]),
        ];

        const aoa: Array<Array<string | number | boolean>> = [headers];

        for (const product of productList) {
          const row: Array<string | number | boolean> = [
            product.id,
            product.title,
            product.description ?? "",
            product.category_slug ?? "other",
            toNumber(product.base_price, "products.base_price"),
            product.image_url ?? "",
            product.is_active === true,
          ];

          for (const city of cityList) {
            const inv = invByKey.get(`${product.id}:${city.id}`);
            row.push(inv?.in_stock ?? false);
            row.push(inv?.stock_qty ?? "");
            row.push(inv?.price_override ?? "");
          }

          aoa.push(row);
        }

        const sheet = XLSX.utils.aoa_to_sheet(aoa);
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, "products");
        const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
        const fileName = `products.latest.${new Date().toISOString().slice(0, 10)}.xlsx`;

        return reply
          .header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          )
          .header("Content-Disposition", `attachment; filename=\"${fileName}\"`)
          .header("Cache-Control", "no-store")
          .code(200)
          .send(buffer);
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/import/products",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const querySchema = z.object({
          imageMode: z.enum(["filename"]).optional(),
          encoding: z
            .enum(["auto", "utf-8", "windows-1251", "ibm866", "koi8-r"])
            .optional(),
        });
        const parsedQuery = querySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid query");
        }

        const file = await request.file();
        if (!file) {
          throw new HttpError(400, "BAD_REQUEST", "file is required");
        }

        const buffer = await file.toBuffer();
        const maxSize = 5 * 1024 * 1024;
        if (buffer.byteLength > maxSize) {
          throw new HttpError(400, "BAD_REQUEST", "File too large (max 5MB)");
        }

        const fileName = (file.filename ?? "").toLowerCase();
        const mimeType = (file.mimetype ?? "").toLowerCase();
        const isSpreadsheet =
          fileName.endsWith(".xlsx") ||
          fileName.endsWith(".xls") ||
          mimeType.includes("spreadsheetml") ||
          mimeType.includes("ms-excel");

        let csvText: string;
        let encoding: string;
        if (isSpreadsheet) {
          csvText = decodeSpreadsheetBuffer(buffer);
          encoding = "xlsx";
        } else {
          const encodingMode = parsedQuery.data.encoding ?? "auto";
          const decoded = decodeCsvBuffer({
            buffer,
            forcedEncoding: encodingMode === "auto" ? null : encodingMode,
          });
          csvText = decoded.text;
          encoding = decoded.encoding;
        }
        request.log.info({ encoding, fileName, mimeType }, "Decoded imported products file");
        const supabase = createServiceSupabaseClient();
        const useImagePrefix = parsedQuery.data.imageMode === "filename";
        if (useImagePrefix && !config.productImagesBaseUrl) {
          throw new HttpError(
            400,
            "BAD_REQUEST",
            "PRODUCT_IMAGES_BASE_URL is not configured on server",
          );
        }

        const imageFileNames = new Set<string>();
        if (useImagePrefix) {
          const localFiles = await listLocalItemFiles(itemsDir);
          for (const file of localFiles) {
            imageFileNames.add(file.name);
          }

          const storageLocation = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);
          if (storageLocation) {
            const storageFiles = await listStorageItemFiles(storageLocation);
            for (const file of storageFiles) {
              imageFileNames.add(file.name);
            }
          }
        }

        const result = await importProductsCsv({
          supabase,
          csvText,
          imageBaseUrl: useImagePrefix ? config.productImagesBaseUrl : null,
          imageItemsDir: useImagePrefix ? itemsDir : null,
          imageFileNames: useImagePrefix ? imageFileNames : null,
        });

        return reply.code(200).send(ok({ ...result, decodedEncoding: encoding }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/upload/items",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const files = await request.files();
        const storageLocation = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);
        const supabase = storageLocation ? createServiceSupabaseClient() : null;

        if (!storageLocation) {
          await fs.mkdir(itemsDir, { recursive: true });
        }

        const saved: Array<{ originalName: string; fileName: string; size: number }> = [];
        const errors: Array<{ originalName: string; message: string }> = [];
        let received = 0;

        for await (const file of files) {
          received += 1;
          const originalName = file.filename || `file_${Date.now()}`;
          const safeName = sanitizeFileName(originalName) || `file_${Date.now()}`;
          const inferredMime = inferMimeType(safeName);
          const mimeType =
            typeof file.mimetype === "string" && file.mimetype.trim().length > 0
              ? file.mimetype.trim().toLowerCase()
              : inferredMime ?? "application/octet-stream";

          try {
            const buffer = await file.toBuffer();
            if (storageLocation && supabase) {
              const objectPath = joinStoragePath(storageLocation.prefix, safeName);
              const { error: uploadError } = await supabase.storage
                .from(storageLocation.bucket)
                .upload(objectPath, buffer, {
                  upsert: true,
                  contentType: mimeType,
                });

              if (uploadError) {
                throw new HttpError(500, "STORAGE", `Failed to save file: ${uploadError.message}`);
              }
            } else {
              const target = path.join(itemsDir, safeName);
              await fs.writeFile(target, buffer);
            }

            saved.push({ originalName, fileName: safeName, size: buffer.byteLength });
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : "Failed to save file";
            errors.push({ originalName, message });
          }
        }

        if (received === 0) {
          throw new HttpError(400, "BAD_REQUEST", "file is required");
        }

        return reply.code(200).send(
          ok({
            saved,
            errors,
            baseUrl: config.productImagesBaseUrl ?? null,
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/upload/items",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const localFiles = await listLocalItemFiles(itemsDir);
        const storageLocation = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);

        if (!storageLocation) {
          return reply
            .code(200)
            .send(ok({ files: localFiles, baseUrl: config.productImagesBaseUrl ?? null }));
        }

        const storageFiles = await listStorageItemFiles(storageLocation);
        const mergedFiles = [...localFiles];
        const existingNames = new Set(localFiles.map((file) => file.name));

        for (const file of storageFiles) {
          if (existingNames.has(file.name)) continue;
          mergedFiles.push(file);
        }

        mergedFiles.sort((a, b) => a.name.localeCompare(b.name));
        return reply
          .code(200)
          .send(ok({ files: mergedFiles, baseUrl: config.productImagesBaseUrl ?? null }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.delete<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/upload/items/:name",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const params = request.params as unknown;
        const parsed = z.object({ name: z.string().min(1) }).safeParse(params);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid filename");
        }

        const rawName = parsed.data.name;
        const safeName = sanitizeFileName(rawName);
        if (!safeName || safeName !== rawName) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid filename");
        }

        const target = path.join(itemsDir, safeName);
        try {
          await fs.rm(target);
          return reply.code(200).send(ok({ deleted: safeName }));
        } catch (e) {
          const isLocalMissing =
            e &&
            typeof e === "object" &&
            "code" in e &&
            (e as { code?: unknown }).code === "ENOENT";
          if (!isLocalMissing) {
            throw e;
          }

          const storageLocation = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);
          if (!storageLocation) {
            const body = fail("NOT_FOUND", "File not found");
            return reply.code(404).send(body);
          }

          const objectPath = joinStoragePath(storageLocation.prefix, safeName);
          const supabase = createServiceSupabaseClient();
          const { error: removeError } = await supabase.storage
            .from(storageLocation.bucket)
            .remove([objectPath]);

          if (removeError) {
            if (isStorageNotFoundError(removeError)) {
              const body = fail("NOT_FOUND", "File not found");
              return reply.code(404).send(body);
            }
            throw new HttpError(500, "STORAGE", `Failed to delete file: ${removeError.message}`);
          }

          return reply.code(200).send(ok({ deleted: safeName }));
        }
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "ENOENT") {
          const body = fail("NOT_FOUND", "File not found");
          return reply.code(404).send(body);
        }
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/upload/items/rename",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const schema = z.object({
          from: z.string().min(1),
          to: z.string().min(1),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid body");
        }

        const fromSafe = sanitizeFileName(parsed.data.from);
        const toSafe = sanitizeFileName(parsed.data.to);
        if (!fromSafe || !toSafe || fromSafe !== parsed.data.from || toSafe !== parsed.data.to) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid filename");
        }
        if (fromSafe === ".gitkeep" || toSafe === ".gitkeep") {
          throw new HttpError(400, "BAD_REQUEST", "Invalid filename");
        }

        const fromPath = path.join(itemsDir, fromSafe);
        const toPath = path.join(itemsDir, toSafe);
        try {
          await fs.rename(fromPath, toPath);
          return reply.code(200).send(ok({ from: fromSafe, to: toSafe }));
        } catch (e) {
          const isLocalMissing =
            e &&
            typeof e === "object" &&
            "code" in e &&
            (e as { code?: unknown }).code === "ENOENT";
          if (!isLocalMissing) {
            throw e;
          }

          const storageLocation = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);
          if (!storageLocation) {
            const body = fail("NOT_FOUND", "File not found");
            return reply.code(404).send(body);
          }

          const fromObjectPath = joinStoragePath(storageLocation.prefix, fromSafe);
          const toObjectPath = joinStoragePath(storageLocation.prefix, toSafe);
          const supabase = createServiceSupabaseClient();
          const { error: moveError } = await supabase.storage
            .from(storageLocation.bucket)
            .move(fromObjectPath, toObjectPath);

          if (moveError) {
            if (isStorageNotFoundError(moveError)) {
              const body = fail("NOT_FOUND", "File not found");
              return reply.code(404).send(body);
            }
            throw new HttpError(500, "STORAGE", `Failed to rename file: ${moveError.message}`);
          }

          return reply.code(200).send(ok({ from: fromSafe, to: toSafe }));
        }
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "ENOENT") {
          const body = fail("NOT_FOUND", "File not found");
          return reply.code(404).send(body);
        }
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/orders",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const querySchema = z.object({
          status: z.enum(["new", "processing", "done"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        });

        const parsedQuery = querySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid query");
        }

        const status = parsedQuery.data.status ?? "new";
        const limit = parsedQuery.data.limit ?? 50;
        const supabase = createServiceSupabaseClient();

        const { data: orders, error: ordersError } = await supabase
          .from("orders")
          .select(
            "id,created_at,status,city_id,tg_user_id,tg_username,delivery_method,comment,total_price",
          )
          .eq("status", status)
          .order("created_at", { ascending: false })
          .limit(limit);

        if (ordersError) {
          throw new HttpError(500, "DB", `Failed to load orders: ${ordersError.message}`);
        }

        const orderList = orders ?? [];
        if (orderList.length === 0) {
          return reply.code(200).send(ok([]));
        }

        const orderIds = orderList.map((o) => o.id);
        const cityIds = Array.from(
          new Set(orderList.map((o) => o.city_id).filter((x): x is number => typeof x === "number")),
        );

        const [{ data: cities, error: citiesError }, { data: orderItems, error: orderItemsError }] =
          await Promise.all([
            cityIds.length > 0
              ? supabase.from("cities").select("id,slug").in("id", cityIds)
              : Promise.resolve({ data: [], error: null }),
            supabase
              .from("order_items")
              .select("order_id,product_id,qty,unit_price")
              .in("order_id", orderIds),
          ]);

        if (citiesError) {
          throw new HttpError(500, "DB", `Failed to load cities: ${citiesError.message}`);
        }
        if (orderItemsError) {
          throw new HttpError(
            500,
            "DB",
            `Failed to load order items: ${orderItemsError.message}`,
          );
        }

        const citySlugById = new Map((cities ?? []).map((c) => [c.id, c.slug]));

        const itemsList = (orderItems ?? []) as Array<{
          order_id: string;
          product_id: string | null;
          qty: number;
          unit_price: unknown;
        }>;

        const productIds = Array.from(
          new Set(itemsList.map((i) => i.product_id).filter((x): x is string => typeof x === "string")),
        );

        const { data: products, error: productsError } =
          productIds.length > 0
            ? await supabase.from("products").select("id,title").in("id", productIds)
            : { data: [], error: null };

        if (productsError) {
          throw new HttpError(500, "DB", `Failed to load products: ${productsError.message}`);
        }

        const titleByProductId = new Map((products ?? []).map((p) => [p.id, p.title]));

        const itemsByOrderId = new Map<
          string,
          Array<{ product_id: string | null; title: string | null; qty: number; unit_price: number }>
        >();

        for (const it of itemsList) {
          const title =
            it.product_id && titleByProductId.has(it.product_id)
              ? titleByProductId.get(it.product_id) ?? null
              : null;
          const unitPrice = toNumber(it.unit_price, "order_items.unit_price");
          const row = {
            product_id: it.product_id,
            title,
            qty: it.qty,
            unit_price: unitPrice,
          };
          const arr = itemsByOrderId.get(it.order_id) ?? [];
          arr.push(row);
          itemsByOrderId.set(it.order_id, arr);
        }

        const result = orderList.map((o) => ({
          id: o.id,
          created_at: o.created_at,
          status: o.status,
          city_id: o.city_id,
          city_slug: typeof o.city_id === "number" ? citySlugById.get(o.city_id) ?? null : null,
          tg_user_id: o.tg_user_id,
          tg_username: o.tg_username,
          delivery_method: o.delivery_method,
          comment: o.comment,
          total_price: toNumber(o.total_price, "orders.total_price"),
          items: itemsByOrderId.get(o.id) ?? [],
        }));

        return reply.code(200).send(ok(result));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.put<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/orders/:id/status",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const orderId = getParamId(request);

        const schema = z.object({
          status: z.enum(["new", "processing", "done"]),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("orders")
          .update({ status: parsed.data.status })
          .eq("id", orderId)
          .select("id,status,notify_chat_id,notify_message_id")
          .single();

        if (error) {
          throw new HttpError(500, "DB", `Failed to update order status: ${error.message}`);
        }
        if (!data) {
          throw new HttpError(404, "NOT_FOUND", "Order not found");
        }

        if (
          parsed.data.status === "done" &&
          typeof (data as any).notify_chat_id === "number" &&
          typeof (data as any).notify_message_id === "number"
        ) {
          try {
            await deleteMessage({
              botToken: config.telegram.botToken,
              chatId: (data as any).notify_chat_id,
              messageId: (data as any).notify_message_id,
            });
          } catch (e) {
            // Best-effort: status is already updated in DB, so we don't fail the admin action.
            request.log.error({ err: e }, "Failed to delete Telegram message for done order");
          }
        }

        return reply.code(200).send(ok({ id: data.id, status: data.status }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );
}
