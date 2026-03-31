import { HttpError } from "../httpError.js";
import { spendPointsForOrder } from "../referral/service.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import {
  buildOrderTelegramMessage,
  type TelegramOrderMessage,
} from "./telegramMessage.js";

export type CitySlug = "vvo" | "blg";

export type CreateOrderPayload = {
  citySlug: CitySlug;
  deliveryMethod: string;
  comment: string | null;
  pointsToSpend: number;
  items: Array<{ productId: string; qty: number }>;
};

type TgUser = { id: number; username: string | null };

type OrderLine = {
  productId: string;
  title: string;
  qty: number;
  unitPrice: number;
};

type CreateOrderResult = {
  orderId: string;
  totalPrice: number;
  lines: OrderLine[];
  telegramMessage: TelegramOrderMessage;
};

type InventoryRow = {
  product_id: string;
  in_stock: boolean;
  stock_qty: number | null;
  price_override: unknown;
};

type ProductRow = {
  id: string;
  title: string;
  base_price: unknown;
  is_active: boolean;
};

type ReservedInventory = {
  productId: string;
  previousStockQty: number;
  previousInStock: boolean;
  reservedQty: number;
};

function normalizeTelegramUsername(username: string | null): string | null {
  if (!username) return null;
  const normalized = username.trim().replace(/^@+/, "");
  return normalized.length > 0 ? normalized : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function numberFromUnknown(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(n)) {
    throw new HttpError(500, "DB", `Invalid numeric value: ${String(value)}`);
  }
  return n;
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

function isInventoryRow(value: unknown): value is InventoryRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as InventoryRow;

  const stockQtyValid =
    row.stock_qty === null ||
    (typeof row.stock_qty === "number" &&
      Number.isFinite(row.stock_qty) &&
      Number.isInteger(row.stock_qty) &&
      row.stock_qty >= 0);

  return (
    typeof row.product_id === "string" &&
    typeof row.in_stock === "boolean" &&
    stockQtyValid
  );
}

function isProductRow(value: unknown): value is ProductRow {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProductRow).id === "string" &&
    typeof (value as ProductRow).title === "string" &&
    typeof (value as ProductRow).is_active === "boolean"
  );
}

async function rollbackReservedInventory(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  cityId: number;
  reservations: ReservedInventory[];
}): Promise<void> {
  for (let i = params.reservations.length - 1; i >= 0; i -= 1) {
    const row = params.reservations[i];
    if (!row) continue;
    const expectedQtyAfterReserve = row.previousStockQty - row.reservedQty;

    try {
      // Revert only when the row still has the reserved value from this flow.
      await params.supabase
        .from("inventory")
        .update({
          stock_qty: row.previousStockQty,
          in_stock: row.previousInStock,
        })
        .eq("city_id", params.cityId)
        .eq("product_id", row.productId)
        .eq("stock_qty", expectedQtyAfterReserve);
    } catch {
      // Best-effort rollback; keep original error context.
    }
  }
}

async function resolveOrderTgUser(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  tgUser: TgUser;
}): Promise<TgUser> {
  const immediateUsername = normalizeTelegramUsername(params.tgUser.username);
  if (immediateUsername) {
    return { id: params.tgUser.id, username: immediateUsername };
  }

  const { data, error } = await params.supabase
    .from("customer_profiles")
    .select("tg_username")
    .eq("tg_user_id", params.tgUser.id)
    .maybeSingle();

  if (error) {
    throw new HttpError(
      500,
      "DB",
      `Failed to load customer profile for order username fallback: ${error.message}`,
    );
  }

  const profileUsername =
    data && typeof data.tg_username === "string" ? data.tg_username : null;

  return {
    id: params.tgUser.id,
    username: normalizeTelegramUsername(profileUsername),
  };
}

