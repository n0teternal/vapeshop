import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, apiGet } from "../api/client";
import { useTelegram } from "../telegram/TelegramProvider";

type AdminMe = {
  tgUserId: number;
  username: string | null;
  role: string;
};

export function ProfilePage() {
  const { webApp, isTelegram } = useTelegram();

  const [admin, setAdmin] = useState<AdminMe | null>(null);
  const [checkingAdmin, setCheckingAdmin] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setCheckingAdmin(true);
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
      })
      .finally(() => {
        if (cancelled) return;
        setCheckingAdmin(false);
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
      <div className="text-lg font-semibold">Профиль</div>

      <div className="rounded-2xl border border-white/10 bg-[#252a31] p-4">
        <div className="flex items-center gap-3">
          {photoUrl ? (
            <img src={photoUrl} alt={displayName} className="h-12 w-12 rounded-full object-cover" />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-700 text-sm font-bold">
              {displayName.slice(1, 2).toUpperCase() || "U"}
            </div>
          )}

          <div>
            <div className="text-sm font-semibold text-slate-100">{displayName}</div>
            <div className="text-xs text-slate-400">
              {typeof tgUser?.id === "number" ? `ID: ${tgUser.id}` : "Telegram user"}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-[#252a31] p-4">
        <div className="text-sm font-semibold text-slate-100">Админ-доступ</div>

        {checkingAdmin ? (
          <div className="mt-3 h-10 animate-pulse rounded-xl bg-slate-700/60" />
        ) : admin ? (
          <div className="mt-3 space-y-3">
            <div className="text-xs text-emerald-300">
              Доступ разрешен: {admin.username ? `@${admin.username}` : admin.tgUserId} ({admin.role})
            </div>
            <Link
              to="/admin"
              className="inline-flex rounded-xl bg-[#2f80ff] px-4 py-2 text-sm font-semibold text-white hover:bg-[#2370e3]"
            >
              Открыть админку
            </Link>
          </div>
        ) : (
          <div className="mt-3 text-sm text-slate-400">Доступ к админке только для администраторов.</div>
        )}

        {error ? <div className="mt-3 text-xs text-rose-300">{error}</div> : null}
        {!isTelegram ? (
          <div className="mt-3 text-xs text-slate-500">
            Для корректной проверки открывайте мини-приложение из Telegram.
          </div>
        ) : null}
      </div>
    </div>
  );
}
