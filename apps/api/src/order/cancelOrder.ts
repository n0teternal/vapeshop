import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import {
  isCancellationLockedByDeliveryWindow,
  type DeliveryCitySlug,
} from "./deliverySchedule.js";
import type { OrderStatus } from "./telegramMessage.js";

type OrderRow = {
  id: string;
  status: string;
  city_id: number | null;
  tg_user_id: number;
  comment: string | null;
};

type OrderItemRow = {
  product_id: string | null;
  qty: number;
};

type InventoryRow = {
  product_id: string;
  city_id: number;
  in_stock: boolean;
  stock_qty: number | null;
};

type RestoredInventory = {
  productId: string;
  previousStockQty: number;
  previousInStock: boolean;
  restoredQty: number;
};

type CityRow = {
  slug: string;
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

async function rollbackRestoredInventory(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  cityId: number;
  restorations: RestoredInventory[];
}): Promise<void> {
  for (let i = params.restorations.length - 1; i >= 0; i -= 1) {
    const row = params.restorations[i];
    if (!row) continue;
    const expectedQtyAfterRestore = row.previousStockQty + row.restoredQty;

    try {
      await params.supabase
        .from("inventory")
        .update({
          stock_qty: row.previousStockQty,
          in_stock: row.previousInStock,
        })
        .eq("city_id", params.cityId)
        .eq("product_id", row.productId)
        .eq("stock_qty", expectedQtyAfterRestore);
    } catch {
      // Best-effort rollback; original error is more important.
    }
  }
}

async function restoreOrderInventory(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  orderId: string;
  cityId: number;
}): Promise<RestoredInventory[]> {
  const { data: orderItems, error: orderItemsError } = await params.supabase
    .from("order_items")
    .select("product_id,qty")
    .eq("order_id", params.orderId);

  if (orderItemsError) {
    throw new HttpError(500, "DB", `Failed to load order items for cancellation: ${orderItemsError.message}`);
  }

  const qtyByProductId = new Map<string, number>();
  for (const row of (orderItems ?? []) as OrderItemRow[]) {
    if (typeof row.product_id !== "string") continue;
    if (!isPositiveInt(row.qty)) continue;
    qtyByProductId.set(row.product_id, (qtyByProductId.get(row.product_id) ?? 0) + row.qty);
  }

  const productIds = Array.from(qtyByProductId.keys());
  if (productIds.length === 0) return [];

  const { data: inventoryRows, error: inventoryError } = await params.supabase
    .from("inventory")
    .select("product_id,city_id,in_stock,stock_qty")
    .eq("city_id", params.cityId)
    .in("product_id", productIds);

  if (inventoryError) {
    throw new HttpError(500, "DB", `Failed to load inventory for cancellation: ${inventoryError.message}`);
  }

  const inventoryByProductId = new Map<string, InventoryRow>();
  for (const row of (inventoryRows ?? []) as InventoryRow[]) {
    inventoryByProductId.set(row.product_id, row);
  }

  const restorations: RestoredInventory[] = [];

  for (const [productId, qty] of qtyByProductId.entries()) {
    const inventoryRow = inventoryByProductId.get(productId);
    if (!inventoryRow) {
      throw new HttpError(
        409,
        "INVENTORY_MISSING",
        `Inventory row missing for cancelled order item: ${productId}`,
      );
    }
    if (inventoryRow.stock_qty === null) {
      continue;
    }

    const nextStockQty = inventoryRow.stock_qty + qty;
    const nextInStock = nextStockQty > 0;

    const { data: updatedInventory, error: updateInventoryError } = await params.supabase
      .from("inventory")
      .update({
        stock_qty: nextStockQty,
        in_stock: nextInStock,
      })
      .eq("city_id", params.cityId)
      .eq("product_id", productId)
      .eq("stock_qty", inventoryRow.stock_qty)
      .eq("in_stock", inventoryRow.in_stock)
      .select("product_id")
      .maybeSingle();

    if (updateInventoryError || !updatedInventory) {
      await rollbackRestoredInventory({
        supabase: params.supabase,
        cityId: params.cityId,
        restorations,
      });
      throw new HttpError(409, "INVENTORY_CONFLICT", `Failed to restore stock for product: ${productId}`);
    }

    restorations.push({
      productId,
      previousStockQty: inventoryRow.stock_qty,
      previousInStock: inventoryRow.in_stock,
      restoredQty: qty,
    });

    inventoryRow.stock_qty = nextStockQty;
    inventoryRow.in_stock = nextInStock;
  }

  return restorations;
}

