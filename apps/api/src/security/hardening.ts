import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";

type RateLimitRule = {
  limit: number;
  windowMs: number;
};

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const ONE_MINUTE_MS = 60_000;
const MAX_RATE_LIMIT_KEYS = 10_000;

const GENERAL_API_RULE: RateLimitRule = { limit: 180, windowMs: ONE_MINUTE_MS };
const EXPENSIVE_API_RULE: RateLimitRule = { limit: 30, windowMs: ONE_MINUTE_MS };
const ORDER_WRITE_RULE: RateLimitRule = { limit: 12, windowMs: ONE_MINUTE_MS };
const ADMIN_WRITE_RULE: RateLimitRule = { limit: 45, windowMs: ONE_MINUTE_MS };
const WEBHOOK_RULE: RateLimitRule = { limit: 120, windowMs: ONE_MINUTE_MS };

class FixedWindowRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  take(key: string, rule: RateLimitRule, now: number): RateLimitEntry {
    const current = this.entries.get(key);
    if (current && current.resetAt > now) {
      current.count += 1;
      return current;
    }

    if (this.entries.size >= MAX_RATE_LIMIT_KEYS) {
      for (const [staleKey, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(staleKey);
      }
      const oldestKey = this.entries.keys().next().value;
      if (this.entries.size >= MAX_RATE_LIMIT_KEYS && typeof oldestKey === "string") {
        this.entries.delete(oldestKey);
      }
    }

    const next = { count: 1, resetAt: now + rule.windowMs };
    this.entries.set(key, next);
    return next;
  }
}

const limiter = new FixedWindowRateLimiter();

function requestPath(request: FastifyRequest): string {
  return (request.raw.url ?? request.url).split("?", 1)[0] ?? "/";
}

function rateLimitRule(request: FastifyRequest): RateLimitRule | null {
  if (request.method === "OPTIONS") return null;

  const path = requestPath(request);
  if (path === "/health" || path.startsWith("/static/")) return null;
  if (path === "/api/telegram/webhook") return WEBHOOK_RULE;
  if (path === "/api/order" && request.method === "POST") return ORDER_WRITE_RULE;
  if (path.startsWith("/api/orders/") && request.method !== "GET") return ORDER_WRITE_RULE;
  if (path.startsWith("/api/admin/") && request.method !== "GET") return ADMIN_WRITE_RULE;
  if (
    path === "/api/image-proxy" ||
    path.startsWith("/api/delivery/") ||
    path === "/api/promocodes/preview"
  ) {
    return EXPENSIVE_API_RULE;
  }
  if (path.startsWith("/api/")) return GENERAL_API_RULE;
  return null;
}

function clientKey(request: FastifyRequest): string {
  // Fastify uses the socket IP unless trustProxy is enabled in the server
  // configuration. Never parse x-forwarded-for ourselves: that header is
  // attacker-controlled without an explicitly trusted reverse proxy.
  const ip = request.ip.trim();
  return ip.length > 0 ? ip : "unknown";
}

function rateLimitKeyPath(request: FastifyRequest, path: string): string {
  // Dynamic path segments must not create unbounded rate-limit buckets.
  if (path.startsWith("/api/admin/")) return "/api/admin/*";
  if (path.startsWith("/api/orders/")) return "/api/orders/*";
  if (path.startsWith("/api/delivery/")) return "/api/delivery/*";
  return path;
}

export function registerSecurityHardening(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const rule = rateLimitRule(request);
    if (!rule) return;

    const now = Date.now();
    const path = requestPath(request);
    const key = `${clientKey(request)}:${request.method}:${rateLimitKeyPath(request, path)}:${rule.limit}`;
    const entry = limiter.take(key, rule, now);
    const remaining = Math.max(0, rule.limit - entry.count);
    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1_000));

    reply
      .header("RateLimit-Limit", String(rule.limit))
      .header("RateLimit-Remaining", String(remaining))
      .header("RateLimit-Reset", String(resetSeconds));

    if (entry.count > rule.limit) {
      request.log.warn({ path, method: request.method }, "Request rate limit exceeded");
      return reply
        .header("Retry-After", String(resetSeconds))
        .header("Cache-Control", "no-store")
        .code(429)
        .send({
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests. Please try again shortly.",
          },
        });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Robots-Tag", "noindex, nofollow")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );

    if (!config.isDev) {
      reply.header("Strict-Transport-Security", "max-age=31536000");
    }

    // Route handlers deliberately return useful 4xx validation messages.
    // Never expose stack traces, database errors or provider responses on 5xx.
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (reply.statusCode >= 500 && contentType.includes("application/json")) {
      reply.removeHeader("Content-Length");
      reply.header("Cache-Control", "no-store");
      return JSON.stringify({
        ok: false,
        error: { code: "INTERNAL", message: "An unexpected server error occurred." },
      });
    }

    return payload;
  });
}
