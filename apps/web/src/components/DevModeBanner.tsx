import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

export function DevModeBanner() {
  return (
    <div className="mx-auto mt-3 w-full max-w-md px-4">
      <Alert className="border-amber-400/45 bg-amber-500/14 text-amber-50">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle className="text-[13px] text-amber-50">DEV MODE</AlertTitle>
        <AlertDescription className="text-[12px] text-amber-100">
          Приложение открыто вне Telegram. `initData` используется в режиме разработки.
          {import.meta.env.DEV ? (
            <span className="mt-1 block text-[11px] text-amber-100/95">
              Если видите ошибку schema cache (PGRST205), выполните `supabase/schema.sql`,
              `supabase/seed.sql`, затем `notify pgrst, 'reload schema';`.
            </span>
          ) : null}
        </AlertDescription>
      </Alert>
    </div>
  );
}
