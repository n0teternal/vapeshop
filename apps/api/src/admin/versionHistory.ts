import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient, type Database } from "../supabase/serviceClient.js";

export type AdminChangeVersionKind = "products" | "images";

type StorageLocation = { bucket: string; prefix: string };
type ProductSnapshot = {
  version: 1;
  products: Database["public"]["Tables"]["products"]["Row"][];
  inventory: Array<
    Pick<
      Database["public"]["Tables"]["inventory"]["Row"],
      "product_id" | "city_id" | "in_stock" | "stock_qty" | "price_override"
    >
  >;
  staffInventory: Array<
    Pick<
      Database["public"]["Tables"]["staff_inventory"]["Row"],
      "staff_id" | "city_id" | "product_id" | "stock_qty"
    >
  >;
};

type ImageSnapshot = {
  version: 1;
  storage: "local" | "supabase";
  fileNames: string[];
};

export type AdminChangeVersionSummary = {
  id: string;
  kind: AdminChangeVersionKind;
  citySlug: string | null;
  label: string;
  createdAt: string;
  createdByTgUserId: number;
};

const productSnapshotSchema = z.object({
  version: z.literal(1),
  products: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      description: z.string().nullable(),
      category_slug: z.string(),
      base_price: z.number(),
      image_url: z.string().nullable(),
      is_active: z.boolean(),
      created_at: z.string(),
    }),
  ),
  inventory: z.array(
    z.object({
      product_id: z.string().uuid(),
      city_id: z.number().int().positive(),
      in_stock: z.boolean(),
      stock_qty: z.number().int().nullable(),
      price_override: z.number().nullable(),
    }),
  ),
  staffInventory: z.array(
    z.object({
      staff_id: z.number().int().positive(),
      city_id: z.number().int().positive(),
      product_id: z.string().uuid(),
      stock_qty: z.number().int().min(0),
    }),
  ),
});

const imageSnapshotSchema = z.object({
  version: z.literal(1),
  storage: z.enum(["local", "supabase"]),
  fileNames: z.array(z.string().min(1)),
});

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function parseStorageLocationFromBaseUrl(baseUrl: string | null): StorageLocation | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    const marker = "/storage/v1/object/public/";
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex < 0) return null;
    const tail = url.pathname.slice(markerIndex + marker.length).replace(/^\/+|\/+$/g, "");
    if (!tail) return null;
    const [bucket, ...prefixParts] = tail.split("/").map((part) => decodeURIComponent(part));
    if (!bucket) return null;
    return { bucket, prefix: prefixParts.join("/") };
  } catch {
    return null;
  }
}

function joinStoragePath(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

function imageHistoryPrefix(location: StorageLocation, revisionId: string): string {
  return joinStoragePath(location.prefix, `.admin-history/${revisionId}`);
}

function inferMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".heic") return "image/heic";
  if (ext === ".avif") return "image/avif";
  return "application/octet-stream";
}

async function listLocalImageNames(itemsDir: string): Promise<string[]> {
  await fs.mkdir(itemsDir, { recursive: true });
  const entries = await fs.readdir(itemsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name !== ".gitkeep")
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function listStorageImageNames(location: StorageLocation): Promise<string[]> {
  const supabase = createServiceSupabaseClient();
  const names: string[] = [];
  const pageSize = 1000;
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase.storage.from(location.bucket).list(location.prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      throw new HttpError(500, "STORAGE", `Failed to list image files: ${error.message}`);
    }
    const page = data ?? [];
    for (const entry of page) {
      if (!entry || entry.id === null || !entry.name || entry.name === ".gitkeep") continue;
      names.push(entry.name);
    }
    if (page.length < pageSize) break;
    offset += page.length;
  }

  return names.sort((a, b) => a.localeCompare(b));
}

function assertStorageSuccess(error: { message: string } | null, action: string): void {
  if (error) throw new HttpError(500, "STORAGE", `${action}: ${error.message}`);
}

