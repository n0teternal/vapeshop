import { HttpError } from "../httpError.js";
import { getMaxPointsDiscountForTotal } from "../referral/service.js";
import {
  calculatePromotionDiscount,
  loadActivePromotionRules,
} from "../promotions/rules.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import {
  calculateDeliveryFeeRub,
  loadDeliveryPricingSettings,
} from "../delivery/pricing.js";
import {
  isCancellationLockedByDeliveryWindow,
  type DeliveryCitySlug,
} from "./deliverySchedule.js";
import {
  areDiscountsAllowedForDeliveryMethod,
  isDeliveryAddressMethod,
  isOrderDeliveryMethod,
  type OrderDeliveryMethod,
} from "./deliveryMethod.js";
import type { CitySlug, CreateOrderPayload } from "./createOrder.js";
import { buildOrderComment, parseOrderComment } from "./orderComment.js";

const ORDER_EDIT_WINDOW_MS = 30 * 60 * 1_000;
const ORDER_POINTS_SPEND_KIND = "order_points_spend";

type OrderStatus = "new" | "processing" | "done" | "cancelled";

type OrderRow = {
  id: string;
  status: string;
  city_id: number | null;
  tg_user_id: number;
  delivery_method: string;
  comment: string | null;
  discount_amount: unknown;
  edit_session_expires_at: string | null;
};

type CityRow = {
  id: number;
  slug: string;
  name: string;
};

type OrderItemRow = {
  id: number;
  product_id: string | null;
  qty: number;
  unit_price: unknown;
};

type ProductRow = {
  id: string;
  title: string;
  image_url: string | null;
  category_slug: string;
  base_price: unknown;
  is_active: boolean;
};

type InventoryRow = {
  product_id: string;
  city_id: number;
  in_stock: boolean;
  stock_qty: number | null;
  price_override: unknown;
};

type PromoPriceRow = {
  product_id: string;
  new_price: unknown;
};

type RestorableInventoryUpdate = {
  productId: string;
  previousStockQty: number;
  previousInStock: boolean;
  nextStockQty: number;
  nextInStock: boolean;
};

type PointsSpendRow = {
  id: number;
  tg_user_id: number;
  delta_points: number;
  kind: string;
  order_id: string | null;
  created_at: string;
};

export type OrderEditCartItem = {
  productId: string;
  title: string;
  categorySlug: string | null;
  price: number;
  regularPrice: number;
  qty: number;
  imageUrl: string | null;
};

export type OrderEditCheckoutDraft = {
  phone: string;
  deliveryMethod: OrderDeliveryMethod;
  address: string;
  comment: string;
  deliveryDate: string;
  deliveryTimeSlot: string;
};

export type StartOrderEditSessionResult = {
  orderId: string;
  city: CitySlug;
  expiresAt: string;
  discountAmount: number;
  cart: OrderEditCartItem[];
  checkoutDraft: OrderEditCheckoutDraft;
};

function parseOrderStatus(value: unknown): OrderStatus {
  if (value === "new" || value === "processing" || value === "done" || value === "cancelled") {
    return value;
  }
  return "new";
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function numberFromUnknown(value: unknown, fieldName: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    throw new HttpError(500, "DB", `Invalid numeric field ${fieldName}`);
  }

  return parsed;
}

function isMissingPromoProductsTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; message?: unknown };
  const code = typeof maybeError.code === "string" ? maybeError.code : "";
  const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
  return (
    code === "PGRST205" ||
    (message.includes("promo_products") && message.includes("schema cache")) ||
    (message.includes("relation") && message.includes("promo_products"))
  );
}

