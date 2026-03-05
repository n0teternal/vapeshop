import { UserPlus } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, apiGet } from "../api/client";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { useTelegram } from "../telegram/TelegramProvider";

type ReferralStatus =
  | "joined_no_order"
  | "first_order_created_not_paid"
  | "first_order_done_rewarded";

type ReferralOverview = {
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
    status: ReferralStatus;
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

type ShareCapableWebApp = {
  openTelegramLink?: (url: string) => void;
};

const PAGE_SIZE = 20;

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function statusLabel(status: ReferralStatus): string {
  if (status === "joined_no_order") return "Присоединился, заказа нет";
  if (status === "first_order_created_not_paid") return "Первый заказ создан, не оплачен";
  return "Первый заказ done, бонус начислен обоим";
}

function statusVariant(status: ReferralStatus): "secondary" | "warning" | "success" {
  if (status === "joined_no_order") return "secondary";
  if (status === "first_order_created_not_paid") return "warning";
  return "success";
}

function pointsKindLabel(kind: string): string {
  if (kind === "referral_inviter_bonus") return "Бонус за приглашенного";
  if (kind === "referral_invitee_bonus") return "Бонус за первый заказ";
  if (kind === "order_points_spend") return "Списание баллов";
  return kind;
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function buildTelegramShareUrl(referralLink: string): string {
  const text = "\nРады видеть тебя в магазине SDFG!";
  return `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(text)}`;
}

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
}

export function ReferralPage() {
  const { webApp } = useTelegram();
  const [copyState, setCopyState] = useState<"idle" | "ok" | "error">("idle");

  const overviewQuery = useInfiniteQuery({
    queryKey: ["referrals-overview"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiGet<ReferralOverview>(`/api/referrals/overview?limit=${PAGE_SIZE}&offset=${pageParam}`),
    getNextPageParam: (lastPage) =>
      lastPage.pagination.hasMore
        ? lastPage.pagination.offset + lastPage.pagination.limit
        : undefined,
  });

  const firstPage = overviewQuery.data?.pages[0] ?? null;
  const referralRows = useMemo(
    () => overviewQuery.data?.pages.flatMap((page) => page.referrals) ?? [],
    [overviewQuery.data?.pages],
  );

  const errorMessage = useMemo(() => {
    if (!overviewQuery.error) return null;
    const err = overviewQuery.error;
    if (err instanceof ApiError) {
      if (err.code === "TG_INIT_DATA_REQUIRED") {
        return "Откройте рефералку внутри Telegram Mini App.";
      }
      if (err.code === "NOT_FOUND") {
        return "Раздел недоступен.";
      }
    }
    return err instanceof Error ? err.message : "Не удалось загрузить рефералку";
  }, [overviewQuery.error]);

  async function handleCopy(link: string): Promise<void> {
    try {
      await copyToClipboard(link);
      setCopyState("ok");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  }

  function handleInvite(link: string): void {
    const shareUrl = buildTelegramShareUrl(link);
    const maybeShareWebApp = webApp as ShareCapableWebApp;

    if (typeof maybeShareWebApp.openTelegramLink === "function") {
      maybeShareWebApp.openTelegramLink(shareUrl);
      return;
    }

    window.open(shareUrl, "_blank", "noopener,noreferrer");
  }

  if (overviewQuery.isPending && !firstPage) {
    return (
      <Card className="border-border/80 bg-card/90">
        <CardContent className="p-5 text-sm text-muted-foreground">Загружаем рефералку…</CardContent>
      </Card>
    );
  }

  if (errorMessage && !firstPage) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
        <Button asChild variant="outline">
          <Link to="/profile">Назад в профиль</Link>
        </Button>
      </div>
    );
  }

  if (!firstPage) {
    return null;
  }

  const hasPublicReferralLink = isAbsoluteHttpUrl(firstPage.referralLink);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Рефералка</h2>
        <Badge variant="secondary">Код: {firstPage.referralCode}</Badge>
      </div>

      <Card className="border-primary/60 bg-primary/10">
        <CardContent className="p-4">
          <div className="text-sm font-semibold leading-6 text-foreground">
            Если приглашенный оформит заказ от{" "}
            <span className="text-primary">1200 ₽</span> и оплатит его (статус{" "}
            <span className="text-primary">done</span>):{" "}
            <span className="text-primary">+100</span> пригласившему,{" "}
            <span className="text-primary">+100</span> приглашенному.
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/90">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Ваш баланс</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-2xl font-bold">{firstPage.pointsBalance} баллов</div>

          <div className="rounded-xl border border-border/70 bg-background p-3 text-xs">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void handleCopy(firstPage.referralLink)}
              >
                {copyState === "ok"
                  ? "Скопировано"
                  : copyState === "error"
                    ? "Ошибка копирования"
                    : "Скопировать ссылку"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="inline-flex items-center gap-2"
                disabled={!hasPublicReferralLink}
                onClick={() => handleInvite(firstPage.referralLink)}
              >
                <UserPlus className="h-4 w-4" />
                Пригласить реферала
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/90">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">История баллов</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {firstPage.pointsHistory.length === 0 ? (
            <div className="text-sm text-muted-foreground">Пока нет операций.</div>
          ) : (
            firstPage.pointsHistory.map((row) => (
              <div
                key={row.id}
                className="flex items-center justify-between rounded-xl border border-border/70 bg-background/70 px-3 py-2"
              >
                <div>
                  <div className="text-sm font-medium">{pointsKindLabel(row.kind)}</div>
                  <div className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</div>
                </div>
                <div className={row.deltaPoints >= 0 ? "text-emerald-500" : "text-rose-500"}>
                  {row.deltaPoints >= 0 ? "+" : ""}
                  {row.deltaPoints}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/90">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Ваши приглашенные</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {referralRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">Пока никто не присоединился.</div>
          ) : (
            referralRows.map((row) => (
              <div
                key={row.id}
                className="rounded-xl border border-border/70 bg-background/70 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold">
                    {row.inviteeUsername ? `@${row.inviteeUsername}` : `ID ${row.inviteeTgUserId}`}
                  </div>
                  <Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Присоединился: {formatDate(row.joinedAt)}
                </div>
              </div>
            ))
          )}

          {overviewQuery.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={overviewQuery.isFetchingNextPage}
              onClick={() => void overviewQuery.fetchNextPage()}
            >
              {overviewQuery.isFetchingNextPage ? "Загружаем…" : "Показать ещё"}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {errorMessage ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