export async function createOrder(params: {
  payload: CreateOrderPayload;
  tgUser: TgUser;
}): Promise<CreateOrderResult> {
  const supabase = createServiceSupabaseClient();
  const effectiveTgUser = await resolveOrderTgUser({
    supabase,
    tgUser: params.tgUser,
  });
  const requested = normalizeItems(params.payload.items);
  const productIds = Array.from(requested.keys());

  const { data: city, error: cityError } = await supabase
    .from("cities")
    .select("id,name,slug")
    .eq("slug", params.payload.citySlug)
    .single();

  if (cityError) {
    throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
  }
  if (!city) {
    throw new HttpError(400, "CITY_NOT_FOUND", "City not found");
  }

  const { data: inventoryRows, error: invError } = await supabase
    .from("inventory")
    .select("product_id,in_stock,stock_qty,price_override")
    .eq("city_id", city.id)
    .in("product_id", productIds);

  if (invError) {
    throw new HttpError(500, "DB", `Failed to load inventory: ${invError.message}`);
  }

  const { data: productRows, error: prodError } = await supabase
    .from("products")
    .select("id,title,base_price,is_active")
    .in("id", productIds);

  if (prodError) {
    throw new HttpError(500, "DB", `Failed to load products: ${prodError.message}`);
  }

  const inventoryList = ((inventoryRows ?? []) as unknown[]).filter(isInventoryRow);
  const productList = ((productRows ?? []) as unknown[]).filter(isProductRow);

  const inventoryByProductId = new Map<string, InventoryRow>(
    inventoryList.map((r) => [r.product_id, r]),
  );
  const productById = new Map<string, ProductRow>(productList.map((p) => [p.id, p]));

  const lines: OrderLine[] = [];
  let totalBeforeDiscount = 0;

  for (const [productId, qty] of requested.entries()) {
    const inv = inventoryByProductId.get(productId);
    if (!inv) {
      throw new HttpError(
        400,
        "NOT_AVAILABLE",
        `Product is unavailable in selected city: ${productId}`,
      );
    }

    const product = productById.get(productId);
    if (!product) {
      throw new HttpError(400, "NOT_FOUND", `Product not found: ${productId}`);
    }
    if (!product.is_active) {
      throw new HttpError(400, "NOT_ACTIVE", `Product is disabled: ${product.title}`);
    }
    if (!inv.in_stock) {
      throw new HttpError(400, "OUT_OF_STOCK", `Out of stock: ${product.title}`);
    }
    if (inv.stock_qty !== null && inv.stock_qty < qty) {
      throw new HttpError(400, "OUT_OF_STOCK", `Insufficient stock: ${product.title}`);
    }

    const basePrice = numberFromUnknown(product.base_price);
    const overridePrice =
      inv.price_override === null || inv.price_override === undefined
        ? null
        : numberFromUnknown(inv.price_override);
    const unitPrice = overridePrice ?? basePrice;

    lines.push({ productId, title: product.title, qty, unitPrice });
    totalBeforeDiscount += unitPrice * qty;
  }

  const requestedPointsToSpend = Math.max(0, Math.trunc(params.payload.pointsToSpend));
  const maxPointsByOrderTotal = Math.max(0, Math.floor(totalBeforeDiscount));
  const discountAmount = Math.min(requestedPointsToSpend, maxPointsByOrderTotal);
  const totalAfterDiscount = Math.max(0, totalBeforeDiscount - discountAmount);

  const reservations: ReservedInventory[] = [];

  for (const line of lines) {
    const inv = inventoryByProductId.get(line.productId);
    if (!inv || inv.stock_qty === null) continue;

    const nextStockQty = inv.stock_qty - line.qty;
    const nextInStock = nextStockQty > 0;

    const { data: reservedRow, error: reserveError } = await supabase
      .from("inventory")
      .update({
        stock_qty: nextStockQty,
        in_stock: nextInStock,
      })
      .eq("city_id", city.id)
      .eq("product_id", line.productId)
      .eq("in_stock", true)
      .eq("stock_qty", inv.stock_qty)
      .select("product_id")
      .maybeSingle();

    if (reserveError || !reservedRow) {
      await rollbackReservedInventory({
        supabase,
        cityId: city.id,
        reservations,
      });
      throw new HttpError(400, "OUT_OF_STOCK", `Insufficient stock: ${line.title}`);
    }

    reservations.push({
      productId: line.productId,
      previousStockQty: inv.stock_qty,
      previousInStock: inv.in_stock,
      reservedQty: line.qty,
    });

    inv.stock_qty = nextStockQty;
    inv.in_stock = nextInStock;
  }

  const orderRow = {
    tg_user_id: effectiveTgUser.id,
    tg_username: effectiveTgUser.username,
    city_id: city.id ?? null,
    delivery_method: params.payload.deliveryMethod,
    comment: params.payload.comment ?? null,
    total_price: totalAfterDiscount,
    total_before_discount: totalBeforeDiscount,
    discount_amount: discountAmount,
    total_after_discount: totalAfterDiscount,
    // Let DB assign default status.
  };

  const { data: createdOrder, error: orderError } = await supabase
    .from("orders")
    .insert(orderRow)
    .select("id")
    .single();

  if (orderError) {
    await rollbackReservedInventory({
      supabase,
      cityId: city.id,
      reservations,
    });
    throw new HttpError(500, "DB", `Failed to create order: ${orderError.message}`);
  }
  if (!createdOrder) {
    await rollbackReservedInventory({
      supabase,
      cityId: city.id,
      reservations,
    });
    throw new HttpError(500, "DB", "Failed to create order (empty response)");
  }

  const orderItemsRows = lines.map((l) => ({
    order_id: createdOrder.id,
    product_id: l.productId,
    qty: l.qty,
    unit_price: l.unitPrice,
  }));

  const { error: orderItemsError } = await supabase.from("order_items").insert(orderItemsRows);

  if (orderItemsError) {
    // Best-effort cleanup to avoid dangling order without items.
    await supabase.from("orders").delete().eq("id", createdOrder.id);
    await rollbackReservedInventory({
      supabase,
      cityId: city.id,
      reservations,
    });
    throw new HttpError(500, "DB", `Failed to create order items: ${orderItemsError.message}`);
  }

  if (discountAmount > 0) {
    try {
      await spendPointsForOrder({
        tgUserId: params.tgUser.id,
        orderId: createdOrder.id,
        pointsToSpend: discountAmount,
      });
    } catch (e) {
      await supabase.from("orders").delete().eq("id", createdOrder.id);
      await rollbackReservedInventory({
        supabase,
        cityId: city.id,
        reservations,
      });
      throw e;
    }
  }

  return {
    orderId: createdOrder.id,
    totalPrice: totalAfterDiscount,
    lines,
    telegramMessage: buildOrderTelegramMessage({
      status: "new",
      cityName: city.name,
      citySlug: params.payload.citySlug,
      tgUser: effectiveTgUser,
      deliveryMethod: params.payload.deliveryMethod,
      comment: params.payload.comment,
      lines,
      totalPrice: totalAfterDiscount,
      discountApplied: discountAmount > 0,
      orderId: createdOrder.id,
    }),
  };
}
