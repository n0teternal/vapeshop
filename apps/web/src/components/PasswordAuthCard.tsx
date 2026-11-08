import { KeyRound, LogOut, UserPlus } from "lucide-react";
import { useState } from "react";
import { useCustomerAuth } from "../auth/CustomerAuthProvider";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

type Mode = "sign-in" | "sign-up";

export function PasswordAuthCard({ onSignedOut }: { onSignedOut?: () => void } = {}) {
  const { status, user, signIn, signUp, signOut } = useCustomerAuth();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordRepeat, setPasswordRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchMode(nextMode: Mode): void {
    setMode(nextMode);
    setPasswordRepeat("");
    setError(null);
  }

  async function submit(): Promise<void> {
    if (mode === "sign-up" && password !== passwordRepeat) {
      setError("Пароли не совпадают.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (mode === "sign-in") {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
      setPassword("");
      setPasswordRepeat("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось войти в аккаунт.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await signOut();
      onSignedOut?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось выйти из аккаунта.");
    } finally {
      setBusy(false);
    }
  }

  if (status === "loading") {
    return (
      <Card className="border-border/80 bg-card/90">
        <CardContent className="p-4 text-sm text-muted-foreground">Проверяем вход…</CardContent>
      </Card>
    );
  }

  if (status === "unavailable") {
    return (
      <Card className="border-border/80 bg-card/90">
        <CardContent className="p-4 text-sm text-muted-foreground">
          Вход в аккаунт сайта пока не настроен.
        </CardContent>
      </Card>
    );
  }

  if (user) {
    return (
      <Card className="border-border/80 bg-card/90">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-primary" />
            Аккаунт сайта
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{user.email}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Вход сохранён на этом устройстве
            </div>
          </div>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void handleSignOut()}>
            <LogOut className="h-4 w-4" />
            Выйти
          </Button>
        </CardContent>
        {error ? <div className="px-4 pb-4 text-xs text-destructive">{error}</div> : null}
      </Card>
    );
  }

  const isSignUp = mode === "sign-up";
  return (
    <Card className="border-border/80 bg-card/90">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {isSignUp ? <UserPlus className="h-4 w-4 text-primary" /> : <KeyRound className="h-4 w-4 text-primary" />}
          {isSignUp ? "Создать аккаунт" : "Войти в аккаунт"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-muted-foreground">
          Бонусы и история заказов будут доступны и вне Telegram.
        </div>
        <Input
          type="email"
          autoComplete={isSignUp ? "email" : "username"}
          value={email}
          disabled={busy}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Email"
          aria-label="Email"
        />
        <Input
          type="password"
          autoComplete={isSignUp ? "new-password" : "current-password"}
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isSignUp) void submit();
          }}
          placeholder="Пароль"
          aria-label="Пароль"
        />
        {isSignUp ? (
          <Input
            type="password"
            autoComplete="new-password"
            value={passwordRepeat}
            disabled={busy}
            onChange={(event) => setPasswordRepeat(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder="Повторите пароль"
            aria-label="Повторите пароль"
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={busy || !email.trim() || password.length < 8} onClick={() => void submit()}>
            {busy ? "Подождите…" : isSignUp ? "Создать" : "Войти"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => switchMode(isSignUp ? "sign-in" : "sign-up")}
          >
            {isSignUp ? "У меня уже есть аккаунт" : "Создать аккаунт"}
          </Button>
        </div>
        {isSignUp ? (
          <div className="text-xs text-muted-foreground">Минимум 8 символов. Запомните пароль: без отправки писем восстановить его нельзя.</div>
        ) : null}
        {error ? <div className="text-xs text-destructive">{error}</div> : null}
      </CardContent>
    </Card>
  );
}
