import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiPost } from "../api/client";
import { supabase } from "../supabase/client";
import { useTelegram } from "../telegram/TelegramProvider";

type AuthStatus = "loading" | "anonymous" | "authenticated" | "unavailable";

export type WebsiteCustomer = {
  id: string;
  email: string;
};

type CustomerAuthContextValue = {
  status: AuthStatus;
  user: WebsiteCustomer | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const CustomerAuthContext = createContext<CustomerAuthContextValue | null>(null);

function normalizeEmail(rawEmail: string): string {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Введите корректный email.");
  }
  return email;
}

function assertPassword(password: string): void {
  if (password.length < 8) {
    throw new Error("Пароль должен содержать минимум 8 символов.");
  }
}

function toWebsiteCustomer(user: { id: string; email?: string | null } | null): WebsiteCustomer | null {
  const email = user?.email?.trim().toLowerCase();
  if (!user || !email) return null;
  return { id: user.id, email };
}

async function bootstrapWebsiteCustomer(): Promise<void> {
  await apiPost<{ source: string; email: string | null }>("/api/auth/bootstrap", {});
}

export function CustomerAuthProvider({ children }: { children: ReactNode }) {
  const { isTelegram } = useTelegram();
  const [status, setStatus] = useState<AuthStatus>(() =>
    isTelegram ? "anonymous" : supabase ? "loading" : "unavailable",
  );
  const [user, setUser] = useState<WebsiteCustomer | null>(null);

  useEffect(() => {
    if (isTelegram) {
      setUser(null);
      setStatus("anonymous");
      return;
    }
    if (!supabase) {
      setUser(null);
      setStatus("unavailable");
      return;
    }

    let active = true;
    const applyUser = (nextUser: { id: string; email?: string | null } | null) => {
      if (!active) return;
      const websiteCustomer = toWebsiteCustomer(nextUser);
      setUser(websiteCustomer);
      setStatus(websiteCustomer ? "authenticated" : "anonymous");
    };

    void supabase.auth
      .getSession()
      .then(({ data }) => applyUser(data.session?.user ?? null))
      .catch(() => {
        if (active) {
          setUser(null);
          setStatus("anonymous");
        }
      });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      applyUser(session?.user ?? null);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [isTelegram]);

  const value = useMemo<CustomerAuthContextValue>(
    () => ({
      status,
      user,
      async signIn(rawEmail: string, password: string): Promise<void> {
        if (isTelegram) throw new Error("В Telegram вход уже выполнен.");
        if (!supabase) throw new Error("Вход в аккаунт сайта пока не настроен.");

        const email = normalizeEmail(rawEmail);
        assertPassword(password);
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error || !data.session) {
          throw new Error(error?.message ?? "Неверный email или пароль.");
        }
        await bootstrapWebsiteCustomer();
      },
      async signUp(rawEmail: string, password: string): Promise<void> {
        if (isTelegram) throw new Error("В Telegram вход уже выполнен.");
        if (!supabase) throw new Error("Вход в аккаунт сайта пока не настроен.");

        const email = normalizeEmail(rawEmail);
        assertPassword(password);
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw new Error(error.message);
        if (!data.session) {
          throw new Error(
            "Не удалось войти после регистрации. Отключите Confirm email в настройках Supabase или войдите в существующий аккаунт.",
          );
        }
        await bootstrapWebsiteCustomer();
      },
      async signOut(): Promise<void> {
        if (!supabase) return;
        const { error } = await supabase.auth.signOut({ scope: "local" });
        if (error) throw new Error(error.message);
        setUser(null);
        setStatus("anonymous");
      },
    }),
    [isTelegram, status, user],
  );

  return <CustomerAuthContext.Provider value={value}>{children}</CustomerAuthContext.Provider>;
}

export function useCustomerAuth(): CustomerAuthContextValue {
  const context = useContext(CustomerAuthContext);
  if (!context) {
    throw new Error("useCustomerAuth must be used within CustomerAuthProvider");
  }
  return context;
}
