import crypto from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";
import { getBotUsername } from "../telegram/api.js";

const REFERRAL_CODE_PREFIX = "ref_";
const REFERRAL_CODE_LENGTH = 8;
const REFERRALS_MAX_PAGE_LIMIT = 100;
const POINTS_HISTORY_LIMIT = 30;

const REFERRAL_INVITER_BONUS_KIND = "referral_inviter_bonus";
const REFERRAL_INVITEE_BONUS_KIND = "referral_invitee_bonus";
const ORDER_POINTS_SPEND_KIND = "order_points_spend";

let cachedBotUsername: string | null | undefined;

type CustomerProfileRow = {
  tg_user_id: number;
  referral_code: string;
  referred_by_tg_user_id: number | null;
  referral_bound_at: string | null;
  tg_username: string | null;
  created_at: string;
};

type ReferralRow = {
  id: number;
  inviter_tg_user_id: number;
  invitee_tg_user_id: number;
  status: string;
  qualified_order_id: string | null;
  rewarded_at: string | null;
  created_at: string;
};

type InviteeProfileRow = {
  tg_user_id: number;
  tg_username: string | null;
};

type InviteeFirstOrderRow = {
  id: string;
  tg_user_id: number;
  status: string;
  created_at: string;
};

export type ReferralInviteeStatus =
  | "joined_no_order"
  | "first_order_created_not_paid"
  | "first_order_done_rewarded";

export type ReferralOverview = {
  referralCode: string;
  referralLink: string;
  rewardPoints: { inviter: number; invitee: number; minFirstOrderTotalRub: number };
  pointsBalance: number;
  pointsHistory: Array<{
    id: number;
    deltaPoints: number;
    kind: string;
    orderId: string | null;
    referralId: number | null;
    createdAt: string;
  }>;
  referrals: Array<{
    id: number;
    inviteeTgUserId: number;
    inviteeUsername: string | null;
    status: ReferralInviteeStatus;
    joinedAt: string;
    firstOrderId: string | null;
    firstOrderStatus: string | null;
    rewardedAt: string | null;
  }>;
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
  };
};

function generateReferralCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(REFERRAL_CODE_LENGTH);
  let out = "";

  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    const byte = bytes[i] ?? 0;
    out += alphabet[byte % alphabet.length];
  }

  return out;
}

function parseReferralCodeFromStartParam(startParam: string | null | undefined): string | null {
  if (!startParam) return null;
  const trimmed = startParam.trim();
  if (trimmed.length === 0) return null;

  if (!trimmed.toLowerCase().startsWith(REFERRAL_CODE_PREFIX)) {
    return null;
  }

  const code = trimmed.slice(REFERRAL_CODE_PREFIX.length).trim();
  if (!/^[A-Za-z0-9]{4,64}$/.test(code)) {
    return null;
  }

  return code;
}

function sanitizeBotUsername(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/^@+/, "");
  if (cleaned.length === 0) return null;
  return cleaned;
}

function sanitizeMiniAppShortName(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_]{1,64}$/.test(cleaned)) return null;
  return cleaned;
}

function numberFromUnknown(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    throw new HttpError(500, "DB", `Invalid numeric value: ${String(value)}`);
  }

  return parsed;
}

async function resolveBotUsername(): Promise<string | null> {
  const envValue = sanitizeBotUsername(config.telegram.botUsername);
  if (envValue) {
    cachedBotUsername = envValue;
    return envValue;
  }

  if (cachedBotUsername !== undefined) {
    return cachedBotUsername;
  }

  try {
    const fromTelegram = await getBotUsername({ botToken: config.telegram.botToken });
    cachedBotUsername = sanitizeBotUsername(fromTelegram);
  } catch {
    cachedBotUsername = null;
  }

  return cachedBotUsername;
}

