export function DevModeBanner() {
  return (
    <div className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto w-full max-w-md px-4 py-2 text-xs text-amber-900">
        DEV MODE: приложение открыто вне Telegram. Данные WebApp (initData) — мок, без подписи.
      </div>
    </div>
  );
}