async function insertVersion(params: {
  id?: string;
  kind: AdminChangeVersionKind;
  citySlug: string | null;
  label: string;
  snapshot: ProductSnapshot | ImageSnapshot;
  tgUserId: number;
}): Promise<AdminChangeVersionSummary> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("admin_change_versions")
    .insert({
      ...(params.id ? { id: params.id } : {}),
      kind: params.kind,
      city_slug: params.citySlug,
      label: params.label,
      snapshot: params.snapshot,
      created_by_tg_user_id: params.tgUserId,
    })
    .select("id,kind,city_slug,label,created_at,created_by_tg_user_id")
    .single();
  if (error || !data) {
    throw new HttpError(500, "DB", `Failed to save restore point: ${error?.message ?? "unknown error"}`);
  }
  return {
    id: data.id,
    kind: data.kind,
    citySlug: data.city_slug,
    label: data.label,
    createdAt: data.created_at,
    createdByTgUserId: data.created_by_tg_user_id,
  };
}

async function captureProductsSnapshot(): Promise<ProductSnapshot> {
  const supabase = createServiceSupabaseClient();
  const [productsResult, inventoryResult, staffInventoryResult] = await Promise.all([
    supabase.from("products").select("id,title,description,category_slug,base_price,image_url,is_active,created_at"),
    supabase.from("inventory").select("product_id,city_id,in_stock,stock_qty,price_override"),
    supabase.from("staff_inventory").select("staff_id,city_id,product_id,stock_qty"),
  ]);
  if (productsResult.error) {
    throw new HttpError(500, "DB", `Failed to snapshot products: ${productsResult.error.message}`);
  }
  if (inventoryResult.error) {
    throw new HttpError(500, "DB", `Failed to snapshot inventory: ${inventoryResult.error.message}`);
  }
  if (staffInventoryResult.error) {
    throw new HttpError(500, "DB", `Failed to snapshot staff inventory: ${staffInventoryResult.error.message}`);
  }
  return {
    version: 1,
    products: productsResult.data ?? [],
    inventory: inventoryResult.data ?? [],
    staffInventory: staffInventoryResult.data ?? [],
  };
}

export async function createProductsRestorePoint(params: {
  tgUserId: number;
  citySlug: string | null;
  label: string;
}): Promise<AdminChangeVersionSummary> {
  return insertVersion({
    kind: "products",
    citySlug: params.citySlug,
    label: params.label,
    snapshot: await captureProductsSnapshot(),
    tgUserId: params.tgUserId,
  });
}

export async function createImagesRestorePoint(params: {
  tgUserId: number;
  itemsDir: string;
  label: string;
}): Promise<AdminChangeVersionSummary> {
  const id = randomUUID();
  const location = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);
  let fileNames: string[] = [];

  try {
    if (location) {
      fileNames = await listStorageImageNames(location);
      const supabase = createServiceSupabaseClient();
      const historyPrefix = imageHistoryPrefix(location, id);
      for (const name of fileNames) {
        const sourcePath = joinStoragePath(location.prefix, name);
        const { data, error } = await supabase.storage.from(location.bucket).download(sourcePath);
        assertStorageSuccess(error, `Failed to back up ${name}`);
        if (!data) throw new HttpError(500, "STORAGE", `Failed to back up ${name}`);
        const backupPath = joinStoragePath(historyPrefix, name);
        const { error: uploadError } = await supabase.storage.from(location.bucket).upload(
          backupPath,
          Buffer.from(await data.arrayBuffer()),
          { upsert: false, contentType: inferMimeType(name), cacheControl: "31536000" },
        );
        assertStorageSuccess(uploadError, `Failed to save backup ${name}`);
      }
    } else {
      fileNames = await listLocalImageNames(params.itemsDir);
      const revisionDir = path.join(params.itemsDir, ".admin-history", id);
      await fs.mkdir(revisionDir, { recursive: true });
      for (const name of fileNames) {
        await fs.copyFile(path.join(params.itemsDir, name), path.join(revisionDir, name));
      }
    }

    return await insertVersion({
      id,
      kind: "images",
      citySlug: null,
      label: params.label,
      snapshot: { version: 1, storage: location ? "supabase" : "local", fileNames },
      tgUserId: params.tgUserId,
    });
  } catch (error) {
    if (location) {
      const supabase = createServiceSupabaseClient();
      const historyPrefix = imageHistoryPrefix(location, id);
      await supabase.storage
        .from(location.bucket)
        .remove(fileNames.map((name) => joinStoragePath(historyPrefix, name)));
    } else {
      await fs.rm(path.join(params.itemsDir, ".admin-history", id), { recursive: true, force: true });
    }
    throw error;
  }
}

