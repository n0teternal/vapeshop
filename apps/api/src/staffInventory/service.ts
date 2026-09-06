import { HttpError } from "../httpError.js";
import type { OrderPaymentMethod } from "../order/telegramMessage.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import * as XLSX from "xlsx";

export type StaffMember = {
  id: number;
  name: string;
  isActive: boolean;
};

export type StaffInventoryLine = {
  productId: string;
  title: string;
  qty: number;
};

export type IssuableInventoryProduct = {
  productId: string;
  title: string;
  availableQty: number | null;
};

type StockLine = {
  productId: string;
  qty: number;
};

type ReservedStaffInventory = {
  productId: string;
  previousQty: number;
  nextQty: number;
};

function normalizeStockLines(lines: Array<{ productId: string; qty: number }>): StockLine[] {
  const qtyByProductId = new Map<string, number>();

  for (const line of lines) {
    if (!Number.isInteger(line.qty) || line.qty <= 0) continue;
    qtyByProductId.set(line.productId, (qtyByProductId.get(line.productId) ?? 0) + line.qty);
  }

  return Array.from(qtyByProductId, ([productId, qty]) => ({ productId, qty }));
}

async function restoreStaffInventory(params: {
  staffId: number;
  cityId: number;
  rows: ReservedStaffInventory[];
}): Promise<void> {
  const supabase = createServiceSupabaseClient();

  await Promise.all(
    params.rows.map(async (row) => {
      await supabase
        .from("staff_inventory")
        .update({ stock_qty: row.previousQty })
        .eq("staff_id", params.staffId)
        .eq("city_id", params.cityId)
        .eq("product_id", row.productId)
        .eq("stock_qty", row.nextQty);
    }),
  );
}

export async function listStaffMembers(): Promise<StaffMember[]> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("staff_members")
    .select("id,name,is_active")
    .order("is_active", { ascending: false })
    .order("name", { ascending: true });

  if (error) throw new HttpError(500, "DB", `Failed to load staff: ${error.message}`);

  return (data ?? []).map((staff) => ({
    id: staff.id,
    name: staff.name,
    isActive: staff.is_active,
  }));
}

export async function listActiveStaffForCity(cityId: number): Promise<StaffMember[]> {
  const supabase = createServiceSupabaseClient();
  const { data: allocations, error: allocationsError } = await supabase
    .from("staff_inventory")
    .select("staff_id")
    .eq("city_id", cityId);

  if (allocationsError) {
    throw new HttpError(500, "DB", `Failed to load staff inventory: ${allocationsError.message}`);
  }

  const staffIds = Array.from(new Set((allocations ?? []).map((row) => row.staff_id)));
  if (staffIds.length === 0) return [];

  const { data, error } = await supabase
    .from("staff_members")
    .select("id,name,is_active")
    .eq("is_active", true)
    .in("id", staffIds)
    .order("name", { ascending: true });

  if (error) throw new HttpError(500, "DB", `Failed to load city staff: ${error.message}`);

  return (data ?? []).map((staff) => ({ id: staff.id, name: staff.name, isActive: staff.is_active }));
}

export async function getStaffInventoryLines(params: {
  cityId: number;
  staffId: number;
}): Promise<StaffInventoryLine[]> {
  const supabase = createServiceSupabaseClient();
  const { data: inventory, error: inventoryError } = await supabase
    .from("staff_inventory")
    .select("product_id,stock_qty")
    .eq("city_id", params.cityId)
    .eq("staff_id", params.staffId)
    .gt("stock_qty", 0)
    .order("product_id", { ascending: true });
  if (inventoryError) {
    throw new HttpError(500, "DB", `Failed to load staff inventory: ${inventoryError.message}`);
  }

  const productIds = (inventory ?? []).map((row) => row.product_id);
  if (productIds.length === 0) return [];
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id,title")
    .in("id", productIds);
  if (productsError) throw new HttpError(500, "DB", `Failed to load products: ${productsError.message}`);

  const titleByProductId = new Map((products ?? []).map((product) => [product.id, product.title]));
  return (inventory ?? [])
    .map((row) => ({
      productId: row.product_id,
      title: titleByProductId.get(row.product_id) ?? row.product_id,
      qty: row.stock_qty,
    }))
    .sort((left, right) => left.title.localeCompare(right.title, "ru"));
}