function normalizeItems(items: CreateOrderPayload["items"]): Map<string, number> {
  const byId = new Map<string, number>();

  for (const item of items) {
    if (!isUuid(item.productId)) {
      throw new HttpError(400, "BAD_REQUEST", `Invalid productId: ${item.productId}`);
    }
    if (!Number.isInteger(item.qty) || item.qty <= 0 || item.qty > 99) {
      throw new HttpError(400, "BAD_REQUEST", "qty must be in range 1..99");
    }
    byId.set(item.productId, (byId.get(item.productId) ?? 0) + item.qty);
  }

  return byId;
}

async function loadOrder(params: {
  orderId: string;
  expectedTgUserId?: number;
}): Promise<OrderRow> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id,status,city_id,tg_user_id,delivery_method,comment,discount_amount,edit_session_expires_at",
    )
    .eq("id", params.orderId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "DB", `Failed to load order: ${error.message}`);
  }
  if (!data) {
    throw new HttpError(404, "NOT_FOUND", "Order not found");
  }

  const order = data as OrderRow;
  if (
    typeof params.expectedTgUserId === "number" &&
    order.tg_user_id !== params.expectedTgUserId
  ) {
    throw new HttpError(404, "NOT_FOUND", "Order not found");
  }

  const status = parseOrderStatus(order.status);
  if (status === "done" || status === "cancelled") {
    throw new HttpError(409, "ORDER_FINAL", "Order can no longer be edited");
  }

  return order;
}

async function loadOrderCity(cityId: number | null): Promise<CityRow & { citySlug: CitySlug }> {
  if (typeof cityId !== "number") {
    throw new HttpError(409, "ORDER_CITY_MISSING", "Order city is missing");
  }

  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("cities")
    .select("id,name,slug")
    .eq("id", cityId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "DB", `Failed to load order city: ${error.message}`);
  }
  if (!data || (data.slug !== "vvo" && data.slug !== "blg")) {
    throw new HttpError(409, "ORDER_CITY_INVALID", "Unsupported order city");
  }

  return {
    ...(data as CityRow),
    citySlug: data.slug,
  };
}

async function loadOrderItems(orderId: string): Promise<OrderItemRow[]> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("order_items")
    .select("id,product_id,qty,unit_price")
    .eq("order_id", orderId);

  if (error) {
    throw new HttpError(500, "DB", `Failed to load order items: ${error.message}`);
  }

  return (data ?? []) as OrderItemRow[];
}

async function loadProductsById(productIds: string[]): Promise<Map<string, ProductRow>> {
  if (productIds.length === 0) return new Map<string, ProductRow>();

  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("products")
    .select("id,title,image_url,category_slug,base_price,is_active")
    .in("id", productIds);

  if (error) {
    throw new HttpError(500, "DB", `Failed to load products: ${error.message}`);
  }

  return new Map<string, ProductRow>(((data ?? []) as ProductRow[]).map((row) => [row.id, row]));
}

async function loadInventoryByProductId(params: {
  cityId: number;
  productIds: string[];
}): Promise<Map<string, InventoryRow>> {
  if (params.productIds.length === 0) return new Map<string, InventoryRow>();

  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("inventory")
    .select("product_id,city_id,in_stock,stock_qty,price_override")
    .eq("city_id", params.cityId)
    .in("product_id", params.productIds);

  if (error) {
    throw new HttpError(500, "DB", `Failed to load inventory: ${error.message}`);
  }

  return new Map<string, InventoryRow>(
    ((data ?? []) as InventoryRow[]).map((row) => [row.product_id, row]),
  );
}

async function loadActivePromoPricesByProductId(params: {
  cityId: number;
  productIds: string[];
}): Promise<Map<string, number>> {
  if (params.productIds.length === 0) return new Map<string, number>();

  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("promo_products")
    .select("product_id,new_price")
    .eq("city_id", params.cityId)
    .eq("is_active", true)
    .in("product_id", params.productIds);

  if (error) {
    if (isMissingPromoProductsTableError(error)) return new Map<string, number>();
    throw new HttpError(500, "DB", `Failed to load promo prices: ${error.message}`);
  }

  const prices = new Map<string, number>();
  for (const row of (data ?? []) as PromoPriceRow[]) {
    const price = numberFromUnknown(row.new_price, "promo_products.new_price");
    if (price > 0) {
      prices.set(row.product_id, price);
    }
  }

  return prices;
}