async function buildReferralLink(referralCode: string): Promise<string> {
  const botUsername = await resolveBotUsername();
  const payload = `${REFERRAL_CODE_PREFIX}${referralCode}`;
  if (!botUsername) return payload;

  const miniAppShortName = sanitizeMiniAppShortName(config.telegram.miniAppShortName);
  if (miniAppShortName) {
    // Direct Mini App link: opens mini app immediately and keeps startapp payload.
    return `https://t.me/${botUsername}/${miniAppShortName}?startapp=${encodeURIComponent(payload)}`;
  }

  // Fallback deep link to bot chat when mini app short name isn't configured.
  return `https://t.me/${botUsername}?start=${encodeURIComponent(payload)}`;
}

async function loadCustomerProfile(tgUserId: number): Promise<CustomerProfileRow | null> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("customer_profiles")
    .select("tg_user_id,referral_code,referred_by_tg_user_id,referral_bound_at,tg_username,created_at")
    .eq("tg_user_id", tgUserId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "DB", `Failed to load customer profile: ${error.message}`);
  }

  return (data ?? null) as CustomerProfileRow | null;
}

async function insertCustomerProfile(params: {
  tgUserId: number;
  tgUsername: string | null;
}): Promise<CustomerProfileRow> {
  const supabase = createServiceSupabaseClient();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const referralCode = generateReferralCode();
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("customer_profiles")
      .insert({
        tg_user_id: params.tgUserId,
        tg_username: params.tgUsername,
        referral_code: referralCode,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("tg_user_id,referral_code,referred_by_tg_user_id,referral_bound_at,tg_username,created_at")
      .single();

    if (!error && data) {
      return data as CustomerProfileRow;
    }

    const code = (error as { code?: string } | null)?.code ?? "";
    const message = (error as { message?: string } | null)?.message ?? "";
    const referralCodeCollision =
      code === "23505" &&
      (message.includes("customer_profiles_referral_code_uq") ||
        message.includes("customer_profiles_referral_code_lower_uq") ||
        message.includes("referral_code"));
    if (referralCodeCollision) {
      continue;
    }

    const duplicatePk = code === "23505" && message.includes("customer_profiles_pkey");
    if (duplicatePk) {
      const profile = await loadCustomerProfile(params.tgUserId);
      if (profile) return profile;
    }

    throw new HttpError(500, "DB", `Failed to create customer profile: ${message || "unknown error"}`);
  }

  throw new HttpError(500, "DB", "Failed to generate unique referral code");
}

async function ensureCustomerProfile(params: {
  tgUserId: number;
  tgUsername: string | null;
}): Promise<CustomerProfileRow> {
  const current = await loadCustomerProfile(params.tgUserId);
  if (!current) {
    return insertCustomerProfile(params);
  }

  const nextUsername = params.tgUsername;
  if (nextUsername && nextUsername !== current.tg_username) {
    const supabase = createServiceSupabaseClient();
    const { error } = await supabase
      .from("customer_profiles")
      .update({
        tg_username: nextUsername,
        updated_at: new Date().toISOString(),
      })
      .eq("tg_user_id", params.tgUserId);
    if (!error) {
      return { ...current, tg_username: nextUsername };
    }
  }

  return current;
}

async function bindReferralByStartParam(params: {
  profile: CustomerProfileRow;
  startParam: string | null | undefined;
}): Promise<boolean> {
  if (params.profile.referred_by_tg_user_id !== null) return false;

  const referralCode = parseReferralCodeFromStartParam(params.startParam);
  if (!referralCode) return false;

  const supabase = createServiceSupabaseClient();

  // A referral can only be bound before invitee has any orders.
  const { data: existingOrderRows, error: existingOrderError } = await supabase
    .from("orders")
    .select("id")
    .eq("tg_user_id", params.profile.tg_user_id)
    .limit(1);
  if (existingOrderError) {
    throw new HttpError(500, "DB", `Failed to check invitee orders: ${existingOrderError.message}`);
  }
  if ((existingOrderRows ?? []).length > 0) return false;

  const { data: inviterProfile, error: inviterError } = await supabase
    .from("customer_profiles")
    .select("tg_user_id")
    .ilike("referral_code", referralCode)
    .maybeSingle();
  if (inviterError) {
    throw new HttpError(500, "DB", `Failed to load inviter profile: ${inviterError.message}`);
  }
  if (!inviterProfile) return false;
  if (inviterProfile.tg_user_id === params.profile.tg_user_id) return false;

  const nowIso = new Date().toISOString();
  const { data: updatedInvitee, error: bindError } = await supabase
    .from("customer_profiles")
    .update({
      referred_by_tg_user_id: inviterProfile.tg_user_id,
      referral_bound_at: nowIso,
      updated_at: nowIso,
    })
    .eq("tg_user_id", params.profile.tg_user_id)
    .is("referred_by_tg_user_id", null)
    .select("tg_user_id,referred_by_tg_user_id")
    .maybeSingle();

  if (bindError) {
    throw new HttpError(500, "DB", `Failed to bind referral code: ${bindError.message}`);
  }
  if (!updatedInvitee || updatedInvitee.referred_by_tg_user_id === null) {
    return false;
  }

  const { error: referralInsertError } = await supabase.from("referrals").upsert(
    {
      inviter_tg_user_id: inviterProfile.tg_user_id,
      invitee_tg_user_id: params.profile.tg_user_id,
      status: "pending",
      created_at: nowIso,
    },
    { onConflict: "invitee_tg_user_id", ignoreDuplicates: true },
  );

  if (referralInsertError) {
    throw new HttpError(500, "DB", `Failed to create referral link: ${referralInsertError.message}`);
  }

  return true;
}

export async function bootstrapReferralProfile(params: {
  tgUserId: number;
  tgUsername: string | null;
  startParam: string | null | undefined;
}): Promise<{ referralCode: string; referralLink: string; referralBound: boolean }> {
  const profile = await ensureCustomerProfile({
    tgUserId: params.tgUserId,
    tgUsername: params.tgUsername,
  });

  const referralBound = await bindReferralByStartParam({
    profile,
    startParam: params.startParam,
  });

  return {
    referralCode: profile.referral_code,
    referralLink: await buildReferralLink(profile.referral_code),
    referralBound,
  };
}

export async function getPointsBalance(tgUserId: number): Promise<number> {
  const supabase = createServiceSupabaseClient();
  const pageSize = 1000;
  let offset = 0;
  let total = 0;

  for (;;) {
    const { data, error } = await supabase
      .from("loyalty_transactions")
      .select("delta_points")
      .eq("tg_user_id", tgUserId)
      .range(offset, offset + pageSize - 1);

    if (error) {
      throw new HttpError(500, "DB", `Failed to load points balance: ${error.message}`);
    }

    const rows = data ?? [];
    for (const row of rows) {
      const delta = Number((row as { delta_points?: unknown }).delta_points ?? 0);
      total += Number.isFinite(delta) ? delta : 0;
    }

    if (rows.length < pageSize) break;
    offset += rows.length;
  }

  return total;
}

export async function spendPointsForOrder(params: {
  tgUserId: number;
  orderId: string;
  pointsToSpend: number;
}): Promise<number> {
  const requested = Math.max(0, Math.trunc(params.pointsToSpend));
  if (requested <= 0) return 0;

  const balance = await getPointsBalance(params.tgUserId);
  if (balance < requested) {
    throw new HttpError(400, "NOT_ENOUGH_POINTS", "Not enough points");
  }

  const supabase = createServiceSupabaseClient();
  const { error } = await supabase.from("loyalty_transactions").insert({
    tg_user_id: params.tgUserId,
    delta_points: -requested,
    kind: ORDER_POINTS_SPEND_KIND,
    order_id: params.orderId,
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw new HttpError(500, "DB", `Failed to spend points: ${error.message}`);
  }

  return requested;
}

function mapInviteeStatus(params: {
  referralStatus: string;
  hasFirstOrder: boolean;
}): ReferralInviteeStatus {
  if (params.referralStatus === "rewarded") {
    return "first_order_done_rewarded";
  }
  if (params.hasFirstOrder) {
    return "first_order_created_not_paid";
  }
  return "joined_no_order";
}

export async function getReferralOverview(params: {
  tgUserId: number;
  tgUsername: string | null;
  startParam: string | null | undefined;
  limit: number;
  offset: number;
}): Promise<ReferralOverview> {
  const sanitizedLimit = Math.max(1, Math.min(params.limit, REFERRALS_MAX_PAGE_LIMIT));
  const sanitizedOffset = Math.max(0, params.offset);

  const bootstrap = await bootstrapReferralProfile({
    tgUserId: params.tgUserId,
    tgUsername: params.tgUsername,
    startParam: params.startParam,
  });

  const supabase = createServiceSupabaseClient();

  const [{ data: historyRows, error: historyError }, pointsBalance, referralRowsResponse] =
    await Promise.all([
      supabase
        .from("loyalty_transactions")
        .select("id,delta_points,kind,order_id,referral_id,created_at")
        .eq("tg_user_id", params.tgUserId)
        .order("created_at", { ascending: false })
        .limit(POINTS_HISTORY_LIMIT),
      getPointsBalance(params.tgUserId),
      supabase
        .from("referrals")
        .select("id,inviter_tg_user_id,invitee_tg_user_id,status,qualified_order_id,rewarded_at,created_at")
        .eq("inviter_tg_user_id", params.tgUserId)
        .order("created_at", { ascending: false })
        .range(sanitizedOffset, sanitizedOffset + sanitizedLimit),
    ]);

  if (historyError) {
    throw new HttpError(500, "DB", `Failed to load points history: ${historyError.message}`);
  }

  if (referralRowsResponse.error) {
    throw new HttpError(500, "DB", `Failed to load referrals list: ${referralRowsResponse.error.message}`);
  }

  const referralRowsRaw = (referralRowsResponse.data ?? []) as ReferralRow[];
  const hasMore = referralRowsRaw.length > sanitizedLimit;
  const referralRows = hasMore ? referralRowsRaw.slice(0, sanitizedLimit) : referralRowsRaw;

  const inviteeIds = Array.from(new Set(referralRows.map((row) => row.invitee_tg_user_id)));

  let inviteeProfiles: InviteeProfileRow[] = [];
  let inviteeOrders: InviteeFirstOrderRow[] = [];

  if (inviteeIds.length > 0) {
    const [{ data: profileRows, error: profilesError }, { data: orderRows, error: ordersError }] =
      await Promise.all([
        supabase
          .from("customer_profiles")
          .select("tg_user_id,tg_username")
          .in("tg_user_id", inviteeIds),
        supabase
          .from("orders")
          .select("id,tg_user_id,status,created_at")
          .in("tg_user_id", inviteeIds)
          .order("created_at", { ascending: true }),
      ]);

    if (profilesError) {
      throw new HttpError(500, "DB", `Failed to load invitee profiles: ${profilesError.message}`);
    }
    if (ordersError) {
      throw new HttpError(500, "DB", `Failed to load invitee orders: ${ordersError.message}`);
    }

    inviteeProfiles = (profileRows ?? []) as InviteeProfileRow[];
    inviteeOrders = (orderRows ?? []) as InviteeFirstOrderRow[];
  }

  const inviteeUsernameById = new Map<number, string | null>();
  for (const profile of inviteeProfiles) {
    inviteeUsernameById.set(profile.tg_user_id, profile.tg_username);
  }

  const firstOrderByInviteeId = new Map<number, InviteeFirstOrderRow>();
  for (const order of inviteeOrders) {
    if (!firstOrderByInviteeId.has(order.tg_user_id)) {
      firstOrderByInviteeId.set(order.tg_user_id, order);
    }
  }

  return {
    referralCode: bootstrap.referralCode,
    referralLink: bootstrap.referralLink,
    rewardPoints: {
      inviter: config.referrals.pointsInviter,
      invitee: config.referrals.pointsInvitee,
      minFirstOrderTotalRub: config.referrals.minFirstOrderTotalRub,
    },
    pointsBalance,
    pointsHistory: (historyRows ?? []).map((row) => ({
      id: row.id,
      deltaPoints: row.delta_points,
      kind: row.kind,
      orderId: row.order_id,
      referralId: row.referral_id,
      createdAt: row.created_at,
    })),
    referrals: referralRows.map((row) => {
      const firstOrder = firstOrderByInviteeId.get(row.invitee_tg_user_id) ?? null;
      return {
        id: row.id,
        inviteeTgUserId: row.invitee_tg_user_id,
        inviteeUsername: inviteeUsernameById.get(row.invitee_tg_user_id) ?? null,
        status: mapInviteeStatus({
          referralStatus: row.status,
          hasFirstOrder: firstOrder !== null,
        }),
        joinedAt: row.created_at,
        firstOrderId: firstOrder?.id ?? null,
        firstOrderStatus: firstOrder?.status ?? null,
        rewardedAt: row.rewarded_at,
      };
    }),
    pagination: {
      limit: sanitizedLimit,
      offset: sanitizedOffset,
      hasMore,
    },
  };
}

export async function processReferralRewardForOrderDone(params: {
  orderId: string;
}): Promise<{ awarded: boolean }> {
  const supabase = createServiceSupabaseClient();
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id,status,tg_user_id,created_at,total_price,total_after_discount")
    .eq("id", params.orderId)
    .maybeSingle();

  if (orderError) {
    throw new HttpError(500, "DB", `Failed to load order for referral reward: ${orderError.message}`);
  }
  if (!order) return { awarded: false };
  if (order.status !== "done") return { awarded: false };

  const effectiveTotal = numberFromUnknown(order.total_after_discount ?? order.total_price);
  if (effectiveTotal < config.referrals.minFirstOrderTotalRub) {
    return { awarded: false };
  }

  const { data: referral, error: referralError } = await supabase
    .from("referrals")
    .select("id,inviter_tg_user_id,invitee_tg_user_id,status")
    .eq("invitee_tg_user_id", order.tg_user_id)
    .maybeSingle();

  if (referralError) {
    throw new HttpError(500, "DB", `Failed to load referral row: ${referralError.message}`);
  }
  if (!referral) return { awarded: false };
  if (referral.status === "rewarded") return { awarded: false };

  const { data: inviteeOrders, error: inviteeOrdersError } = await supabase
    .from("orders")
    .select("id,status,created_at")
    .eq("tg_user_id", referral.invitee_tg_user_id)
    .order("created_at", { ascending: true })
    .limit(1);

  if (inviteeOrdersError) {
    throw new HttpError(500, "DB", `Failed to load invitee first order: ${inviteeOrdersError.message}`);
  }

  const firstOrder = inviteeOrders?.[0] ?? null;
  if (!firstOrder) return { awarded: false };
  if (firstOrder.id !== order.id) return { awarded: false };
  if (firstOrder.status !== "done") return { awarded: false };

  const nowIso = new Date().toISOString();
  const txRows = [
    {
      tg_user_id: referral.inviter_tg_user_id,
      delta_points: config.referrals.pointsInviter,
      kind: REFERRAL_INVITER_BONUS_KIND,
      referral_id: referral.id,
      order_id: order.id,
      created_at: nowIso,
    },
    {
      tg_user_id: referral.invitee_tg_user_id,
      delta_points: config.referrals.pointsInvitee,
      kind: REFERRAL_INVITEE_BONUS_KIND,
      referral_id: referral.id,
      order_id: order.id,
      created_at: nowIso,
    },
  ];

  const { error: txError } = await supabase.from("loyalty_transactions").insert(txRows);

  if (txError) {
    const duplicateCode = (txError as { code?: string } | null)?.code ?? "";
    // Idempotency: if bonus rows already exist, keep going and just sync referral status below.
    if (duplicateCode !== "23505") {
      throw new HttpError(500, "DB", `Failed to insert loyalty transactions: ${txError.message}`);
    }
  }

  const { error: referralUpdateError } = await supabase
    .from("referrals")
    .update({
      status: "rewarded",
      qualified_order_id: order.id,
      qualified_at: nowIso,
      rewarded_at: nowIso,
    })
    .eq("id", referral.id)
    .neq("status", "rewarded");

  if (referralUpdateError) {
    throw new HttpError(500, "DB", `Failed to update referral status: ${referralUpdateError.message}`);
  }

  return { awarded: true };
}