export function requireAdminHistoryOwner(tgUserId: number): void {
  if (tgUserId !== config.adminHistory.ownerTgUserId) {
    throw new HttpError(403, "FORBIDDEN", "Restore history is available only to the owner account");
  }
}

export async function listAdminChangeVersions(params: {
  kind: AdminChangeVersionKind;
  citySlug: string | null;
}): Promise<AdminChangeVersionSummary[]> {
  const supabase = createServiceSupabaseClient();
  let query = supabase
    .from("admin_change_versions")
    .select("id,kind,city_slug,label,created_at,created_by_tg_user_id")
    .eq("kind", params.kind)
    .order("created_at", { ascending: false })
    .limit(80);
  if (params.citySlug) query = query.eq("city_slug", params.citySlug);
  const { data, error } = await query;
  if (error) throw new HttpError(500, "DB", `Failed to load restore history: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    citySlug: row.city_slug,
    label: row.label,
    createdAt: row.created_at,
    createdByTgUserId: row.created_by_tg_user_id,
  }));
}

async function restoreProductsSnapshot(snapshot: ProductSnapshot): Promise<void> {
  const supabase = createServiceSupabaseClient();
  const { data: currentProducts, error: currentProductsError } = await supabase
    .from("products")
    .select("id");
  if (currentProductsError) {
    throw new HttpError(500, "DB", `Failed to load current products: ${currentProductsError.message}`);
  }

  if (snapshot.products.length > 0) {
    const { error } = await supabase.from("products").upsert(snapshot.products, { onConflict: "id" });
    if (error) throw new HttpError(500, "DB", `Failed to restore products: ${error.message}`);
  }

  const { error: clearStaffError } = await supabase.from("staff_inventory").delete().gte("id", 0);
  if (clearStaffError) {
    throw new HttpError(500, "DB", `Failed to clear staff inventory: ${clearStaffError.message}`);
  }
  const { error: clearInventoryError } = await supabase.from("inventory").delete().gte("id", 0);
  if (clearInventoryError) {
    throw new HttpError(500, "DB", `Failed to clear inventory: ${clearInventoryError.message}`);
  }

  const snapshotProductIds = new Set(snapshot.products.map((product) => product.id));
  const introducedProductIds = (currentProducts ?? [])
    .map((product) => product.id)
    .filter((id) => !snapshotProductIds.has(id));

  for (const ids of chunk(introducedProductIds, 200)) {
    const { data: usedRows, error: usedRowsError } = await supabase
      .from("order_items")
      .select("product_id")
      .in("product_id", ids);
    if (usedRowsError) {
      throw new HttpError(500, "DB", `Failed to inspect product history: ${usedRowsError.message}`);
    }
    const usedIds = new Set((usedRows ?? []).flatMap((row) => (row.product_id ? [row.product_id] : [])));
    const idsToArchive = ids.filter((id) => usedIds.has(id));
    const idsToDelete = ids.filter((id) => !usedIds.has(id));
    if (idsToArchive.length > 0) {
      const { error } = await supabase.from("products").update({ is_active: false }).in("id", idsToArchive);
      if (error) throw new HttpError(500, "DB", `Failed to archive newer products: ${error.message}`);
    }
    if (idsToDelete.length > 0) {
      const { error } = await supabase.from("products").delete().in("id", idsToDelete);
      if (error) throw new HttpError(500, "DB", `Failed to remove newer products: ${error.message}`);
    }
  }

  for (const rows of chunk(snapshot.inventory, 500)) {
    const { error } = await supabase.from("inventory").insert(rows);
    if (error) throw new HttpError(500, "DB", `Failed to restore inventory: ${error.message}`);
  }
  for (const rows of chunk(snapshot.staffInventory, 500)) {
    const { error } = await supabase.from("staff_inventory").insert(rows);
    if (error) throw new HttpError(500, "DB", `Failed to restore staff inventory: ${error.message}`);
  }
}

async function restoreImagesSnapshot(params: {
  revisionId: string;
  snapshot: ImageSnapshot;
  itemsDir: string;
}): Promise<number> {
  const location = parseStorageLocationFromBaseUrl(config.productImagesBaseUrl);
  if ((location ? "supabase" : "local") !== params.snapshot.storage) {
    throw new HttpError(409, "CONFLICT", "Image storage changed since this restore point was created");
  }

  if (!location) {
    const revisionDir = path.join(params.itemsDir, ".admin-history", params.revisionId);
    for (const name of params.snapshot.fileNames) {
      try {
        await fs.access(path.join(revisionDir, name));
      } catch {
        throw new HttpError(409, "CONFLICT", `Backup file is missing: ${name}`);
      }
    }
    const currentNames = await listLocalImageNames(params.itemsDir);
    await Promise.all(currentNames.map((name) => fs.rm(path.join(params.itemsDir, name))));
    await fs.mkdir(params.itemsDir, { recursive: true });
    for (const name of params.snapshot.fileNames) {
      await fs.copyFile(path.join(revisionDir, name), path.join(params.itemsDir, name));
    }
    return params.snapshot.fileNames.length;
  }

  const supabase = createServiceSupabaseClient();
  const historyPrefix = imageHistoryPrefix(location, params.revisionId);
  const backupNames = await listStorageImageNames({ bucket: location.bucket, prefix: historyPrefix });
  const backupSet = new Set(backupNames);
  for (const name of params.snapshot.fileNames) {
    if (!backupSet.has(name)) {
      throw new HttpError(409, "CONFLICT", `Backup file is missing: ${name}`);
    }
  }

  const currentNames = await listStorageImageNames(location);
  for (const names of chunk(currentNames, 100)) {
    const { error } = await supabase.storage
      .from(location.bucket)
      .remove(names.map((name) => joinStoragePath(location.prefix, name)));
    assertStorageSuccess(error, "Failed to clear current images");
  }
  for (const name of params.snapshot.fileNames) {
    const backupPath = joinStoragePath(historyPrefix, name);
    const { data, error } = await supabase.storage.from(location.bucket).download(backupPath);
    assertStorageSuccess(error, `Failed to restore ${name}`);
    if (!data) throw new HttpError(500, "STORAGE", `Failed to restore ${name}`);
    const { error: uploadError } = await supabase.storage
      .from(location.bucket)
      .upload(joinStoragePath(location.prefix, name), Buffer.from(await data.arrayBuffer()), {
        upsert: true,
        contentType: inferMimeType(name),
        cacheControl: "2592000",
      });
    assertStorageSuccess(uploadError, `Failed to restore ${name}`);
  }
  return params.snapshot.fileNames.length;
}

export async function restoreAdminChangeVersion(params: {
  id: string;
  tgUserId: number;
  itemsDir: string;
}): Promise<{ kind: AdminChangeVersionKind; safetyVersion: AdminChangeVersionSummary; files?: number }> {
  const supabase = createServiceSupabaseClient();
  const { data: version, error } = await supabase
    .from("admin_change_versions")
    .select("id,kind,city_slug,label,snapshot,created_at")
    .eq("id", params.id)
    .maybeSingle();
  if (error) throw new HttpError(500, "DB", `Failed to load restore point: ${error.message}`);
  if (!version) throw new HttpError(404, "NOT_FOUND", "Restore point not found");

  const sourceDate = new Date(version.created_at).toLocaleString("ru-RU", { timeZone: "Asia/Vladivostok" });
  if (version.kind === "products") {
    const parsed = productSnapshotSchema.safeParse(version.snapshot);
    if (!parsed.success) throw new HttpError(409, "CONFLICT", "Restore point has invalid product data");
    const safetyVersion = await createProductsRestorePoint({
      tgUserId: params.tgUserId,
      citySlug: version.city_slug,
      label: `Перед восстановлением версии от ${sourceDate}`,
    });
    await restoreProductsSnapshot(parsed.data);
    return { kind: "products", safetyVersion };
  }

  const parsed = imageSnapshotSchema.safeParse(version.snapshot);
  if (!parsed.success) throw new HttpError(409, "CONFLICT", "Restore point has invalid image data");
  const safetyVersion = await createImagesRestorePoint({
    tgUserId: params.tgUserId,
    itemsDir: params.itemsDir,
    label: `Перед восстановлением версии от ${sourceDate}`,
  });
  const files = await restoreImagesSnapshot({
    revisionId: version.id,
    snapshot: parsed.data,
    itemsDir: params.itemsDir,
  });
  return { kind: "images", safetyVersion, files };
}