async function rollbackInventoryUpdates(params: {
  cityId: number;
  updates: RestorableInventoryUpdate[];
}): Promise<void> {
  const supabase = createServiceSupabaseClient();

  for (let index = params.updates.length - 1; index >= 0; index -= 1) {
    const update = params.updates[index];
    if (!update) continue;

    try {
      await supabase
        .from("inventory")
        .update({
          stock_qty: update.previousStockQty,
          in_stock: update.previousInStock,
        })
        .eq("city_id", params.cityId)
        .eq("product_id", update.productId)
        .eq("stock_qty", update.nextStockQty)
        .eq("in_stock", update.nextInStock);
    } catch {
      // Best-effort rollback.
    }
  }
}

async function restoreOrderItems(params: {
  orderId: string;
  previousRows: OrderItemRow[];
}): Promise<void> {
  const supabase = createServiceSupabaseClient();

  try {
    await supabase.from("order_items").delete().eq("order_id", params.orderId);
    if (params.previousRows.length === 0) return;

    await supabase.from("order_items").insert(
      params.previousRows.map((row) => ({
        order_id: params.orderId,
        product_id: row.product_id,
        qty: row.qty,
        unit_price: numberFromUnknown(row.unit_price, "order_items.unit_price"),
      })),
    );
  } catch {
    // Best-effort rollback.
  }
}

async function syncOrderPointsSpend(params: {
  tgUserId: number;
  orderId: string;
  nextPointsToSpend: number;
}): Promise<() => Promise<void>> {
  const supabase = createServiceSupabaseClient();
  const nextPointsToSpend = Math.max(0, Math.trunc(params.nextPointsToSpend));
  const { data, error } = await supabase
    .from("loyalty_transactions")
    .select("id,tg_user_id,delta_points,kind,order_id,created_at")
    .eq("tg_user_id", params.tgUserId)
    .eq("kind", ORDER_POINTS_SPEND_KIND)
    .eq("order_id", params.orderId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "DB", `Failed to load order points transaction: ${error.message}`);
  }

  const previousRow = (data ?? null) as PointsSpendRow | null;
  const previousPointsToSpend = previousRow ? Math.max(0, -previousRow.delta_points) : 0;
  if (previousPointsToSpend === nextPointsToSpend) {
    return async () => {};
  }

  if (previousRow) {
    if (nextPointsToSpend <= 0) {
      const { error: deleteError } = await supabase
        .from("loyalty_transactions")
        .delete()
        .eq("id", previousRow.id);

      if (deleteError) {
        throw new HttpError(500, "DB", `Failed to delete order points transaction: ${deleteError.message}`);
      }

      return async () => {
        await supabase.from("loyalty_transactions").insert({
          tg_user_id: previousRow.tg_user_id,
          delta_points: previousRow.delta_points,
          kind: previousRow.kind,
          order_id: previousRow.order_id,
          created_at: previousRow.created_at,
        });
      };
    }

    const { error: updateError } = await supabase
      .from("loyalty_transactions")
      .update({ delta_points: -nextPointsToSpend })
      .eq("id", previousRow.id);

    if (updateError) {
      throw new HttpError(500, "DB", `Failed to update order points transaction: ${updateError.message}`);
    }

    return async () => {
      await supabase
        .from("loyalty_transactions")
        .update({ delta_points: previousRow.delta_points })
        .eq("id", previousRow.id);
    };
  }

  if (nextPointsToSpend <= 0) {
    return async () => {};
  }

  const { data: insertedRow, error: insertError } = await supabase
    .from("loyalty_transactions")
    .insert({
      tg_user_id: params.tgUserId,
      delta_points: -nextPointsToSpend,
      kind: ORDER_POINTS_SPEND_KIND,
      order_id: params.orderId,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertError || !insertedRow) {
    throw new HttpError(500, "DB", `Failed to create order points transaction: ${insertError?.message ?? "empty response"}`);
  }

  return async () => {
    await supabase.from("loyalty_transactions").delete().eq("id", insertedRow.id);
  };
}

