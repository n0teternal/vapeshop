import { supabase } from "./client";

export type CitySlug = "vvo" | "blg";

export type SupabaseTableName = "cities" | "inventory" | "products";

export class SupabaseQueryError extends Error {
  public readonly table: SupabaseTableName;
  public readonly status: number | null;
  public readonly code: string | null;

  constructor(params: {
    table: SupabaseTableName;
    status: number | null;
    code: string | null;
    message: string;
  }) {
    super(params.message);
    this.name = "SupabaseQueryError";
    this.table = params.table;
    this.status = params.status;
    this.code = params.code;
  }
}

export type CatalogItem = {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  categorySlug: string;
  price: number;
  inStock: boolean;
};

type JoinedProduct = {
  id: string;
  title: string;
  description: string | null;
  base_price: unknown;
  image_url: string | null;
  category_slug: string;
  is_active: boolean;
};

function numberFromUnknown(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value: ${String(value)}`);
  }
  return n;
}

function getErrorCode(error: { code?: unknown } | null): string | null {
  if (!error) return null;
  return typeof error.code === "string" ? error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJoinedProduct(value: unknown): JoinedProduct | null {
  const raw = Array.isArray(value) ? (value[0] ?? null) : value;
  if (!isRecord(raw)) return null;

  const id = raw.id;
  const title = raw.title;
  const isActive = raw.is_active;

  if (typeof id !== "string" || typeof title !== "string" || typeof isActive !== "boolean") {
    return null;
  }

  const description = typeof raw.description === "string" ? raw.description : null;
  const imageUrl = typeof raw.image_url === "string" ? raw.image_url : null;
  const categorySlug =
    typeof raw.category_slug === "string" && raw.category_slug.trim().length > 0
      ? raw.category_slug
      : "other";

  return {
    id,
    title,
    description,
    base_price: raw.base_price,
    image_url: imageUrl,
    category_slug: categorySlug,
    is_active: isActive,
  };
}

export async function fetchCatalog(citySlug: CitySlug): Promise<CatalogItem[]> {
  if (!supabase) {
    throw new Error("Supabase is not configured (missing env)");
  }

  const { data, error, status } = await supabase
    .from("inventory")
    .select(
      "in_stock,price_override,products!inner(id,title,description,base_price,image_url,category_slug,is_active),cities!inner(slug)",
    )
    .eq("cities.slug", citySlug)
    .eq("products.is_active", true);

  if (error) {
    throw new SupabaseQueryError({
      table: "inventory",
      status: typeof status === "number" ? status : null,
      code: getErrorCode(error),
      message: error.message,
    });
  }

  const rows: unknown[] = data ?? [];
  const items: CatalogItem[] = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;

    const product = parseJoinedProduct(row.products);
    if (!product || !product.is_active) continue;

    const basePrice = numberFromUnknown(product.base_price);
    const overrideRaw = row.price_override;
    const overridePrice =
      overrideRaw === null || overrideRaw === undefined
        ? null
        : numberFromUnknown(overrideRaw);

    items.push({
      id: product.id,
      title: product.title,
      description: product.description,
      imageUrl: product.image_url,
      categorySlug: product.category_slug,
      price: overridePrice ?? basePrice,
      inStock: row.in_stock === true,
    });
  }

  return items;
}
