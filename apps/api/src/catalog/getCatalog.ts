import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";

export type CatalogCitySlug = "vvo" | "blg";

export type CatalogItem = {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  categorySlug: string;
  price: number;
  regularPrice: number;
  inStock: boolean;
  stockQty: number | null;
  promoOldPrice?: number | null;
  promoNewPrice?: number | null;
};

export type PromoCatalogItem = CatalogItem & {
  oldPrice: number;
  newPrice: number;
  sortOrder: number;
};

export type CatalogByCityResult = {
  items: CatalogItem[];
  promoItems: PromoCatalogItem[];
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

type PromoRow = {
  product_id: string;
  old_price: unknown;
  new_price: unknown;
  sort_order: number | null;
};

function numberFromUnknown(value: unknown, fieldName: string): number {
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

function stockQtyFromUnknown(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const quantity = numberFromUnknown(value, "inventory.stock_qty");
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new HttpError(500, "DB", "Invalid numeric field inventory.stock_qty");
  }
  return quantity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingPromoProductsTableError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return (
    code === "PGRST205" ||
    (message.includes("promo_products") && message.includes("schema cache")) ||
    (message.includes("relation") && message.includes("promo_products"))
  );
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

export async function fetchCatalogByCity(params: {
  citySlug: CatalogCitySlug;
  includePromos?: boolean;
}): Promise<CatalogByCityResult> {
  const includePromos = params.includePromos === true;
  const supabase = createServiceSupabaseClient();
  const { data: city, error: cityError } = await supabase
    .from("cities")
    .select("id,slug")
    .eq("slug", params.citySlug)
    .maybeSingle();

  if (cityError) {
    throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
  }
  if (!city) {
    throw new HttpError(400, "CITY_NOT_FOUND", "City not found");
  }

  const [{ data, error }, { data: promoRows, error: promoError }] = await Promise.all([
    supabase
      .from("inventory")
      .select(
        "in_stock,stock_qty,price_override,products!inner(id,title,description,base_price,image_url,category_slug,is_active),cities!inner(slug)",
      )
      .eq("cities.slug", params.citySlug)
      .eq("products.is_active", true),
    includePromos
      ? supabase
          .from("promo_products")
          .select("product_id,old_price,new_price,sort_order")
          .eq("city_id", city.id)
          .eq("is_active", true)
          .order("sort_order", { ascending: true })
          .order("id", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (error) {
    throw new HttpError(500, "DB", `Failed to load catalog: ${error.message}`);
  }
  if (promoError && !isMissingPromoProductsTableError(promoError)) {
    throw new HttpError(500, "DB", `Failed to load promo products: ${promoError.message}`);
  }

  const rows: unknown[] = data ?? [];
  const items: CatalogItem[] = [];
  const itemById = new Map<string, CatalogItem>();

  for (const row of rows) {
    if (!isRecord(row)) continue;

    const product = parseJoinedProduct(row.products);
    if (!product || !product.is_active) continue;

    const basePrice = numberFromUnknown(product.base_price, "products.base_price");
    const overrideRaw = row.price_override;
    const overridePrice =
      overrideRaw === null || overrideRaw === undefined
        ? null
        : numberFromUnknown(overrideRaw, "inventory.price_override");

    const item: CatalogItem = {
      id: product.id,
      title: product.title,
      description: product.description,
      imageUrl: product.image_url,
      categorySlug: product.category_slug,
      price: overridePrice ?? basePrice,
      regularPrice: overridePrice ?? basePrice,
      inStock: row.in_stock === true,
      stockQty: stockQtyFromUnknown(row.stock_qty),
    };
    items.push(item);
    itemById.set(item.id, item);
  }

  const promoItems: PromoCatalogItem[] = [];
  for (const promo of (promoError ? [] : (promoRows ?? [])) as PromoRow[]) {
    const item = itemById.get(promo.product_id);
    if (!item || !item.inStock) continue;

    const oldPrice = numberFromUnknown(promo.old_price, "promo_products.old_price");
    const newPrice = numberFromUnknown(promo.new_price, "promo_products.new_price");
    if (newPrice <= 0 || oldPrice <= newPrice) continue;

    item.price = newPrice;
    item.promoOldPrice = oldPrice;
    item.promoNewPrice = newPrice;

    promoItems.push({
      ...item,
      price: newPrice,
      oldPrice,
      newPrice,
      sortOrder: typeof promo.sort_order === "number" ? promo.sort_order : 0,
    });
  }

  return { items, promoItems };
}