function ensureOrderEditableByWindow(params: {
  citySlug: DeliveryCitySlug | null;
  comment: string | null;
}): void {
  if (
    isCancellationLockedByDeliveryWindow({
      citySlug: params.citySlug,
      comment: params.comment,
    })
  ) {
    throw new HttpError(
      409,
      "ORDER_EDIT_LOCKED",
      "Заказ нельзя редактировать менее чем за час до начала выбранного интервала доставки.",
    );
  }
}

export async function startOrderEditSession(params: {
  orderId: string;
  expectedTgUserId?: number;
  allowPromoPrices?: boolean;
}): Promise<StartOrderEditSessionResult> {
  const supabase = createServiceSupabaseClient();
  const order = await loadOrder(params);
  const city = await loadOrderCity(order.city_id);
  ensureOrderEditableByWindow({
    citySlug: city.citySlug,
    comment: order.comment,
  });

  const expiresAt = new Date(Date.now() + ORDER_EDIT_WINDOW_MS).toISOString();
  const { error: updateError } = await supabase
    .from("orders")
    .update({ edit_session_expires_at: expiresAt })
    .eq("id", order.id);

  if (updateError) {
    throw new HttpError(500, "DB", `Failed to start order edit session: ${updateError.message}`);
  }

  const orderItems = await loadOrderItems(order.id);
  const productIds = Array.from(
    new Set(
      orderItems
        .map((row) => row.product_id)
        .filter((productId): productId is string => typeof productId === "string"),
    ),
  );
  const deliveryMethod = isOrderDeliveryMethod(order.delivery_method)
    ? order.delivery_method
    : "pickup";
  const discountsAllowed = areDiscountsAllowedForDeliveryMethod(deliveryMethod);
  const [productsById, inventoryByProductId, promoPriceByProductId] = await Promise.all([
    loadProductsById(productIds),
    loadInventoryByProductId({ cityId: city.id, productIds }),
    params.allowPromoPrices === true && discountsAllowed
      ? loadActivePromoPricesByProductId({ cityId: city.id, productIds })
      : Promise.resolve(new Map<string, number>()),
  ]);

  const cart = orderItems
    .filter((row): row is OrderItemRow & { product_id: string } => typeof row.product_id === "string")
    .map((row) => {
      const product = productsById.get(row.product_id);
      const inventory = inventoryByProductId.get(row.product_id);
      const regularPrice =
        inventory?.price_override === null || inventory?.price_override === undefined
          ? product
            ? numberFromUnknown(product.base_price, "products.base_price")
            : numberFromUnknown(row.unit_price, "order_items.unit_price")
          : numberFromUnknown(inventory.price_override, "inventory.price_override");
      const price =
        promoPriceByProductId.get(row.product_id) ??
        regularPrice;

      return {
        productId: row.product_id,
        title: product?.title ?? "Unknown",
        categorySlug: product?.category_slug ?? null,
        price,
        regularPrice,
        qty: row.qty,
        imageUrl: product?.image_url ?? null,
      };
    });

  const parsedComment = parseOrderComment(order.comment);
  return {
    orderId: order.id,
    city: city.citySlug,
    expiresAt,
    discountAmount:
      !discountsAllowed || order.discount_amount === null || order.discount_amount === undefined
        ? 0
        : Math.max(0, Math.trunc(numberFromUnknown(order.discount_amount, "orders.discount_amount"))),
    cart,
    checkoutDraft: {
      phone: parsedComment.phone ?? "",
      deliveryMethod,
      address: parsedComment.address ?? "",
      comment: parsedComment.comment ?? "",
      deliveryDate: parsedComment.deliveryDate ?? "",
      deliveryTimeSlot: parsedComment.deliveryTimeSlot ?? "",
    },
  };
}

