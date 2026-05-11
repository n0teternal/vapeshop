import { ApiError, apiGet } from "../api/client";

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
  promoOldPrice?: number | null;
  promoNewPrice?: number | null;
};

export type PromoCatalogItem = CatalogItem & {
  oldPrice: number;
  newPrice: number;
  sortOrder: number;
};

export type CatalogData = {
  items: CatalogItem[];
  promoItems: PromoCatalogItem[];
};

type CatalogApiResponse = {
  citySlug: CitySlug;
  items: CatalogItem[];
  promoItems?: PromoCatalogItem[];
};

export async function fetchCatalog(citySlug: CitySlug): Promise<CatalogData> {
  try {
    const data = await apiGet<CatalogApiResponse>(
      `/api/catalog?citySlug=${encodeURIComponent(citySlug)}`,
      { withTelegramAuth: false },
    );
    return {
      items: data.items,
      promoItems: data.promoItems ?? [],
    };
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      throw new SupabaseQueryError({
        table: "inventory",
        status: error.status,
        code: error.code,
        message: error.message,
      });
    }

    throw error;
  }
}
