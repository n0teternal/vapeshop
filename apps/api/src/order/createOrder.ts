import { HttpError } from "../httpError.js";
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
      throw new HttpError(400, "BAD_REQUEST", `Неверный productId: ${item.productId}`);
    }
    if (!Number.isInteger(item.qty) || item.qty <= 0 || item.qty > 99) {
      throw new HttpError(400, "BAD_REQUEST", "qty должен быть в диапазоне 1..99");
    }
    byId.set(item.productId, (byId.get(item.productId) ?? 0) + item.qty);
  }

  return byId;
}

export async function createOrder(params: {
  payload: CreateOrderPayload;
  tgUser: TgUser;
}): Promise<CreateOrderResult> {
  const supabase = createServiceSupabaseClient();
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
    throw new HttpError(400, "CITY_NOT_FOUND", "Город не найден");
  }

  const { data: inventoryRows, error: invError } = await supabase
    .from("inventory")
    .select("product_id,in_stock,price_override")
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

  type InventoryRow = {
    product_id: string;
    in_stock: boolean;
    price_override: unknown;
  };
  type ProductRow = {
    id: string;
    title: string;
    base_price: unknown;
    is_active: boolean;
  };

  function isInventoryRow(value: unknown): value is InventoryRow {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as InventoryRow).product_id === "string" &&
      typeof (value as InventoryRow).in_stock === "boolean"
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

  const inventoryList = ((inventoryRows ?? []) as unknown[]).filter(isInventoryRow);
  const productList = ((productRows ?? []) as unknown[]).filter(isProductRow);

  const inventoryByProductId = new Map<string, InventoryRow>(
    inventoryList.map((r) => [r.product_id, r]),
  );
  const productById = new Map<string, ProductRow>(productList.map((p) => [p.id, p]));

  const lines: OrderLine[] = [];
  let totalPrice = 0;

  for (const [productId, qty] of requested.entries()) {
    const inv = inventoryByProductId.get(productId);
    if (!inv) {
      throw new HttpError(
        400,
        "NOT_AVAILABLE",
        `Товар недоступен в выбранном городе: ${productId}`,
      );
    }

    const product = productById.get(productId);
    if (!product) {
      throw new HttpError(400, "NOT_FOUND", `Товар не найден: ${productId}`);
    }
    if (!product.is_active) {
      throw new HttpError(400, "NOT_ACTIVE", `Товар отключён: ${product.title}`);
    }
    if (!inv.in_stock) {
      throw new HttpError(400, "OUT_OF_STOCK", `Нет в наличии: ${product.title}`);
    }

    const basePrice = numberFromUnknown(product.base_price);
    const overridePrice =
      inv.price_override === null || inv.price_override === undefined
        ? null
        : numberFromUnknown(inv.price_override);
    const unitPrice = overridePrice ?? basePrice;

    lines.push({ productId, title: product.title, qty, unitPrice });
    totalPrice += unitPrice * qty;
  }

  const orderRow = {
    tg_user_id: params.tgUser.id,
    tg_username: params.tgUser.username ?? null,
    city_id: city.id ?? null,
    delivery_method: params.payload.deliveryMethod,
    comment: params.payload.comment ?? null,
    total_price: totalPrice,
    // статус не отправляем — пусть БД проставит default
  };

  const { data: createdOrder, error: orderError } = await supabase
    .from("orders")
    .insert(orderRow)
    .select("id")
    .single();

  if (orderError) {
    throw new HttpError(500, "DB", `Failed to create order: ${orderError.message}`);
  }
  if (!createdOrder) {
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
    throw new HttpError(500, "DB", `Failed to create order items: ${orderItemsError.message}`);
  }

  return {
    orderId: createdOrder.id,
    totalPrice,
    lines,
    telegramMessage: buildOrderTelegramMessage({
      status: "new",
      cityName: city.name,
      citySlug: params.payload.citySlug,
      tgUser: params.tgUser,
      deliveryMethod: params.payload.deliveryMethod,
      comment: params.payload.comment,
      lines,
      totalPrice,
      orderId: createdOrder.id,
    }),
  };
}
