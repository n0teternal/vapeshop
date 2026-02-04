import type { FastifyInstance, FastifyRequest } from "fastify";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { HttpError, isHttpError } from "../httpError.js";
import { importProductsCsv } from "../import/productsCsv.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import { deleteMessage } from "../telegram/api.js";
import { requireAdmin } from "./requireAdmin.js";

type ApiSuccess<T> = { ok: true; data: T };
type ApiFailure = { ok: false; error: { code: string; message: string } };

function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ApiFailure {
  return { ok: false, error: { code, message } };
}

function toNumber(value: unknown, fieldName: string): number {
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

function sanitizeFileName(filename: string): string {
  const base = path.basename(filename);
  // Keep it simple: replace everything suspicious with underscore.
  return base.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function getParamId(request: FastifyRequest): string {
  const params = request.params as unknown;
  const parsed = z.object({ id: z.string().uuid() }).safeParse(params);
  if (!parsed.success) {
    throw new HttpError(400, "BAD_REQUEST", "Invalid id");
  }
  return parsed.data.id;
}

function errorToResponse(e: unknown): { statusCode: number; body: ApiFailure } {
  if (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE"
  ) {
    return {
      statusCode: 400,
      body: fail("BAD_REQUEST", "File too large (max 5MB)"),
    };
  }

  if (isHttpError(e)) {
    return { statusCode: e.statusCode, body: fail(e.code, e.message) };
  }
  const message = e instanceof Error ? e.message : "Unexpected error";
  return { statusCode: 500, body: fail("INTERNAL", message) };
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/me",
    async (request, reply) => {
      try {
        const me = await requireAdmin(request);
        return reply.code(200).send(ok(me));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/cities",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("cities")
          .select("id,name,slug")
          .order("slug", { ascending: true });

        if (error) {
          throw new HttpError(500, "DB", `Failed to load cities: ${error.message}`);
        }

        return reply.code(200).send(ok(data ?? []));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const supabase = createServiceSupabaseClient();

        const [{ data: cities, error: citiesError }, { data: products, error: productsError }, { data: inventory, error: inventoryError }] =
          await Promise.all([
            supabase.from("cities").select("id,slug").order("slug", { ascending: true }),
            supabase
              .from("products")
              .select("id,title,description,base_price,image_url,is_active,created_at")
              .order("created_at", { ascending: false }),
            supabase
              .from("inventory")
              .select("product_id,city_id,in_stock,stock_qty,price_override"),
          ]);

        if (citiesError) {
          throw new HttpError(500, "DB", `Failed to load cities: ${citiesError.message}`);
        }
        if (productsError) {
          throw new HttpError(
            500,
            "DB",
            `Failed to load products: ${productsError.message}`,
          );
        }
        if (inventoryError) {
          throw new HttpError(
            500,
            "DB",
            `Failed to load inventory: ${inventoryError.message}`,
          );
        }

        const cityList = (cities ?? []).map((c) => ({ id: c.id, slug: c.slug }));

        type InventoryRow = {
          product_id: string;
          city_id: number;
          in_stock: boolean;
          stock_qty: number | null;
          price_override: unknown;
        };
        const invList = (inventory ?? []) as unknown as InventoryRow[];
        const invByKey = new Map<string, InventoryRow>();
        for (const row of invList) {
          invByKey.set(`${row.product_id}:${row.city_id}`, row);
        }

        const result = (products ?? []).map((p) => {
          const basePrice = toNumber(p.base_price, "products.base_price");

          return {
            id: p.id,
            title: p.title,
            description: p.description,
            base_price: basePrice,
            image_url: p.image_url,
            is_active: p.is_active,
            inventory: cityList.map((c) => {
              const inv = invByKey.get(`${p.id}:${c.id}`);
              return {
                city_id: c.id,
                city_slug: c.slug,
                in_stock: inv?.in_stock ?? false,
                stock_qty: inv?.stock_qty ?? null,
                price_override:
                  inv?.price_override === null || inv?.price_override === undefined
                    ? null
                    : toNumber(inv.price_override, "inventory.price_override"),
              };
            }),
          };
        });

        return reply.code(200).send(ok(result));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const schema = z.object({
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(10_000).nullable().optional(),
          basePrice: z.number().finite().nonnegative(),
          isActive: z.boolean().optional(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("products")
          .insert({
            title: parsed.data.title,
            description: parsed.data.description ?? null,
            base_price: parsed.data.basePrice,
            is_active: parsed.data.isActive ?? true,
          })
          .select("id,title,description,base_price,image_url,is_active,created_at")
          .single();

        if (error) {
          throw new HttpError(500, "DB", `Failed to create product: ${error.message}`);
        }
        if (!data) {
          throw new HttpError(500, "DB", "Failed to create product (empty response)");
        }

        return reply.code(200).send(
          ok({
            id: data.id,
            title: data.title,
            description: data.description,
            base_price: toNumber(data.base_price, "products.base_price"),
            image_url: data.image_url,
            is_active: data.is_active,
            created_at: data.created_at,
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.put<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products/:id",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const productId = getParamId(request);

        const schema = z.object({
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(10_000).nullable(),
          basePrice: z.number().finite().nonnegative(),
          isActive: z.boolean(),
          imageUrl: z.string().trim().url().nullable().optional(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const update: Record<string, unknown> = {
          title: parsed.data.title,
          description: parsed.data.description,
          base_price: parsed.data.basePrice,
          is_active: parsed.data.isActive,
        };
        if (Object.prototype.hasOwnProperty.call(parsed.data, "imageUrl")) {
          update.image_url = parsed.data.imageUrl ?? null;
        }

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("products")
          .update(update)
          .eq("id", productId)
          .select("id,title,description,base_price,image_url,is_active,created_at")
          .single();

        if (error) {
          throw new HttpError(500, "DB", `Failed to update product: ${error.message}`);
        }
        if (!data) {
          throw new HttpError(404, "NOT_FOUND", "Product not found");
        }

        return reply.code(200).send(
          ok({
            id: data.id,
            title: data.title,
            description: data.description,
            base_price: toNumber(data.base_price, "products.base_price"),
            image_url: data.image_url,
            is_active: data.is_active,
            created_at: data.created_at,
          }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/products/:id/image",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const productId = getParamId(request);

        const file = await request.file();
        if (!file) {
          throw new HttpError(400, "BAD_REQUEST", "file is required");
        }

        const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
        if (!allowedTypes.has(file.mimetype)) {
          throw new HttpError(400, "BAD_REQUEST", "Only jpeg/png/webp allowed");
        }

        const buffer = await file.toBuffer();
        const maxSize = 5 * 1024 * 1024;
        if (buffer.byteLength > maxSize) {
          throw new HttpError(400, "BAD_REQUEST", "File too large (max 5MB)");
        }

        const supabase = createServiceSupabaseClient();

        const { data: existing, error: existingError } = await supabase
          .from("products")
          .select("id")
          .eq("id", productId)
          .maybeSingle();

        if (existingError) {
          throw new HttpError(500, "DB", `Failed to load product: ${existingError.message}`);
        }
        if (!existing) {
          throw new HttpError(404, "NOT_FOUND", "Product not found");
        }

        const safeName = sanitizeFileName(file.filename);
        const objectPath = `${productId}/${Date.now()}_${safeName}`;

        const { error: uploadError } = await supabase.storage
          .from("product-images")
          .upload(objectPath, buffer, {
            contentType: file.mimetype,
            upsert: false,
          });

        if (uploadError) {
          throw new HttpError(500, "STORAGE", `Upload failed: ${uploadError.message}`);
        }

        const { data: publicData } = supabase.storage
          .from("product-images")
          .getPublicUrl(objectPath);

        const imageUrl = publicData.publicUrl;

        const { data: updated, error: updateError } = await supabase
          .from("products")
          .update({ image_url: imageUrl })
          .eq("id", productId)
          .select("id")
          .single();

        if (updateError) {
          throw new HttpError(500, "DB", `Failed to set image_url: ${updateError.message}`);
        }
        if (!updated) {
          throw new HttpError(404, "NOT_FOUND", "Product not found");
        }

        return reply.code(200).send(ok({ imageUrl }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.put<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/inventory",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const schema = z.object({
          productId: z.string().uuid(),
          citySlug: z.string().trim().min(1).max(50),
          inStock: z.boolean(),
          stockQty: z.number().int().nonnegative().nullable().optional(),
          priceOverride: z.number().finite().nonnegative().nullable().optional(),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const { data: city, error: cityError } = await supabase
          .from("cities")
          .select("id,slug")
          .eq("slug", parsed.data.citySlug)
          .single();

        if (cityError) {
          throw new HttpError(500, "DB", `Failed to load city: ${cityError.message}`);
        }
        if (!city) {
          throw new HttpError(400, "CITY_NOT_FOUND", "City not found");
        }

        const { error } = await supabase.from("inventory").upsert(
          {
            product_id: parsed.data.productId,
            city_id: city.id,
            in_stock: parsed.data.inStock,
            stock_qty: parsed.data.stockQty ?? null,
            price_override: parsed.data.priceOverride ?? null,
          },
          { onConflict: "product_id,city_id" },
        );

        if (error) {
          throw new HttpError(500, "DB", `Failed to upsert inventory: ${error.message}`);
        }

        return reply.code(200).send(
          ok({ productId: parsed.data.productId, citySlug: parsed.data.citySlug }),
        );
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.post<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/import/products",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const querySchema = z.object({
          imageMode: z.enum(["filename"]).optional(),
        });
        const parsedQuery = querySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid query");
        }

        const file = await request.file();
        if (!file) {
          throw new HttpError(400, "BAD_REQUEST", "file is required");
        }

        const buffer = await file.toBuffer();
        const maxSize = 5 * 1024 * 1024;
        if (buffer.byteLength > maxSize) {
          throw new HttpError(400, "BAD_REQUEST", "File too large (max 5MB)");
        }

        const csvText = buffer.toString("utf8");
        const supabase = createServiceSupabaseClient();
        const useImagePrefix = parsedQuery.data.imageMode === "filename";
        if (useImagePrefix && !config.productImagesBaseUrl) {
          throw new HttpError(
            400,
            "BAD_REQUEST",
            "PRODUCT_IMAGES_BASE_URL is not configured on server",
          );
        }

        const result = await importProductsCsv({
          supabase,
          csvText,
          imageBaseUrl: useImagePrefix ? config.productImagesBaseUrl : null,
        });

        return reply.code(200).send(ok(result));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.get<{ Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/orders",
    async (request, reply) => {
      try {
        await requireAdmin(request);

        const querySchema = z.object({
          status: z.enum(["new", "processing", "done"]).optional(),
        });

        const parsedQuery = querySchema.safeParse(request.query);
        if (!parsedQuery.success) {
          throw new HttpError(400, "BAD_REQUEST", "Invalid query");
        }

        const status = parsedQuery.data.status ?? "new";
        const supabase = createServiceSupabaseClient();

        const { data: orders, error: ordersError } = await supabase
          .from("orders")
          .select(
            "id,created_at,status,city_id,tg_user_id,tg_username,delivery_method,comment,total_price",
          )
          .eq("status", status)
          .order("created_at", { ascending: false });

        if (ordersError) {
          throw new HttpError(500, "DB", `Failed to load orders: ${ordersError.message}`);
        }

        const orderList = orders ?? [];
        if (orderList.length === 0) {
          return reply.code(200).send(ok([]));
        }

        const orderIds = orderList.map((o) => o.id);
        const cityIds = Array.from(
          new Set(orderList.map((o) => o.city_id).filter((x): x is number => typeof x === "number")),
        );

        const [{ data: cities, error: citiesError }, { data: orderItems, error: orderItemsError }] =
          await Promise.all([
            cityIds.length > 0
              ? supabase.from("cities").select("id,slug").in("id", cityIds)
              : Promise.resolve({ data: [], error: null }),
            supabase
              .from("order_items")
              .select("order_id,product_id,qty,unit_price")
              .in("order_id", orderIds),
          ]);

        if (citiesError) {
          throw new HttpError(500, "DB", `Failed to load cities: ${citiesError.message}`);
        }
        if (orderItemsError) {
          throw new HttpError(
            500,
            "DB",
            `Failed to load order items: ${orderItemsError.message}`,
          );
        }

        const citySlugById = new Map((cities ?? []).map((c) => [c.id, c.slug]));

        const itemsList = (orderItems ?? []) as Array<{
          order_id: string;
          product_id: string | null;
          qty: number;
          unit_price: unknown;
        }>;

        const productIds = Array.from(
          new Set(itemsList.map((i) => i.product_id).filter((x): x is string => typeof x === "string")),
        );

        const { data: products, error: productsError } =
          productIds.length > 0
            ? await supabase.from("products").select("id,title").in("id", productIds)
            : { data: [], error: null };

        if (productsError) {
          throw new HttpError(500, "DB", `Failed to load products: ${productsError.message}`);
        }

        const titleByProductId = new Map((products ?? []).map((p) => [p.id, p.title]));

        const itemsByOrderId = new Map<
          string,
          Array<{ product_id: string | null; title: string | null; qty: number; unit_price: number }>
        >();

        for (const it of itemsList) {
          const title =
            it.product_id && titleByProductId.has(it.product_id)
              ? titleByProductId.get(it.product_id) ?? null
              : null;
          const unitPrice = toNumber(it.unit_price, "order_items.unit_price");
          const row = {
            product_id: it.product_id,
            title,
            qty: it.qty,
            unit_price: unitPrice,
          };
          const arr = itemsByOrderId.get(it.order_id) ?? [];
          arr.push(row);
          itemsByOrderId.set(it.order_id, arr);
        }

        const result = orderList.map((o) => ({
          id: o.id,
          created_at: o.created_at,
          status: o.status,
          city_id: o.city_id,
          city_slug: typeof o.city_id === "number" ? citySlugById.get(o.city_id) ?? null : null,
          tg_user_id: o.tg_user_id,
          tg_username: o.tg_username,
          delivery_method: o.delivery_method,
          comment: o.comment,
          total_price: toNumber(o.total_price, "orders.total_price"),
          items: itemsByOrderId.get(o.id) ?? [],
        }));

        return reply.code(200).send(ok(result));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );

  app.put<{ Body: unknown; Reply: ApiSuccess<unknown> | ApiFailure }>(
    "/api/admin/orders/:id/status",
    async (request, reply) => {
      try {
        await requireAdmin(request);
        const orderId = getParamId(request);

        const schema = z.object({
          status: z.enum(["new", "processing", "done"]),
        });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
          throw new HttpError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid body");
        }

        const supabase = createServiceSupabaseClient();
        const { data, error } = await supabase
          .from("orders")
          .update({ status: parsed.data.status })
          .eq("id", orderId)
          .select("id,status,notify_chat_id,notify_message_id")
          .single();

        if (error) {
          throw new HttpError(500, "DB", `Failed to update order status: ${error.message}`);
        }
        if (!data) {
          throw new HttpError(404, "NOT_FOUND", "Order not found");
        }

        if (
          parsed.data.status === "done" &&
          typeof (data as any).notify_chat_id === "number" &&
          typeof (data as any).notify_message_id === "number"
        ) {
          try {
            await deleteMessage({
              botToken: config.telegram.botToken,
              chatId: (data as any).notify_chat_id,
              messageId: (data as any).notify_message_id,
            });
          } catch (e) {
            // Best-effort: status is already updated in DB, so we don't fail the admin action.
            request.log.error({ err: e }, "Failed to delete Telegram message for done order");
          }
        }

        return reply.code(200).send(ok({ id: data.id, status: data.status }));
      } catch (e) {
        const { statusCode, body } = errorToResponse(e);
        return reply.code(statusCode).send(body);
      }
    },
  );
}
