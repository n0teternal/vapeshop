import { NavLink, Outlet } from "react-router-dom";
import { DevModeBanner } from "../components/DevModeBanner";
import { useAppState } from "../state/AppStateProvider";
import { useTelegram } from "../telegram/TelegramProvider";

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return [
    "flex flex-col items-center justify-center gap-1 py-3 text-xs font-medium",
    isActive ? "text-indigo-600" : "text-slate-600 hover:text-slate-900",
  ].join(" ");
}

export function Layout() {
  const { isTelegram } = useTelegram();
  const { cartCount } = useAppState();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-md items-center justify-between px-4 py-3">
          <div className="text-base font-semibold">Mini App</div>
          {!isTelegram ? (
            <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">
              DEV MODE
            </span>
          ) : null}
        </div>
      </header>

      {!isTelegram ? <DevModeBanner /> : null}

      <main className="mx-auto w-full max-w-md px-4 pb-24 pt-4">
        <Outlet />
      </main>

      <nav className="fixed bottom-0 left-0 right-0 border-t border-slate-200 bg-white">
        <div className="mx-auto grid w-full max-w-md grid-cols-3">
          <NavLink to="/" className={navLinkClassName} end>
            <span>Каталог</span>
          </NavLink>
          <NavLink to="/cart" className={navLinkClassName}>
            <span>Корзина</span>
            {cartCount > 0 ? (
              <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                {cartCount}
              </span>
            ) : null}
          </NavLink>
          <NavLink to="/admin" className={navLinkClassName}>
            <span>Админ</span>
          </NavLink>
        </div>
      </nav>
    </div>
  );
}

