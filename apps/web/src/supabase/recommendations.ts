import { apiGet } from "../api/client";
import type { CitySlug } from "./catalog";

export type RecommendationSource = "personal" | "popular";

export type ProductRecommendation = {
  productId: string;
  source: RecommendationSource;
};

export type ProductRecommendations = {
  items: ProductRecommendation[];
  personalized: boolean;
};

export function fetchProductRecommendations(citySlug: CitySlug): Promise<ProductRecommendations> {
  const query = new URLSearchParams({ citySlug });
  return apiGet<ProductRecommendations>(`/api/recommendations?${query.toString()}`);
}
