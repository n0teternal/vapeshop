import { ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, apiGet } from "../api/client";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { useTelegram } from "../telegram/TelegramProvider";

type AdminMe = {
  tgUserId: number;
  username: string | null;
  role: string;
};

export function ProfilePage() {
  const { webApp, isTelegram } = useTelegram();

  const [admin, setAdmin] = useState<AdminMe | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    apiGet<AdminMe>("/api/admin/me")
      .then((me) => {
        if (cancelled) return;
        setAdmin(me);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setAdmin(null);

        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          return;
        }

        setError(e instanceof Error ? e.message : "Не удалось проверить доступ");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const tgUser = webApp.initDataUnsafe?.user;

  const displayName = useMemo(() => {
    if (typeof tgUser?.username === "string" && tgUser.username.length > 0) {
      return `@${tgUser.username}`;
    }
    if (typeof tgUser?.first_name === "string" && tgUser.first_name.length > 0) {
      return tgUser.first_name;
    }
    return "Гость";
  }, [tgUser?.first_name, tgUser?.username]);

  const photoUrl =
    typeof tgUser?.photo_url === "string" && tgUser.photo_url.length > 0
      ? tgUser.photo_url
      : null;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Профиль</h2>

      <Card className="border-border/80 bg-card/90">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            {photoUrl ? (
              <img src={photoUrl} alt={displayName} className="h-14 w-14 rounded-full object-cover" />
            ) : (
              <div className="grid h-14 w-14 place-items-center rounded-full bg-primary/15 text-primary">
                <UserRound className="h-7 w-7" />
              </div>
            )}

            <div>
              <div className="text-base font-semibold">{displayName}</div>
              <div className="text-xs text-muted-foreground">
                {typeof tgUser?.id === "number" ? `ID: ${tgUser.id}` : "Telegram user"}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {admin ? (
        <Card className="border-border/80 bg-card/90">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Админ-доступ</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Badge variant="success" className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              {admin.username ? `@${admin.username}` : admin.tgUserId} ({admin.role})
            </Badge>
            <div>
              <Button asChild>
                <Link to="/admin">Открыть админку</Link>
              </Button>
            </div>

            {error ? <div className="text-xs text-destructive">{error}</div> : null}
            {!isTelegram ? (
              <div className="text-xs text-muted-foreground">
                Для корректной проверки открывайте мини-приложение из Telegram.
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
