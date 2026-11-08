import type { CatalogCitySlug } from "../catalog/getCatalog.js";
import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";

const MIN_COMPLETED_ORDERS_FOR_PERSONALIZATION = 5;
const RECOMMENDATION_LIMIT = 5;
const PERSONAL_RECOMMENDATION_SHARE = 0.6;

export type RecommendationSource = "personal" | "popular";

export type ProductRecommendation = {
  productId: string;
  source: RecommendationSource;
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

function interleaveCandidates(params: {
  personal: RankedCandidate[];
  popular: RankedCandidate[];
}): ProductRecommendation[] {
  const result: ProductRecommendation[] = [];
  let personalIndex = 0;
  let popularIndex = 0;

  while (personalIndex < params.personal.length || popularIndex < params.popular.length) {
    const hasPersonal = personalIndex < params.personal.length;
    const hasPopular = popularIndex < params.popular.length;
    const shouldUsePersonal =
      hasPersonal &&
      (!hasPopular ||
        personalIndex / params.personal.length <= popularIndex / params.popular.length);

    if (shouldUsePersonal) {
      const candidate = params.personal[personalIndex];
      personalIndex += 1;
      if (candidate) result.push({ productId: candidate.productId, source: "personal" });
      continue;
    }

    const candidate = params.popular[popularIndex];
    popularIndex += 1;
    if (candidate) result.push({ productId: candidate.productId, source: "popular" });
  }

  return result;
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
 * Keeps the catalogue useful before enough individual history exists. At the
 * fifth successful order and later, 60% of a five-card shelf comes from the
 * customer's product/category preferences and 40% remains popularity-driven.
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

  const popular = [...candidates].sort(
    (left, right) =>
      right.popularityQty - left.popularityQty ||
      left.productId.localeCompare(right.productId),
  );

  if (!enoughHistory) {
    return {
      items: popular.slice(0, RECOMMENDATION_LIMIT).map((candidate) => ({
        productId: candidate.productId,
        source: "popular",
      })),
      personalized: false,
    };
  }

  const personalTarget = Math.round(RECOMMENDATION_LIMIT * PERSONAL_RECOMMENDATION_SHARE);
  const personal = candidates
    .filter((candidate) => candidate.personalScore > 0)
    .sort(
      (left, right) =>
        right.personalScore - left.personalScore ||
        right.popularityQty - left.popularityQty ||
        left.productId.localeCompare(right.productId),
    )
    .slice(0, personalTarget);
  const personalIds = new Set(personal.map((candidate) => candidate.productId));
  const popularTarget = RECOMMENDATION_LIMIT - personal.length;
  const popularRemainder = popular
    .filter((candidate) => !personalIds.has(candidate.productId))
    .slice(0, popularTarget);

  // When a customer's preferred categories no longer have enough sellable
  // products, fill the shelf with more genuinely popular choices.
  return {
    items: interleaveCandidates({ personal, popular: popularRemainder }),
    personalized: personal.length > 0,
  };
}
