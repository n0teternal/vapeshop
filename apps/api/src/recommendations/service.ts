import type { CatalogCitySlug } from "../catalog/getCatalog.js";
import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";

const MIN_COMPLETED_ORDERS_FOR_PERSONALIZATION = 5;
const PERSONAL_RANKING_WEIGHT = 0.6;
const POPULARITY_RANKING_WEIGHT = 0.4;

export type ProductRecommendation = {
  productId: string;
};

export type ProductRecommendations = {
  items: ProductRecommendation[];
  personalized: boolean;
};

type RecommendationSignal = {
  product_id: string;
  popularity_qty: unknown;
  personal_product_qty: unknown;
  personal_category_qty: unknown;
  personal_last_bought_at: string | null;
};

type RankedCandidate = {
  productId: string;
  popularityQty: number;
  personalScore: number;
};

function nonNegativeInteger(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function getPersonalRecencyBoost(lastBoughtAt: string | null): number {
  if (!lastBoughtAt) return 0;
  const timestamp = Date.parse(lastBoughtAt);
  if (!Number.isFinite(timestamp)) return 0;

  const ageInDays = Math.max(0, (Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  // Recent purchases should break ties, but quantity and category preference
  // remain more important than a single accidental recent purchase.
  return Math.max(0, 14 - Math.floor(ageInDays / 14));
}

async function hasEnoughCompletedOrders(customerId: number): Promise<boolean> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("orders")
    .select("id")
    .eq("tg_user_id", customerId)
    .eq("status", "done")
    .limit(MIN_COMPLETED_ORDERS_FOR_PERSONALIZATION);

  if (error) {
    throw new HttpError(500, "DB", `Failed to count completed customer orders: ${error.message}`);
  }

  return (data?.length ?? 0) >= MIN_COMPLETED_ORDERS_FOR_PERSONALIZATION;
}

/**
 * Ranks the whole catalogue instead of injecting a small special shelf. Before
 * five successful orders, sales popularity drives the order. Afterwards each
 * product gets a blended score: 60% personal affinity and 40% store-wide
 * popularity. Products with no signal remain in their normal catalogue order
 * on the client, rather than being arbitrarily shuffled by a UUID tie-breaker.
 */
export async function getProductRecommendations(params: {
  citySlug: CatalogCitySlug;
  customerId: number | null;
}): Promise<ProductRecommendations> {
  const supabase = createServiceSupabaseClient();
  const [signalsResult, enoughHistory] = await Promise.all([
    supabase.rpc("get_product_recommendation_signals", {
      p_city_slug: params.citySlug,
      p_tg_user_id: params.customerId,
    }),
    params.customerId === null ? Promise.resolve(false) : hasEnoughCompletedOrders(params.customerId),
  ]);

  if (signalsResult.error) {
    throw new HttpError(
      500,
      "DB",
      `Failed to load product recommendation signals: ${signalsResult.error.message}`,
    );
  }

  const signalsByProductId = new Map<string, RecommendationSignal>();
  for (const signal of (signalsResult.data ?? []) as RecommendationSignal[]) {
    if (typeof signal.product_id === "string") {
      signalsByProductId.set(signal.product_id, signal);
    }
  }

  const candidates = Array.from(signalsByProductId.values()).map<RankedCandidate>((signal) => {
    const popularityQty = nonNegativeInteger(signal.popularity_qty);
    const personalProductQty = nonNegativeInteger(signal.personal_product_qty);
    const personalCategoryQty = nonNegativeInteger(signal.personal_category_qty);
    const recencyBoost = getPersonalRecencyBoost(signal.personal_last_bought_at);

    return {
      productId: signal.product_id,
      popularityQty,
      // Exact re-purchases are strongest; category affinity brings relevant
      // alternatives into the set instead of showing only the same SKUs.
      personalScore: personalProductQty * 100 + personalCategoryQty * 5 + recencyBoost,
    };
  });

  const maxPopularity = Math.max(0, ...candidates.map((candidate) => candidate.popularityQty));
  const maxPersonalScore = Math.max(0, ...candidates.map((candidate) => candidate.personalScore));
  const personalized = enoughHistory && maxPersonalScore > 0;
  const ranked = candidates
    .map((candidate) => {
      // log1p prevents one historically dominant SKU from flattening all
      // other useful signals while retaining the relative order of sales.
      const popularityScore =
        maxPopularity > 0 ? Math.log1p(candidate.popularityQty) / Math.log1p(maxPopularity) : 0;
      const personalScore =
        personalized && maxPersonalScore > 0
          ? Math.log1p(candidate.personalScore) / Math.log1p(maxPersonalScore)
          : 0;
      const score = personalized
        ? personalScore * PERSONAL_RANKING_WEIGHT + popularityScore * POPULARITY_RANKING_WEIGHT
        : popularityScore;

      return { ...candidate, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.personalScore - left.personalScore ||
        right.popularityQty - left.popularityQty ||
        left.productId.localeCompare(right.productId),
    );

  return {
    items: ranked.map((candidate) => ({ productId: candidate.productId })),
    personalized,
  };
}
