import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import {
  isCancellationLockedByDeliveryWindow,
  type DeliveryCitySlug,
} from "./deliverySchedule.js";
import type { OrderStatus } from "./telegramMessage.js";

type CustomerOrderRow = {
  id: string;
  status: string;
  city_id: number | null;
  total_price: unknown;
  total_after_discount: unknown;
  created_at: string;
  delivery_method: string;
  comment: string | null;
};

type CustomerOrderItemRow = {
  order_id: string;
  product_id: string | null;
  qty: number;
  unit_price: unknown;
};

type CityRow = {
  id: number;
  name: string;
  slug: string;
};

type ProductRow = {
  id: string;
  title: string;
};

export type CustomerOrderSummary = {
  id: string;
  status: OrderStatus;
  cityLabel: string;
  totalPrice: number;
  createdAt: string;
  deliveryMethod: string;
  comment: string | null;
  canCancel: boolean;
  cancelDisabledReason: "done" | "cancelled" | "deadline" | null;
  items: Array<{
    title: string;
    qty: number;
    unitPrice: number;
  }>;
};

function parseOrderStatus(value: unknown): OrderStatus {
  if (value === "new" || value === "processing" || value === "done" || value === "cancelled") {
    return value;
  }
  return "new";
}

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

export async function listCustomerOrders(tgUserId: number): Promise<CustomerOrderSummary[]> {
  const supabase = createServiceSupabaseClient();

  const { data: orders, error: ordersError } = await supabase
    .from("orders")
    .select("id,status,city_id,total_price,total_after_discount,created_at,delivery_method,comment")
    .eq("tg_user_id", tgUserId)
    .in("status", ["new", "processing"])
    .order("created_at", { ascending: false })
    .limit(30);

  if (ordersError) {
    throw new HttpError(500, "DB", `Failed to load customer orders: ${ordersError.message}`);
  }

  const orderRows = (orders ?? []) as CustomerOrderRow[];
  const cityIds = Array.from(
    new Set(orderRows.map((row) => row.city_id).filter((id): id is number => typeof id === "number")),
  );

  const cityLabelById = new Map<number, string>();
  const cityById = new Map<number, CityRow>();
  if (cityIds.length > 0) {
    const { data: cities, error: citiesError } = await supabase
      .from("cities")
      .select("id,name,slug")
      .in("id", cityIds);

    if (citiesError) {
      throw new HttpError(500, "DB", `Failed to load cities for customer orders: ${citiesError.message}`);
    }

    for (const city of (cities ?? []) as CityRow[]) {
      cityById.set(city.id, city);
      cityLabelById.set(city.id, `${city.name} (${city.slug.toUpperCase()})`);
    }
  }

  const orderIds = orderRows.map((row) => row.id);
  const itemsByOrderId = new Map<string, CustomerOrderSummary["items"]>();

  if (orderIds.length > 0) {
    const { data: orderItems, error: orderItemsError } = await supabase
      .from("order_items")
      .select("order_id,product_id,qty,unit_price")
      .in("order_id", orderIds);

    if (orderItemsError) {
      throw new HttpError(500, "DB", `Failed to load order items: ${orderItemsError.message}`);
    }

    const itemRows = (orderItems ?? []) as CustomerOrderItemRow[];
    const productIds = Array.from(
      new Set(itemRows.map((row) => row.product_id).filter((id): id is string => typeof id === "string")),
    );

    const titleById = new Map<string, string>();
    if (productIds.length > 0) {
      const { data: products, error: productsError } = await supabase
        .from("products")
        .select("id,title")
        .in("id", productIds);

      if (productsError) {
        throw new HttpError(500, "DB", `Failed to load products for customer orders: ${productsError.message}`);
      }

      for (const product of (products ?? []) as ProductRow[]) {
        titleById.set(product.id, product.title);
      }
    }

    for (const row of itemRows) {
      const current = itemsByOrderId.get(row.order_id) ?? [];
      current.push({
        title: row.product_id ? titleById.get(row.product_id) ?? "Unknown" : "Unknown",
        qty: row.qty,
        unitPrice: numberFromUnknown(row.unit_price, "order_items.unit_price"),
      });
      itemsByOrderId.set(row.order_id, current);
    }
  }

  return orderRows.map((row) => {
    const status = parseOrderStatus(row.status);

    let orderCitySlug: DeliveryCitySlug | null = null;
    if (row.city_id !== null) {
      const cityRow = cityById.get(row.city_id);
      if (cityRow && (cityRow.slug === "vvo" || cityRow.slug === "blg")) {
        orderCitySlug = cityRow.slug;
      }
    }

    const cancellationLocked = isCancellationLockedByDeliveryWindow({
      citySlug: orderCitySlug,
      comment: row.comment,
    });
    const canCancel =
      status !== "done" && status !== "cancelled" && cancellationLocked !== true;
    const cancelDisabledReason =
      status === "done"
        ? "done"
        : status === "cancelled"
          ? "cancelled"
          : cancellationLocked
            ? "deadline"
            : null;

    return {
      id: row.id,
      status,
      cityLabel:
        row.city_id !== null
          ? cityLabelById.get(row.city_id) ?? "Неизвестный город"
          : "Без города",
      totalPrice: numberFromUnknown(
        row.total_after_discount ?? row.total_price,
        "orders.total_after_discount",
      ),
      createdAt: row.created_at,
      deliveryMethod: row.delivery_method,
      comment: row.comment,
      canCancel,
      cancelDisabledReason,
      items: itemsByOrderId.get(row.id) ?? [],
    };
  });
}
