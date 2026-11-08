import { LogIn, ShoppingBag, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useCustomerAuth } from "../auth/CustomerAuthProvider";
import { useTelegram } from "../telegram/TelegramProvider";
import { Button } from "./ui/button";
import { PasswordAuthCard } from "./PasswordAuthCard";

const GUEST_DISMISSED_SESSION_KEY = "vapeshop.website-auth-gate-dismissed";

function readGuestDismissal(): boolean {
  try {
    return window.sessionStorage.getItem(GUEST_DISMISSED_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function saveGuestDismissal(): void {
  try {
    window.sessionStorage.setItem(GUEST_DISMISSED_SESSION_KEY, "1");
  } catch {
    // Browsing still works when storage is unavailable or disabled.
  }
}

/**
 * Website visitors see a single, optional account prompt at the start of a
 * browser session. Telegram already supplies its own identity, so it never
 * sees this screen.
 */
export function WebsiteAuthGate() {
  const { isTelegram } = useTelegram();
  const { status, user } = useCustomerAuth();
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (isTelegram || status === "loading") {
      setReady(false);
      return;
    }

    // Do not ask again immediately after a person deliberately signs out.
    // They can use the card in Profile whenever they want to sign in again.
    if (user) {
      saveGuestDismissal();
      setDismissed(true);
      setReady(true);
      return;
    }

    setDismissed(readGuestDismissal());
    setReady(true);
  }, [isTelegram, status, user]);

  function continueAsGuest(): void {
    saveGuestDismissal();
    setDismissed(true);
  }

  if (isTelegram || !ready || user || dismissed) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex min-h-dvh items-center justify-center overflow-y-auto bg-background/95 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="website-auth-gate-title"
    >
      <div className="w-full max-w-sm space-y-4">
        <div className="px-2 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <ShoppingBag className="h-5 w-5" />
          </div>
          <h1 id="website-auth-gate-title" className="text-xl font-semibold tracking-tight">
            Добро пожаловать
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Войдите, чтобы сохранить бонусы и историю заказов.
          </p>
        </div>

        <PasswordAuthCard />

        <div className="space-y-2 px-1 pb-1 text-center">
          <Button
            type="button"
            variant="ghost"
            className="w-full text-muted-foreground"
            onClick={continueAsGuest}
          >
            <LogIn className="h-4 w-4" />
            Продолжить без аккаунта
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <UserRound className="h-3.5 w-3.5" />
            Аккаунт можно создать позже в профиле
          </p>
        </div>
      </div>
    </div>
  );
}