export async function listIssuableInventoryProducts(cityId: number): Promise<IssuableInventoryProduct[]> {
  const supabase = createServiceSupabaseClient();
  const [{ data: cityInventory, error: cityInventoryError }, { data: allocations, error: allocationsError }] =
    await Promise.all([
      supabase
        .from("inventory")
        .select("product_id,stock_qty,in_stock")
        .eq("city_id", cityId),
      supabase
        .from("staff_inventory")
        .select("product_id,stock_qty")
        .eq("city_id", cityId),
    ]);
  if (cityInventoryError) {
    throw new HttpError(500, "DB", `Failed to load city inventory: ${cityInventoryError.message}`);
  }
  if (allocationsError) {
    throw new HttpError(500, "DB", `Failed to load staff allocations: ${allocationsError.message}`);
  }

  const allocatedQtyByProductId = new Map<string, number>();
  for (const row of allocations ?? []) {
    allocatedQtyByProductId.set(
      row.product_id,
      (allocatedQtyByProductId.get(row.product_id) ?? 0) + row.stock_qty,
    );
  }
  const rows = (cityInventory ?? []).filter((row) => {
    if (!row.in_stock) return false;
    if (row.stock_qty === null) return true;
    return row.stock_qty - (allocatedQtyByProductId.get(row.product_id) ?? 0) > 0;
  });
  if (rows.length === 0) return [];

  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id,title,is_active")
    .in(
      "id",
      rows.map((row) => row.product_id),
    );
  if (productsError) throw new HttpError(500, "DB", `Failed to load products: ${productsError.message}`);
  const productById = new Map((products ?? []).map((product) => [product.id, product]));

  return rows
    .map((row) => {
      const product = productById.get(row.product_id);
      return {
        productId: row.product_id,
        title: product?.title ?? row.product_id,
        availableQty:
          row.stock_qty === null
            ? null
            : row.stock_qty - (allocatedQtyByProductId.get(row.product_id) ?? 0),
        isActive: product?.is_active ?? false,
      };
    })
    .filter((row) => row.isActive)
    .sort((left, right) => left.title.localeCompare(right.title, "ru"))
    .map(({ isActive: _isActive, ...row }) => row);
}

export async function issueStockToStaff(params: {
  cityId: number;
  staffId: number;
  productId: string;
  qty: number;
  note?: string | null;
}): Promise<void> {
  if (!Number.isInteger(params.qty) || params.qty <= 0) {
    throw new HttpError(400, "BAD_REQUEST", "Quantity must be a positive integer");
  }

  const supabase = createServiceSupabaseClient();
  const [{ data: staff, error: staffError }, { data: cityStock, error: cityStockError }, { data: allocations, error: allocationsError }] =
    await Promise.all([
      supabase.from("staff_members").select("id,is_active").eq("id", params.staffId).maybeSingle(),
      supabase
        .from("inventory")
        .select("stock_qty,in_stock")
        .eq("city_id", params.cityId)
        .eq("product_id", params.productId)
        .maybeSingle(),
      supabase
        .from("staff_inventory")
        .select("staff_id,stock_qty")
        .eq("city_id", params.cityId)
        .eq("product_id", params.productId),
    ]);
  if (staffError) throw new HttpError(500, "DB", `Failed to load staff member: ${staffError.message}`);
  if (cityStockError) throw new HttpError(500, "DB", `Failed to load city stock: ${cityStockError.message}`);
  if (allocationsError) throw new HttpError(500, "DB", `Failed to load staff allocations: ${allocationsError.message}`);
  if (!staff || !staff.is_active) throw new HttpError(400, "STAFF_UNAVAILABLE", "Staff member is unavailable");
  if (!cityStock || !cityStock.in_stock) {
    throw new HttpError(400, "OUT_OF_STOCK", "Product is unavailable in this city");
  }

  const currentStaffQty = (allocations ?? []).find((row) => row.staff_id === params.staffId)?.stock_qty ?? 0;
  const allocatedTotal = (allocations ?? []).reduce((sum, row) => sum + row.stock_qty, 0);
  if (cityStock.stock_qty !== null && allocatedTotal + params.qty > cityStock.stock_qty) {
    throw new HttpError(400, "STAFF_STOCK_EXCEEDS_CITY", "Not enough unallocated city stock");
  }

  const nextQty = currentStaffQty + params.qty;
  const { error: upsertError } = await supabase.from("staff_inventory").upsert(
    {
      city_id: params.cityId,
      staff_id: params.staffId,
      product_id: params.productId,
      stock_qty: nextQty,
    },
    { onConflict: "staff_id,city_id,product_id" },
  );
  if (upsertError) {
    throw new HttpError(500, "DB", `Failed to issue staff stock: ${upsertError.message}`);
  }

  const { error: movementError } = await supabase.from("inventory_movements").insert({
    city_id: params.cityId,
    staff_id: params.staffId,
    product_id: params.productId,
    kind: "inbound",
    qty: params.qty,
    note: params.note?.trim() || null,
  });
  if (!movementError) return;

  if (currentStaffQty === 0) {
    await supabase
      .from("staff_inventory")
      .delete()
      .eq("city_id", params.cityId)
      .eq("staff_id", params.staffId)
      .eq("product_id", params.productId)
      .eq("stock_qty", nextQty);
  } else {
    await supabase
      .from("staff_inventory")
      .update({ stock_qty: currentStaffQty })
      .eq("city_id", params.cityId)
      .eq("staff_id", params.staffId)
      .eq("product_id", params.productId)
      .eq("stock_qty", nextQty);
  }
  throw new HttpError(500, "DB", `Failed to record inbound movement: ${movementError.message}`);
}

