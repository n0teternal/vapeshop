import { supabase, type Database } from "./client";

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
  price: number;
  inStock: boolean;
};

type CityRow = Database["public"]["Tables"]["cities"]["Row"];
type InventoryRow = Pick<
  Database["public"]["Tables"]["inventory"]["Row"],
  "product_id" | "in_stock" | "price_override"
>;
type ProductRow = Pick<
  Database["public"]["Tables"]["products"]["Row"],
  "id" | "title" | "description" | "base_price" | "image_url" | "is_active"
>;

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

async function fetchCity(citySlug: CitySlug): Promise<CityRow> {
  if (!supabase) {
    throw new Error("Supabase is not configured (missing env)");
  }

  const { data, error, status } = await supabase
    .from("cities")
    .select("id,name,slug")
    .eq("slug", citySlug)
    .single();

  if (error) {
    throw new SupabaseQueryError({
      table: "cities",
      status: typeof status === "number" ? status : null,
      code: getErrorCode(error),
      message: error.message,
    });
  }
  if (!data) {
    throw new Error("City not found");
  }
  return data;
}

export async function fetchCatalog(citySlug: CitySlug): Promise<CatalogItem[]> {
  if (!supabase) {
    throw new Error("Supabase is not configured (missing env)");
  }

  const city = await fetchCity(citySlug);

  const { data: inventory, error: inventoryError, status: inventoryStatus } = await supabase
    .from("inventory")
    .select("product_id,in_stock,price_override")
    .eq("city_id", city.id);

  if (inventoryError) {
    throw new SupabaseQueryError({
      table: "inventory",
      status: typeof inventoryStatus === "number" ? inventoryStatus : null,
      code: getErrorCode(inventoryError),
      message: inventoryError.message,
    });
  }

  const invRows: InventoryRow[] = inventory ?? [];
  const productIds = Array.from(new Set(invRows.map((row) => row.product_id)));
  if (productIds.length === 0) return [];

  const { data: products, error: productsError, status: productsStatus } = await supabase
    .from("products")
    .select("id,title,description,base_price,image_url,is_active")
    .in("id", productIds)
    .eq("is_active", true);

  if (productsError) {
    throw new SupabaseQueryError({
      table: "products",
      status: typeof productsStatus === "number" ? productsStatus : null,
      code: getErrorCode(productsError),
      message: productsError.message,
    });
  }

  const prodRows: ProductRow[] = (products ?? []).filter((p) => p.is_active === true);
  const byId = new Map<string, ProductRow>(prodRows.map((p) => [p.id, p]));

  const items: CatalogItem[] = [];
  for (const inv of invRows) {
    const p = byId.get(inv.product_id);
    if (!p) continue;

    const basePrice = numberFromUnknown(p.base_price);
    const overridePrice =
      inv.price_override === null ? null : numberFromUnknown(inv.price_override);

    items.push({
      id: p.id,
      title: p.title,
      description: p.description,
      imageUrl: p.image_url,
      price: overridePrice ?? basePrice,
      inStock: inv.in_stock,
    });
  }

  return items;
}
