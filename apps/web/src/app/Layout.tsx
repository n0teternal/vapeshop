import { useEffect, useState, type ReactNode } from "react";
import { BadgePercent, Heart, Home, ShoppingBag, UserRound } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { apiDelete } from "../api/client";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import {
  getOrderEditRemainingMs,
  useAppState,
} from "../state/AppStateProvider";
import { useTelegram } from "../telegram/TelegramProvider";

type TabLinkProps = {
  to: string;
  label: string;
  badge?: number;
  end?: boolean;
  icon: (isActive: boolean, photoUrl: string | null) => ReactNode;
  photoUrl: string | null;
};

function TabLink({ to, label, badge, end, icon, photoUrl }: TabLinkProps) {
  return (
    <NavLink to={to} end={end} className="group min-w-0">
      {({ isActive }) => (
        <span
          className={cn(
            "flex min-h-[58px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[10px] font-semibold leading-tight transition-colors sm:px-2 sm:text-[11px]",
            isActive
              ? "bg-primary/12 text-primary"
              : "text-muted-foreground hover:bg-accent/55 hover:text-foreground",
          )}
        >
          <span className="relative">
            {icon(isActive, photoUrl)}
            {badge && badge > 0 ? (
              <span className="absolute -right-2.5 -top-2 min-w-5 rounded-full bg-primary px-1 text-center text-[10px] font-bold leading-5 text-primary-foreground shadow-glow">
                {badge > 99 ? "99+" : badge}
              </span>
            ) : null}
          </span>
          <span className="max-w-full truncate">{label}</span>
        </span>
      )}
    </NavLink>
  );
}

export function Layout() {
  const { webApp } = useTelegram();
  const { state, dispatch, cartCount, favoritesCount } = useAppState();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [exitingEditMode, setExitingEditMode] = useState(false);

  const photoUrl =
    typeof webApp.initDataUnsafe?.user?.photo_url === "string"
      ? webApp.initDataUnsafe.user.photo_url
      : null;
  const orderEditSession = state.orderEditSession;

  useEffect(() => {
    if (!orderEditSession) return;

    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [orderEditSession]);

  const remainingMs = orderEditSession
    ? getOrderEditRemainingMs(orderEditSession, nowMs)
    : 0;
  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  const editModeExpired = orderEditSession ? remainingMs <= 0 : false;

  async function handleExitEditMode(): Promise<void> {
    const session = orderEditSession;
    if (!session) return;

    setExitingEditMode(true);
    try {
      await apiDelete(`/api/orders/${session.orderId}/edit-session`);
    } catch {
      // Keep local exit resilient even if backend cleanup fails.
    } finally {
      dispatch({ type: "order-edit/cancel" });
      setExitingEditMode(false);
    }
  }

  return (
    <div className="relative min-h-screen text-foreground">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -top-[22vh] left-[-24vw] h-[64vh] w-[94vw] rounded-full bg-accent/38 blur-[92px]" />
        <div className="absolute top-[16vh] left-[-18vw] h-[24vh] w-[140vw] bg-primary/12 blur-[84px]" />
        <div className="absolute -top-[14vh] right-[-12vw] h-[48vh] w-[72vw] rounded-full bg-primary/20 blur-[96px]" />
      </div>

      <div className="relative z-10">
        <header className="sticky top-0 z-30 border-b border-border/70 bg-background/78 backdrop-blur-xl">
          <div className="mx-auto flex w-full max-w-md items-center justify-between px-4 py-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground/80">
                Telegram Mini App
              </div>
              <div className="mt-1 text-lg font-semibold leading-none">Mini Market</div>
            </div>
          </div>
        </header>

        {orderEditSession ? (
          <div className="sticky top-[69px] z-20 border-b border-amber-500/25 bg-amber-500/10 backdrop-blur-xl">
            <div className="mx-auto flex w-full max-w-md items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white">
                  {editModeExpired
                    ? "Режим редактирования заказа истёк"
                    : `Включен режим редактирования, осталось минут: ${remainingMinutes}`}
                </div>
                <div className="mt-1 text-xs text-white/80">
                  {editModeExpired
                    ? "Можно выйти из режима и запустить редактирование заново из управления заказами."
                    : "Изменения применятся только после повторного оформления заказа."}
                </div>
              </div>

              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 border-amber-950/20 bg-white/70 text-amber-950 hover:bg-white"
                disabled={exitingEditMode}
                onClick={() => void handleExitEditMode()}
              >
                {exitingEditMode ? "Выходим..." : "Выйти"}
              </Button>
            </div>
          </div>
        ) : null}

        <main className="mx-auto w-full max-w-md px-4 pb-[8.6rem] pt-5">
          <Outlet />
        </main>

        <nav className="fixed inset-x-0 bottom-0 z-40 px-2 pb-1 [padding-bottom:calc(env(safe-area-inset-bottom,0px)+0.35rem)]">
          <div className="mx-auto w-full max-w-md rounded-[2rem] border border-border/70 bg-card/78 px-2 py-1 shadow-[0_-14px_45px_-24px_rgba(15,23,42,0.65)] backdrop-blur-xl">
            <div className="grid grid-cols-5 gap-1">
              <TabLink
                to="/"
                end
                label="Каталог"
                photoUrl={photoUrl}
                icon={(isActive) => (
                  <Home
                    className={cn("h-5 w-5", isActive ? "text-primary" : "text-muted-foreground")}
                    strokeWidth={2.2}
                  />
                )}
              />
              <TabLink
                to="/promos"
                label={"\u0410\u043a\u0446\u0438\u0438"}
                photoUrl={photoUrl}
                icon={(isActive) => (
                  <BadgePercent
                    className={cn("h-5 w-5", isActive ? "text-primary" : "text-muted-foreground")}
                    strokeWidth={2.2}
                  />
                )}
              />
              <TabLink
                to="/favorites"
                label="Избранное"
                badge={favoritesCount}
                photoUrl={photoUrl}
                icon={(isActive) => (
                  <Heart
                    className={cn("h-5 w-5", isActive ? "fill-primary text-primary" : "text-muted-foreground")}
                    strokeWidth={2.2}
                  />
                )}
              />
              <TabLink
                to="/cart"
                label="Корзина"
                badge={cartCount}
                photoUrl={photoUrl}
                icon={(isActive) => (
                  <ShoppingBag
                    className={cn("h-5 w-5", isActive ? "text-primary" : "text-muted-foreground")}
                    strokeWidth={2.2}
                  />
                )}
              />
              <TabLink
                to="/profile"
                label="Профиль"
                photoUrl={photoUrl}
                icon={(isActive, navPhotoUrl) =>
                  navPhotoUrl ? (
                    <span
                      className={cn(
                        "block h-6 w-6 overflow-hidden rounded-full border",
                        isActive ? "border-primary" : "border-border",
                      )}
                    >
                      <img
                        src={navPhotoUrl}
                        alt="Profile"
                        className="h-full w-full object-cover"
                      />
                    </span>
                  ) : (
                    <UserRound
                      className={cn("h-5 w-5", isActive ? "text-primary" : "text-muted-foreground")}
                      strokeWidth={2.2}
                    />
                  )
                }
              />
            </div>
          </div>
        </nav>
      </div>
    </div>
  );
}
