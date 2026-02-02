export function DevModeBanner() {
  return (
    <div className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto w-full max-w-md px-4 py-2 text-xs text-amber-900">
        DEV MODE: приложение открыто вне Telegram. Данные WebApp (initData) — мок, без подписи.
        {import.meta.env.DEV ? (
          <div className="mt-1 text-[11px] text-amber-800">
            Если каталог не грузится и видите ошибку “schema cache” (PGRST205): выполните{" "}
            <span className="font-mono">supabase/schema.sql</span> и{" "}
            <span className="font-mono">supabase/seed.sql</span> в Supabase SQL Editor, затем{" "}
            <span className="font-mono">notify pgrst, 'reload schema';</span>.
          </div>
        ) : null}
      </div>
    </div>
  );
}
