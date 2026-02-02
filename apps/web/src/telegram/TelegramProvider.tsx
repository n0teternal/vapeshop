import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import type { WebApp, WebAppInitData } from "@twa-dev/types";

export type TelegramWebAppLike = Pick<
  WebApp,
  | "initData"
  | "initDataUnsafe"
  | "platform"
  | "version"
  | "colorScheme"
  | "ready"
  | "expand"
  | "close"
  | "showAlert"
  | "showPopup"
>;

type TelegramContextValue = {
  isTelegram: boolean;
  webApp: TelegramWebAppLike;
};

const TelegramContext = createContext<TelegramContextValue | null>(null);

function getIsTelegram(webApp: WebApp | undefined): boolean {
  return Boolean(webApp?.initData);
}

function createMockInitDataUnsafe(): WebAppInitData {
  const now = Math.floor(Date.now() / 1000);
  return {
    auth_date: now,
    hash: "",
    signature: "",
    user: {
      id: 42,
      first_name: "Dev",
      username: "dev_mode",
      language_code: "ru",
    },
    start_param: "dev",
  };
}

function createMockWebApp(): TelegramWebAppLike {
  const colorScheme =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";

  return {
    initData: "",
    initDataUnsafe: createMockInitDataUnsafe(),
    platform: "unknown",
    version: "dev",
    colorScheme,
    ready: () => undefined,
    expand: () => undefined,
    close: () => undefined,
    showAlert: () => undefined,
    showPopup: () => undefined,
  };
}

export function TelegramProvider({ children }: { children: ReactNode }) {
  const webAppFromWindow: WebApp | undefined =
    typeof window !== "undefined" ? window.Telegram?.WebApp : undefined;
  const isTelegram = getIsTelegram(webAppFromWindow);

  const mockWebApp = useMemo(() => createMockWebApp(), []);

  const webApp: TelegramWebAppLike = isTelegram
    ? (webAppFromWindow as TelegramWebAppLike)
    : mockWebApp;

  useEffect(() => {
    if (!isTelegram) return;
    try {
      webApp.ready();
      webApp.expand();
    } catch {
      // ignore
    }
  }, [isTelegram, webApp]);

  const value = useMemo<TelegramContextValue>(() => {
    return { isTelegram, webApp };
  }, [isTelegram, webApp]);

  return (
    <TelegramContext.Provider value={value}>
      {children}
    </TelegramContext.Provider>
  );
}

export function useTelegram(): TelegramContextValue {
  const ctx = useContext(TelegramContext);
  if (!ctx) {
    throw new Error("useTelegram must be used within TelegramProvider");
  }
  return ctx;
}
