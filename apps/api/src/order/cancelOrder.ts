import { HttpError } from "../httpError.js";
import { releasePromoCodeUsage } from "../promoCodes/service.js";
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
  coupon_id: string | null;
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

export async function cancelOrderAndRestoreInventory(params: {
  orderId: string;
  expectedTgUserId?: number;
  allowLockedCancellation?: boolean;
}): Promise<{
  changed: boolean;
  status: OrderStatus;
}> {
  const supabase = createServiceSupabaseClient();

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id,status,city_id,tg_user_id,comment,coupon_id")
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
    params.allowLockedCancellation !== true &&
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

  const { data: changed, error: cancellationError } = await supabase.rpc(
    "cancel_order_and_restore_inventory",
    { p_order_id: params.orderId },
  );
  if (cancellationError) {
    const message = cancellationError.message ?? "Failed to cancel order";
    if (cancellationError.code === "P0002" || message.includes("ORDER_NOT_FOUND")) {
      throw new HttpError(404, "NOT_FOUND", "Order not found");
    }
    if (message.includes("ORDER_FINAL")) {
      throw new HttpError(409, "ORDER_FINAL", "Completed order cannot be cancelled");
    }
    if (message.includes("ORDER_EDIT_IN_PROGRESS")) {
      throw new HttpError(409, "ORDER_EDIT_IN_PROGRESS", "Order is being edited, try again in a moment");
    }
    if (message.includes("INVENTORY_MISSING")) {
      throw new HttpError(409, "INVENTORY_MISSING", "Inventory row is missing for this order");
    }
    throw new HttpError(409, "ORDER_CONFLICT", `Failed to cancel order: ${message}`);
  }
  if (typeof changed !== "boolean") {
    throw new HttpError(500, "DB", "Order cancellation returned an invalid result");
  }

  if (changed) await releasePromoCodeUsage((order as OrderRow).coupon_id);
  return { changed, status: "cancelled" };
}