export async function exportInventoryMovementsXlsx(): Promise<Buffer> {
  const supabase = createServiceSupabaseClient();
  const movements: Array<{
    id: number;
    city_id: number;
    staff_id: number | null;
    product_id: string;
    kind: string;
    qty: number;
    related_product_id: string | null;
    order_id: string | null;
    note: string | null;
    created_at: string;
  }> = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("inventory_movements")
      .select("id,city_id,staff_id,product_id,kind,qty,related_product_id,order_id,note,created_at")
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new HttpError(500, "DB", `Failed to export movements: ${error.message}`);
    const page = data ?? [];
    movements.push(...page);
    if (page.length < pageSize) break;
  }

  const [citiesResult, staffResult] = await Promise.all([
    supabase.from("cities").select("id,name,slug"),
    supabase.from("staff_members").select("id,name"),
  ]);
  if (citiesResult.error) throw new HttpError(500, "DB", `Failed to load cities: ${citiesResult.error.message}`);
  if (staffResult.error) throw new HttpError(500, "DB", `Failed to load staff: ${staffResult.error.message}`);

  const productIds = Array.from(
    new Set(
      movements.flatMap((movement) =>
        movement.related_product_id ? [movement.product_id, movement.related_product_id] : [movement.product_id],
      ),
    ),
  );
  const productTitleById = new Map<string, string>();
  for (let index = 0; index < productIds.length; index += 200) {
    const { data, error } = await supabase
      .from("products")
      .select("id,title")
      .in("id", productIds.slice(index, index + 200));
    if (error) throw new HttpError(500, "DB", `Failed to load products: ${error.message}`);
    for (const product of data ?? []) productTitleById.set(product.id, product.title);
  }

  const cityById = new Map(
    (citiesResult.data ?? []).map((city) => [city.id, `${city.name} (${city.slug.toUpperCase()})`]),
  );
  const staffNameById = new Map((staffResult.data ?? []).map((staff) => [staff.id, staff.name]));
  const kindLabel: Record<string, string> = {
    inbound: "Выдача сотруднику",
    sale: "Продажа",
    defect: "Брак",
    replacement: "Замена",
  };
  const rows: Array<Array<string | number>> = [
    [
      "Дата и время",
      "Тип",
      "Город",
      "Сотрудник",
      "Товар",
      "Связанный товар",
      "Количество",
      "Заказ",
      "Комментарий",
    ],
  ];
  for (const movement of movements) {
    rows.push([
      movement.created_at,
      kindLabel[movement.kind] ?? movement.kind,
      cityById.get(movement.city_id) ?? String(movement.city_id),
      movement.staff_id === null ? "" : staffNameById.get(movement.staff_id) ?? String(movement.staff_id),
      productTitleById.get(movement.product_id) ?? movement.product_id,
      movement.related_product_id
        ? productTitleById.get(movement.related_product_id) ?? movement.related_product_id
        : "",
      movement.qty,
      movement.order_id ?? "",
      movement.note ?? "",
    ]);
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [
    { wch: 22 },
    { wch: 22 },
    { wch: 22 },
    { wch: 24 },
    { wch: 38 },
    { wch: 38 },
    { wch: 12 },
    { wch: 38 },
    { wch: 40 },
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Движения");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export async function completeOrderWithStaffSale(params: {
  orderId: string;
  staffId: number;
  paymentMethod: OrderPaymentMethod;
}): Promise<void> {
  const supabase = createServiceSupabaseClient();
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id,status,city_id,seller_id,payment_method")
    .eq("id", params.orderId)
    .maybeSingle();

  if (orderError) throw new HttpError(500, "DB", `Failed to load order: ${orderError.message}`);
  if (!order) throw new HttpError(404, "NOT_FOUND", "Order not found");
  const cityId = order.city_id;
  if (cityId === null) throw new HttpError(400, "BAD_REQUEST", "Order city is missing");

  if (order.status === "done") {
    if (order.seller_id === params.staffId && order.payment_method === params.paymentMethod) return;
    throw new HttpError(409, "ORDER_FINAL", "Order is already completed");
  }
  if (order.status === "cancelled") {
    throw new HttpError(409, "ORDER_FINAL", "Cancelled order cannot be completed");
  }

  const { data: staff, error: staffError } = await supabase
    .from("staff_members")
    .select("id,is_active")
    .eq("id", params.staffId)
    .maybeSingle();
  if (staffError) throw new HttpError(500, "DB", `Failed to load staff member: ${staffError.message}`);
  if (!staff || !staff.is_active) throw new HttpError(400, "STAFF_UNAVAILABLE", "Staff member is unavailable");

  const { data: orderItems, error: itemsError } = await supabase
    .from("order_items")
    .select("product_id,qty")
    .eq("order_id", order.id);
  if (itemsError) throw new HttpError(500, "DB", `Failed to load order items: ${itemsError.message}`);

  const lines = normalizeStockLines(
    (orderItems ?? [])
      .filter((item): item is { product_id: string; qty: number } => typeof item.product_id === "string")
      .map((item) => ({ productId: item.product_id, qty: item.qty })),
  );
  if (lines.length === 0) throw new HttpError(400, "BAD_REQUEST", "Order has no stock items");

  const productIds = lines.map((line) => line.productId);
  const { data: staffInventory, error: inventoryError } = await supabase
    .from("staff_inventory")
    .select("product_id,stock_qty")
    .eq("staff_id", params.staffId)
    .eq("city_id", cityId)
    .in("product_id", productIds);
  if (inventoryError) throw new HttpError(500, "DB", `Failed to load staff stock: ${inventoryError.message}`);

  const staffQtyByProductId = new Map((staffInventory ?? []).map((row) => [row.product_id, row.stock_qty]));
  for (const line of lines) {
    const available = staffQtyByProductId.get(line.productId);
    if (available === undefined || available < line.qty) {
      throw new HttpError(400, "STAFF_OUT_OF_STOCK", "Selected staff member does not have enough stock");
    }
  }

  const reserved: ReservedStaffInventory[] = [];
  for (const line of lines) {
    const previousQty = staffQtyByProductId.get(line.productId) ?? 0;
    const nextQty = previousQty - line.qty;
    const { data: updated, error: updateError } = await supabase
      .from("staff_inventory")
      .update({ stock_qty: nextQty })
      .eq("staff_id", params.staffId)
      .eq("city_id", cityId)
      .eq("product_id", line.productId)
      .eq("stock_qty", previousQty)
      .select("product_id")
      .maybeSingle();

    if (updateError || !updated) {
      await restoreStaffInventory({ staffId: params.staffId, cityId, rows: reserved });
      throw new HttpError(409, "STAFF_OUT_OF_STOCK", "Staff stock changed, choose another seller");
    }

    reserved.push({ productId: line.productId, previousQty, nextQty });
  }

  const { error: movementsError } = await supabase.from("inventory_movements").insert(
    lines.map((line) => ({
      city_id: cityId,
      staff_id: params.staffId,
      product_id: line.productId,
      kind: "sale",
      qty: line.qty,
      order_id: order.id,
    })),
  );
  if (movementsError) {
    await restoreStaffInventory({ staffId: params.staffId, cityId, rows: reserved });
    throw new HttpError(500, "DB", `Failed to record sale movement: ${movementsError.message}`);
  }

  const { data: completedOrder, error: completeError } = await supabase
    .from("orders")
    .update({ status: "done", seller_id: params.staffId, payment_method: params.paymentMethod })
    .eq("id", order.id)
    .neq("status", "done")
    .select("id")
    .maybeSingle();

  if (completeError || !completedOrder) {
    await supabase
      .from("inventory_movements")
      .delete()
      .eq("order_id", order.id)
      .eq("staff_id", params.staffId)
      .eq("kind", "sale");
    await restoreStaffInventory({ staffId: params.staffId, cityId, rows: reserved });
    throw new HttpError(409, "ORDER_FINAL", "Order status changed, reload the order");
  }
}