export async function cancelOrderAndRestoreInventory(params: {
  orderId: string;
  expectedTgUserId?: number;
}): Promise<{
  changed: boolean;
  status: OrderStatus;
}> {
  const supabase = createServiceSupabaseClient();

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id,status,city_id,tg_user_id,comment")
    .eq("id", params.orderId)
    .maybeSingle();

  if (orderError) {
    throw new HttpError(500, "DB", `Failed to load order for cancellation: ${orderError.message}`);
  }
  if (!order) {
    throw new HttpError(404, "NOT_FOUND", "Order not found");
  }
  if (
    typeof params.expectedTgUserId === "number" &&
    (order as OrderRow).tg_user_id !== params.expectedTgUserId
  ) {
    throw new HttpError(404, "NOT_FOUND", "Order not found");
  }

  const rawStatus = typeof (order as OrderRow).status === "string" ? (order as OrderRow).status : null;
  const currentStatus = parseOrderStatus(rawStatus);
  if (currentStatus === "cancelled") {
    return { changed: false, status: currentStatus };
  }
  if (currentStatus === "done") {
    throw new HttpError(409, "ORDER_FINAL", "Completed order cannot be cancelled");
  }

  const cityId = (order as OrderRow).city_id;
  let citySlug: DeliveryCitySlug | null = null;
  if (typeof cityId === "number") {
    const { data: city, error: cityError } = await supabase
      .from("cities")
      .select("slug")
      .eq("id", cityId)
      .maybeSingle();

    if (cityError) {
      throw new HttpError(
        500,
        "DB",
        `Failed to load city for order cancellation: ${cityError.message}`,
      );
    }

    if (city && (((city as CityRow).slug === "vvo") || (city as CityRow).slug === "blg")) {
      citySlug = (city as CityRow).slug as DeliveryCitySlug;
    }
  }

  if (
    isCancellationLockedByDeliveryWindow({
      citySlug,
      comment: (order as OrderRow).comment,
    })
  ) {
    throw new HttpError(
      409,
      "ORDER_CANCELLATION_LOCKED",
      "Заказ нельзя отменить менее чем за час до начала выбранного интервала доставки.",
    );
  }

  let restorations: RestoredInventory[] = [];
  if (typeof cityId === "number") {
    restorations = await restoreOrderInventory({
      supabase,
      orderId: params.orderId,
      cityId,
    });
  }

  let updateQuery = supabase.from("orders").update({ status: "cancelled" }).eq("id", params.orderId);
  updateQuery = rawStatus === null ? updateQuery.is("status", null) : updateQuery.eq("status", rawStatus);

  const { data: updatedOrder, error: updateOrderError } = await updateQuery
    .select("status")
    .maybeSingle();

  if (updateOrderError || !updatedOrder) {
    if (typeof cityId === "number" && restorations.length > 0) {
      await rollbackRestoredInventory({
        supabase,
        cityId,
        restorations,
      });
    }

    const { data: freshOrder, error: freshOrderError } = await supabase
      .from("orders")
      .select("status")
      .eq("id", params.orderId)
      .maybeSingle();

    if (!freshOrderError && freshOrder) {
      const freshStatus = parseOrderStatus((freshOrder as Pick<OrderRow, "status">).status);
      if (freshStatus === "cancelled") {
        return { changed: false, status: "cancelled" };
      }
    }

    throw new HttpError(409, "ORDER_CONFLICT", "Failed to mark order as cancelled");
  }

  return { changed: true, status: "cancelled" };
}
