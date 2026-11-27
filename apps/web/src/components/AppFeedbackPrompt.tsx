import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { apiPost } from "../api/client";

type CitySlug = "blg" | "vvo";
type PromptState = "checking" | "ready" | "submitting" | "thanks" | "hidden";

type PromptResponse = {
  eligible: boolean;
};

export function AppFeedbackPrompt({
  citySlug,
  delayMs,
}: {
  citySlug: CitySlug;
  delayMs: number;
}) {
  const [state, setState] = useState<PromptState>("checking");

  useEffect(() => {
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void apiPost<PromptResponse>("/api/feedback/prompt", { citySlug })
        .then((result) => {
          if (!cancelled) setState(result.eligible ? "ready" : "hidden");
        })
        .catch(() => {
          if (!cancelled) setState("hidden");
        });
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [citySlug, delayMs]);

  const dismiss = () => {
    setState("hidden");
    void apiPost<{ dismissed: true }>("/api/feedback/dismiss", {}).catch(() => {
      // The prompt is already hidden locally; it should never block navigation.
    });
  };

  const submitRating = (rating: number) => {
    setState("submitting");
    void apiPost<{ submitted: true }>("/api/feedback", { citySlug, rating })
      .then(() => setState("thanks"))
      .catch(() => setState("hidden"));
  };

  if (state === "checking" || state === "hidden") return null;

  return (
    <div className="fixed inset-x-4 bottom-24 z-[70] mx-auto max-w-sm lg:bottom-6">
      <section
        className="rounded-2xl border border-border/85 bg-card/95 px-4 py-3.5 text-center shadow-[0_20px_48px_rgba(0,0,0,0.34)] backdrop-blur-xl"
        aria-label="Оценка приложения"
      >
        {state === "thanks" ? (
          <p className="text-sm text-muted-foreground">
            Спасибо — это поможет сделать приложение удобнее.
          </p>
        ) : (
          <>
            <p className="text-sm font-semibold text-foreground">Как вам приложение?</p>
            <div
              className="mt-2 flex items-center justify-center gap-1"
              role="group"
              aria-label="Оценка от 1 до 5"
            >
              {Array.from({ length: 5 }, (_, index) => {
                const rating = index + 1;
                return (
                  <button
                    key={rating}
                    type="button"
                    disabled={state === "submitting"}
                    className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-primary/10 hover:text-primary disabled:cursor-wait"
                    aria-label={`Поставить ${rating} из 5`}
                    onClick={() => submitRating(rating)}
                  >
                    <Star className="h-5 w-5" strokeWidth={1.8} />
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="mt-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
              onClick={dismiss}
              disabled={state === "submitting"}
            >
              Не сейчас
            </button>
          </>
        )}
      </section>
    </div>
  );
}