export async function stopOrderEditSession(params: {
  orderId: string;
  expectedTgUserId?: number;
}): Promise<void> {
  const supabase = createServiceSupabaseClient();
  await loadOrder(params);

  const { error } = await supabase
    .from("orders")
    .update({ edit_session_expires_at: null })
    .eq("id", params.orderId);

  if (error) {
    throw new HttpError(500, "DB", `Failed to stop order edit session: ${error.message}`);
  }
}

export async function applyOrderEdit(params: {
  orderId: string;
  expectedTgUserId?: number;
  payload: CreateOrderPayload;
  allowPromoPrices?: boolean;
}): Promise<{ orderId: string }> {
  const supabase = createServiceSupabaseClient();
  const order = await loadOrder({
    orderId: params.orderId,
    ...(typeof params.expectedTgUserId === "number"
      ? { expectedTgUserId: params.expectedTgUserId }
      : {}),
  });
  const city = await loadOrderCity(order.city_id);

  if (params.payload.citySlug !== city.citySlug) {
    throw new HttpError(409, "ORDER_CITY_MISMATCH", "Edited order must stay in the same city");
  }
  const discountsAllowed = areDiscountsAllowedForDeliveryMethod(
    params.payload.deliveryMethod,
  );

  const sessionExpiresAtMs =
    typeof order.edit_session_expires_at === "string"
      ? new Date(order.edit_session_expires_at).getTime()
      : Number.NaN;
  if (!Number.isFinite(sessionExpiresAtMs) || sessionExpiresAtMs <= Date.now()) {
    throw new HttpError(
      409,
      "ORDER_EDIT_SESSION_EXPIRED",
      "Режим редактирования истёк. Запустите его заново.",
    );
  }

  const requested = normalizeItems(params.payload.items);
  const previousOrderItems = await loadOrderItems(order.id);
  const currentQtyByProductId = new Map<string, number>();
  const currentUnitPriceByProductId = new Map<string, number>();

  for (const row of previousOrderItems) {
    if (typeof row.product_id !== "string" || !isPositiveInt(row.qty)) continue;
    currentQtyByProductId.set(
      row.product_id,
      (currentQtyByProductId.get(row.product_id) ?? 0) + row.qty,
    );
    currentUnitPriceByProductId.set(
      row.product_id,
      numberFromUnknown(row.unit_price, "order_items.unit_price"),
    );
  }

  const productIds = Array.from(
    new Set([...currentQtyByProductId.keys(), ...requested.keys()]),
  );
  const [productsById, inventoryByProductId, promoPriceByProductId] = await Promise.all([
    loadProductsById(productIds),
    loadInventoryByProductId({ cityId: city.id, productIds }),
    params.allowPromoPrices === true && discountsAllowed
      ? loadActivePromoPricesByProductId({ cityId: city.id, productIds })
      : Promise.resolve(new Map<string, number>()),
  ]);

  const lines: Array<{
    productId: string;
    title: string;
    categorySlug: string;
    qty: number;
    unitPrice: number;
  }> = [];
  let itemsSubtotal = 0;

  for (const [productId, requestedQty] of requested.entries()) {
    const currentQty = currentQtyByProductId.get(productId) ?? 0;
    const product = productsById.get(productId);
    const inventory = inventoryByProductId.get(productId);

    if (!product) {
      throw new HttpError(400, "NOT_FOUND", `Product not found: ${productId}`);
    }

    const additionalQtyNeeded = Math.max(0, requestedQty - currentQty);
    if (additionalQtyNeeded > 0) {
      if (!inventory || !inventory.in_stock) {
        throw new HttpError(400, "OUT_OF_STOCK", `Out of stock: ${product.title}`);
      }
      if (inventory.stock_qty !== null && inventory.stock_qty < additionalQtyNeeded) {
        throw new HttpError(400, "OUT_OF_STOCK", `Insufficient stock: ${product.title}`);
      }
      if (!product.is_active) {
        throw new HttpError(400, "NOT_ACTIVE", `Product is disabled: ${product.title}`);
      }
    }

    if (!product.is_active && requestedQty > currentQty) {
      throw new HttpError(400, "NOT_ACTIVE", `Product is disabled: ${product.title}`);
    }

    const unitPrice =
      !product.is_active && requestedQty <= currentQty
        ? currentUnitPriceByProductId.get(productId) ??
          numberFromUnknown(product.base_price, "products.base_price")
        : promoPriceByProductId.get(productId) ??
          (inventory?.price_override === null || inventory?.price_override === undefined
            ? numberFromUnknown(product.base_price, "products.base_price")
            : numberFromUnknown(inventory.price_override, "inventory.price_override"));

    lines.push({
      productId,
      title: product.title,
      categorySlug: product.category_slug,
      qty: requestedQty,
      unitPrice,
    });
    itemsSubtotal += unitPrice * requestedQty;
  }

  const promotionDiscountAmount = discountsAllowed
    ? calculatePromotionDiscount({
        rules: await loadActivePromotionRules({ supabase, cityId: city.id }),
        lines,
      }).discountAmount
    : 0;
  const deliveryPricingSettings = await loadDeliveryPricingSettings({
    supabase,
    citySlug: params.payload.citySlug,
  });
  if (
    params.payload.citySlug === "blg" &&
    isDeliveryAddressMethod(params.payload.deliveryMethod) &&
    deliveryPricingSettings.rules.length > 0 &&
    !params.payload.deliveryLocation
  ) {
    throw new HttpError(
      400,
      "DELIVERY_DISTANCE_REQUIRED",
      "Нажмите поиск рядом с адресом, чтобы посчитать расстояние и доставку.",
    );
  }
  const deliveryFee = calculateDeliveryFeeRub({
    citySlug: params.payload.citySlug,
    deliveryMethod: params.payload.deliveryMethod,
    itemsSubtotalRub: itemsSubtotal,
    distanceKm: params.payload.deliveryLocation?.distanceKm ?? null,
    deliveryTimeSlot: params.payload.deliveryTimeSlot,
    settings: deliveryPricingSettings,
  });
  const totalBeforeDiscount = itemsSubtotal + deliveryFee;
  const totalAfterPromotionDiscount = Math.max(
    0,
    totalBeforeDiscount - promotionDiscountAmount,
  );

  const previousDiscountAmount =
    order.discount_amount === null || order.discount_amount === undefined
      ? 0
      : Math.max(0, Math.trunc(numberFromUnknown(order.discount_amount, "orders.discount_amount")));
  const nextDiscountAmount = discountsAllowed
    ? Math.min(
        previousDiscountAmount,
        getMaxPointsDiscountForTotal(totalAfterPromotionDiscount),
      )
    : 0;
  const totalAfterDiscount = Math.max(0, totalAfterPromotionDiscount - nextDiscountAmount);

  const inventoryUpdates: RestorableInventoryUpdate[] = [];
  for (const productId of productIds) {
    const currentQty = currentQtyByProductId.get(productId) ?? 0;
    const requestedQty = requested.get(productId) ?? 0;
    const delta = requestedQty - currentQty;
    if (delta === 0) continue;

    const inventory = inventoryByProductId.get(productId);
    if (!inventory) {
      throw new HttpError(409, "INVENTORY_MISSING", `Inventory row missing for product: ${productId}`);
    }
    if (inventory.stock_qty === null) continue;

    const nextStockQty = inventory.stock_qty - delta;
    if (delta > 0 && nextStockQty < 0) {
      const product = productsById.get(productId);
      throw new HttpError(
        400,
        "OUT_OF_STOCK",
        `Insufficient stock: ${product?.title ?? productId}`,
      );
    }
    const nextInStock = nextStockQty > 0;

    const { data: updatedInventory, error: updateInventoryError } = await supabase
      .from("inventory")
      .update({
        stock_qty: nextStockQty,
        in_stock: nextInStock,
      })
      .eq("city_id", city.id)
      .eq("product_id", productId)
      .eq("stock_qty", inventory.stock_qty)
      .eq("in_stock", inventory.in_stock)
      .select("product_id")
      .maybeSingle();

    if (updateInventoryError || !updatedInventory) {
      await rollbackInventoryUpdates({
        cityId: city.id,
        updates: inventoryUpdates,
      });
      throw new HttpError(409, "INVENTORY_CONFLICT", `Failed to update stock for product: ${productId}`);
    }

    inventoryUpdates.push({
      productId,
      previousStockQty: inventory.stock_qty,
      previousInStock: inventory.in_stock,
      nextStockQty,
      nextInStock,
    });

    inventory.stock_qty = nextStockQty;
    inventory.in_stock = nextInStock;
  }

  let rollbackPointsSpend = async () => {};
  try {
    rollbackPointsSpend = await syncOrderPointsSpend({
      tgUserId: order.tg_user_id,
      orderId: order.id,
      nextPointsToSpend: nextDiscountAmount,
    });
  } catch (error) {
    await rollbackInventoryUpdates({
      cityId: city.id,
      updates: inventoryUpdates,
    });
    throw error;
  }

  const { error: deleteOrderItemsError } = await supabase
    .from("order_items")
    .delete()
    .eq("order_id", order.id);

  if (deleteOrderItemsError) {
    await rollbackPointsSpend();
    await rollbackInventoryUpdates({
      cityId: city.id,
      updates: inventoryUpdates,
    });
    throw new HttpError(500, "DB", `Failed to replace order items: ${deleteOrderItemsError.message}`);
  }

  const nextOrderItems = lines.map((line) => ({
    order_id: order.id,
    product_id: line.productId,
    qty: line.qty,
    unit_price: line.unitPrice,
  }));
  if (nextOrderItems.length > 0) {
    const { error: insertOrderItemsError } = await supabase
      .from("order_items")
      .insert(nextOrderItems);

    if (insertOrderItemsError) {
      await restoreOrderItems({
        orderId: order.id,
        previousRows: previousOrderItems,
      });
      await rollbackPointsSpend();
      await rollbackInventoryUpdates({
        cityId: city.id,
        updates: inventoryUpdates,
      });
      throw new HttpError(500, "DB", `Failed to save edited order items: ${insertOrderItemsError.message}`);
    }
  }

  const orderComment = buildOrderComment(params.payload);
  const nowIso = new Date().toISOString();
  const { error: updateOrderError } = await supabase
    .from("orders")
    .update({
      delivery_method: params.payload.deliveryMethod,
      comment: orderComment,
      status: "new",
      total_price: totalAfterDiscount,
      total_before_discount: totalBeforeDiscount,
      promotion_discount_amount: promotionDiscountAmount,
      ...(discountsAllowed ? {} : { coupon_id: null, coupon_discount_amount: 0 }),
      discount_amount: nextDiscountAmount,
      total_after_discount: totalAfterDiscount,
      edited_at: nowIso,
      edit_session_expires_at: null,
    })
    .eq("id", order.id);

  if (updateOrderError) {
    await restoreOrderItems({
      orderId: order.id,
      previousRows: previousOrderItems,
    });
    await rollbackPointsSpend();
    await rollbackInventoryUpdates({
      cityId: city.id,
      updates: inventoryUpdates,
    });
    throw new HttpError(500, "DB", `Failed to update order after edit: ${updateOrderError.message}`);
  }

  return { orderId: order.id };
}
