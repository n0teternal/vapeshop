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
  | "isFullscreen"
  | "onEvent"
  | "offEvent"
  | "setHeaderColor"
  | "setBackgroundColor"
  | "ready"
  | "expand"
  | "isVersionAtLeast"
  | "requestFullscreen"
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
  return {
    initData: "",
    initDataUnsafe: createMockInitDataUnsafe(),
    platform: "unknown",
    version: "dev",
    colorScheme: "dark",
    isFullscreen: false,
    onEvent: () => undefined,
    offEvent: () => undefined,
    setHeaderColor: () => undefined,
    setBackgroundColor: () => undefined,
    ready: () => undefined,
    expand: () => undefined,
    isVersionAtLeast: () => false,
    requestFullscreen: () => undefined,
    close: () => undefined,
    showAlert: () => undefined,
    showPopup: () => undefined,
  };
}

function isDesktopTelegram(platform: TelegramWebAppLike["platform"]): boolean {
  return platform === "tdesktop" || platform === "macos" || platform === "unigram";
}

function applyThemeToDocument(): void {
  if (typeof document === "undefined") return;

  const fixedScheme = "dark";
  document.documentElement.dataset.theme = fixedScheme;
  document.documentElement.style.colorScheme = fixedScheme;
}

function clearDocumentTheme(): void {
  if (typeof document === "undefined") return;

  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("color-scheme");
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

    let frameId: number | undefined;
    let retryId: number | undefined;
    let fullscreenRequested = false;

    const expand = () => {
      try {
        webApp.expand();
      } catch {
        // ignore
      }
    };

    const requestDesktopFullscreen = () => {
      if (
        fullscreenRequested ||
        webApp.isFullscreen ||
        !isDesktopTelegram(webApp.platform) ||
        !webApp.isVersionAtLeast("8.0")
      ) {
        return;
      }

      try {
        fullscreenRequested = true;
        webApp.requestFullscreen();
      } catch {
        // An older Desktop client can expose the bridge without supporting
        // fullscreen. It will still use its normal maximized Mini App view.
      }
    };

    const syncViewport = () => {
      expand();
      requestDesktopFullscreen();
    };

    const onViewportChanged = ({ isStateStable }: { isStateStable: boolean }) => {
      if (isStateStable) {
        frameId = window.requestAnimationFrame(syncViewport);
      }
    };

    try {
      webApp.ready();
      syncViewport();

      // Telegram can report the initial viewport before Desktop finishes
      // opening the Mini App window. Sync once more on the next frame and
      // after its first layout pass.
      frameId = window.requestAnimationFrame(syncViewport);
      retryId = window.setTimeout(syncViewport, 250);
      webApp.onEvent("viewportChanged", onViewportChanged);
    } catch {
      // ignore
    }

    return () => {
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      if (retryId !== undefined) window.clearTimeout(retryId);
      webApp.offEvent("viewportChanged", onViewportChanged);
    };
  }, [isTelegram, webApp]);

  useEffect(() => {
    if (!isTelegram) {
      clearDocumentTheme();
      return;
    }

    const syncTheme = () => {
      applyThemeToDocument();

      try {
        webApp.setHeaderColor("secondary_bg_color");
        webApp.setBackgroundColor("#111827");
      } catch {
        // ignore
      }
    };

    syncTheme();
    webApp.onEvent("themeChanged", syncTheme);

    return () => {
      webApp.offEvent("themeChanged", syncTheme);
    };
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
