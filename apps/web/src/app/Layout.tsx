import { NavLink, Outlet } from "react-router-dom";
import { DevModeBanner } from "../components/DevModeBanner";
import { useAppState } from "../state/AppStateProvider";
import { useTelegram } from "../telegram/TelegramProvider";

type TabIconProps = {
  active: boolean;
  badge?: number;
  photoUrl?: string | null;
};

function HomeIcon({ active }: TabIconProps) {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" aria-hidden="true">
      <path
        d="M4.75 10.4 12 4l7.25 6.4v8.1a1.5 1.5 0 0 1-1.5 1.5h-3.5v-6h-4.5v6h-3.5a1.5 1.5 0 0 1-1.5-1.5z"
        className={active ? "fill-[#2f80ff]" : "fill-slate-500"}
      />
    </svg>
  );
}

function HeartIcon({ active }: TabIconProps) {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" aria-hidden="true">
      <path
        d="M12 20.6c-.3 0-.6-.1-.8-.3l-1.3-1.1C6.1 16 4 14.1 4 11.5 4 9.3 5.7 7.6 7.9 7.6c1.3 0 2.5.6 3.3 1.5.8-.9 2-1.5 3.3-1.5 2.2 0 3.9 1.7 3.9 3.9 0 2.6-2.1 4.5-5.9 7.7l-1.3 1.1c-.2.2-.5.3-.8.3Z"
        className={active ? "fill-[#2f80ff]" : "fill-slate-500"}
      />
    </svg>
  );
}

function CartIcon({ active, badge }: TabIconProps) {
  return (
    <div className="relative">
      <svg viewBox="0 0 24 24" className="h-7 w-7" aria-hidden="true">
        <path
          d="M7 7.5A5 5 0 0 1 17 7.5v.5h1.2c.8 0 1.4.6 1.4 1.4L18.8 19A2 2 0 0 1 16.8 21H7.2a2 2 0 0 1-2-2L4.4 9.4c0-.8.6-1.4 1.4-1.4H7zm2 0V8h6v-.5a3 3 0 1 0-6 0"
          className={active ? "fill-[#2f80ff]" : "fill-slate-500"}
        />
      </svg>

      {badge && badge > 0 ? (
        <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-[#2f80ff] px-1 text-center text-[10px] font-bold leading-4 text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </div>
  );
}

function ProfileIcon({ active, photoUrl }: TabIconProps) {
  if (photoUrl) {
    return (
      <div
        className={[
          "h-7 w-7 overflow-hidden rounded-full border",
          active ? "border-[#2f80ff]" : "border-slate-500",
        ].join(" ")}
      >
        <img src={photoUrl} alt="Profile" className="h-full w-full object-cover" />
      </div>
    );
  }

  return (
    <div
      className={[
        "flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-bold",
        active
          ? "border-[#2f80ff] bg-[#2f80ff]/20 text-[#2f80ff]"
          : "border-slate-500 bg-slate-800 text-slate-400",
      ].join(" ")}
    >
      P
    </div>
  );
}

function tabClassName({ isActive }: { isActive: boolean }): string {
  return [
    "flex flex-col items-center justify-center gap-1 py-3 text-[11px] font-semibold transition-colors",
    isActive ? "text-[#2f80ff]" : "text-slate-500 hover:text-slate-300",
  ].join(" ");
}

export function Layout() {
  const { isTelegram, webApp } = useTelegram();
  const { cartCount } = useAppState();

  const photoUrl =
    typeof webApp.initDataUnsafe?.user?.photo_url === "string"
      ? webApp.initDataUnsafe.user.photo_url
      : null;

  return (
    <div className="min-h-screen bg-[#1f2328] text-slate-100">
      <header className="sticky top-0 z-20 bg-[#1f2328]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-md items-center justify-between px-4 py-3">
          <div className="text-base font-semibold">Mini App</div>
          {!isTelegram ? (
            <span className="rounded-full bg-amber-500/20 px-2 py-1 text-xs font-semibold text-amber-300">
              DEV MODE
            </span>
          ) : null}
        </div>
      </header>

      {!isTelegram ? <DevModeBanner /> : null}

      <main className="mx-auto w-full max-w-md px-4 pb-40 pt-4">
        <Outlet />
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-30 px-2 pb-2 [padding-bottom:calc(env(safe-area-inset-bottom,0px)+0.5rem)]">
        <div className="mx-auto w-full max-w-md rounded-[32px] border border-white/10 bg-[#1b1f24]/95 shadow-[0_-14px_44px_rgba(0,0,0,0.5)] backdrop-blur">
          <div className="grid grid-cols-4">
            <NavLink to="/" className={tabClassName} end>
              {({ isActive }) => (
                <>
                  <HomeIcon active={isActive} />
                  <span>Главная</span>
                </>
              )}
            </NavLink>

            <NavLink to="/favorites" className={tabClassName}>
              {({ isActive }) => (
                <>
                  <HeartIcon active={isActive} />
                  <span>Избранное</span>
                </>
              )}
            </NavLink>

            <NavLink to="/cart" className={tabClassName}>
              {({ isActive }) => (
                <>
                  <CartIcon active={isActive} badge={cartCount} />
                  <span>Корзина</span>
                </>
              )}
            </NavLink>

            <NavLink to="/profile" className={tabClassName}>
              {({ isActive }) => (
                <>
                  <ProfileIcon active={isActive} photoUrl={photoUrl} />
                  <span>Профиль</span>
                </>
              )}
            </NavLink>
          </div>
        </div>
      </nav>
    </div>
  );
}