export async function applyStaffInventoryOperation(params: {
  kind: "defect" | "replacement";
  cityId: number;
  staffId: number;
  productId: string;
  qty: number;
  returnedProductId?: string | null;
  note?: string | null;
}): Promise<void> {
  if (!Number.isInteger(params.qty) || params.qty <= 0) {
    throw new HttpError(400, "BAD_REQUEST", "Quantity must be a positive integer");
  }

  const supabase = createServiceSupabaseClient();
  const [{ data: staffStock, error: staffStockError }, { data: cityStock, error: cityStockError }] =
    await Promise.all([
      supabase
        .from("staff_inventory")
        .select("stock_qty")
        .eq("staff_id", params.staffId)
        .eq("city_id", params.cityId)
        .eq("product_id", params.productId)
        .maybeSingle(),
      supabase
        .from("inventory")
        .select("stock_qty,in_stock")
        .eq("city_id", params.cityId)
        .eq("product_id", params.productId)
        .maybeSingle(),
    ]);

  if (staffStockError) throw new HttpError(500, "DB", `Failed to load staff stock: ${staffStockError.message}`);
  if (cityStockError) throw new HttpError(500, "DB", `Failed to load city stock: ${cityStockError.message}`);
  if (!staffStock || staffStock.stock_qty < params.qty) {
    throw new HttpError(400, "STAFF_OUT_OF_STOCK", "Staff member does not have enough stock");
  }
  if (!cityStock) throw new HttpError(400, "INVENTORY_MISSING", "City inventory row is missing");
  if (cityStock.stock_qty !== null && cityStock.stock_qty < params.qty) {
    throw new HttpError(400, "OUT_OF_STOCK", "City does not have enough stock");
  }

  const nextStaffQty = staffStock.stock_qty - params.qty;
  const { data: updatedStaff, error: updateStaffError } = await supabase
    .from("staff_inventory")
    .update({ stock_qty: nextStaffQty })
    .eq("staff_id", params.staffId)
    .eq("city_id", params.cityId)
    .eq("product_id", params.productId)
    .eq("stock_qty", staffStock.stock_qty)
    .select("id")
    .maybeSingle();
  if (updateStaffError || !updatedStaff) {
    throw new HttpError(409, "STAFF_OUT_OF_STOCK", "Staff stock changed, try again");
  }

  let cityReservation: { previousQty: number; nextQty: number } | null = null;
  if (cityStock.stock_qty !== null) {
    const nextCityQty = cityStock.stock_qty - params.qty;
    const { data: updatedCity, error: updateCityError } = await supabase
      .from("inventory")
      .update({ stock_qty: nextCityQty, in_stock: nextCityQty > 0 })
      .eq("city_id", params.cityId)
      .eq("product_id", params.productId)
      .eq("stock_qty", cityStock.stock_qty)
      .select("id")
      .maybeSingle();

    if (updateCityError || !updatedCity) {
      await restoreStaffInventory({
        staffId: params.staffId,
        cityId: params.cityId,
        rows: [{ productId: params.productId, previousQty: staffStock.stock_qty, nextQty: nextStaffQty }],
      });
      throw new HttpError(409, "OUT_OF_STOCK", "City stock changed, try again");
    }

    cityReservation = { previousQty: cityStock.stock_qty, nextQty: nextCityQty };
  }

  const { error: movementError } = await supabase.from("inventory_movements").insert({
    city_id: params.cityId,
    staff_id: params.staffId,
    product_id: params.productId,
    kind: params.kind,
    qty: params.qty,
    related_product_id: params.kind === "replacement" ? params.returnedProductId ?? null : null,
    note: params.note?.trim() || null,
  });
  if (movementError) {
    if (cityReservation) {
      await supabase
        .from("inventory")
        .update({ stock_qty: cityReservation.previousQty, in_stock: cityReservation.previousQty > 0 })
        .eq("city_id", params.cityId)
        .eq("product_id", params.productId)
        .eq("stock_qty", cityReservation.nextQty);
    }
    await restoreStaffInventory({
      staffId: params.staffId,
      cityId: params.cityId,
      rows: [{ productId: params.productId, previousQty: staffStock.stock_qty, nextQty: nextStaffQty }],
    });
    throw new HttpError(500, "DB", `Failed to record inventory operation: ${movementError.message}`);
  }
}
