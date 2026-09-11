import { Fragment, useState } from "react";

type ProfileStatusBandProps = {
  pointsBalance: number | null;
  pointsNextExpiresAt: string | null;
  totalSpent: number | null;
  cashbackLevel: number | null;
};

type StatusTier = {
  name: string;
  cashbackRate: string;
  className: string;
};

const STATUS_TIERS: StatusTier[] = [
  { name: "Пока без кэшбека", cashbackRate: "0%", className: "loyalty-band--locked" },
  { name: "Базовый", cashbackRate: "3%", className: "loyalty-band--bronze" },
  { name: "Продвинутый", cashbackRate: "5%", className: "loyalty-band--silver" },
  { name: "VIP", cashbackRate: "7%", className: "loyalty-band--gold" },
];

function formatPointsBalance(value: number | null): string {
  if (value === null) return "—";
  return `${new Intl.NumberFormat("ru-RU").format(value)} ₽`;
}

function formatExpiryDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(date);
}

function formatRub(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value)} ₽`;
}

function resolveTierIndex(cashbackLevel: number | null): number {
  if (cashbackLevel === null) return 0;
  if (cashbackLevel >= 7) return 3;
  if (cashbackLevel >= 5) return 2;
  if (cashbackLevel >= 3) return 1;
  return 0;
}

function getProgress(totalSpent: number | null, tierIndex: number): { label: string; value: number } {
  if (totalSpent === null) return { label: "Загружаем статус…", value: 0 };

  const spent = Math.max(0, totalSpent);
  if (tierIndex === 0) {
    return {
      label: `До 3% осталось ${formatRub(Math.max(0, 3_000 - spent))}`,
      value: Math.min(100, (spent / 3_000) * 100),
    };
  }
  if (tierIndex === 1) {
    return {
      label: `До 5% осталось ${formatRub(Math.max(0, 5_000 - spent))}`,
      value: Math.min(100, ((spent - 3_000) / 2_000) * 100),
    };
  }
  if (tierIndex === 2) {
    return {
      label: `До 7% осталось ${formatRub(Math.max(0, 10_000 - spent))}`,
      value: Math.min(100, ((spent - 5_000) / 5_000) * 100),
    };
  }
  return { label: "Максимальный статус", value: 100 };
}

export function ProfileStatusBand({
  pointsBalance,
  pointsNextExpiresAt,
  totalSpent,
  cashbackLevel,
}: ProfileStatusBandProps) {
  const currentTierIndex = resolveTierIndex(cashbackLevel);
  const [previewTierIndex, setPreviewTierIndex] = useState<number | null>(null);
  const [isChanging, setIsChanging] = useState(false);
  const tierIndex = previewTierIndex ?? currentTierIndex;
  const tier = STATUS_TIERS[tierIndex];
  const currentTier = STATUS_TIERS[currentTierIndex];
  const isLocked = tierIndex === 0;
  const expiryDate = formatExpiryDate(pointsNextExpiresAt);
  const currentProgress = getProgress(totalSpent, currentTierIndex);
  const progress = previewTierIndex === null
    ? currentProgress
    : {
      label: `Просмотр ${tier.cashbackRate}. Ваш текущий уровень: ${currentTier.cashbackRate}`,
      value: currentProgress.value,
    };
  const statusClassName = tier.className.replace("loyalty-band", "loyalty-status");

  function showNextTier(): void {
    if (isChanging) return;

    setPreviewTierIndex((currentPreview) => {
      const current = currentPreview ?? currentTierIndex;
      const next = (current + 1) % STATUS_TIERS.length;
      return next === currentTierIndex ? null : next;
    });
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIsChanging(true);
    }
  }

  return (
    <section
      className={`loyalty-status loyalty-status--embedded ${statusClassName}`}
      aria-label="Статус Smoke Diller"
    >
      <button
        type="button"
        className={`loyalty-band ${tier.className}${isChanging ? " loyalty-band--changing" : ""}`}
        onClick={showNextTier}
        onAnimationEnd={() => setIsChanging(false)}
        aria-label={
          previewTierIndex === null
            ? `Ваш статус ${tier.name}: ${tier.cashbackRate}. Нажмите, чтобы посмотреть уровни.`
            : `Просмотр уровня ${tier.name}: ${tier.cashbackRate}. Ваш текущий уровень: ${currentTier.name}.`
        }
      >
        <span className="loyalty-band__star" aria-hidden="true">
          {isLocked ? "☆" : "★"}
        </span>
        <span className="loyalty-band__title">{tier.name}</span>
        <span className="loyalty-band__cashback-rate">
          <span className="loyalty-band__cashback-value">{tier.cashbackRate}</span>
          <span className="loyalty-band__cashback-label">кэшбека</span>
        </span>
        <span className="loyalty-band__progress-copy">{progress.label}</span>
        <span className="loyalty-band__progress" aria-hidden="true">
          <span style={{ width: `${Math.max(0, progress.value)}%` }} />
        </span>
      </button>

      <div
        className="loyalty-points-summary__pager"
        role="img"
        aria-label={`Карточка ${tierIndex + 1} из ${STATUS_TIERS.length}`}
      >
        {STATUS_TIERS.map((statusTier, index) => (
          <Fragment key={statusTier.name}>
            <span className={index === tierIndex ? "is-active" : undefined} aria-hidden="true" />
            {index < STATUS_TIERS.length - 1 ? (
              <span
                className={`loyalty-points-summary__pager-line${index < tierIndex ? " is-complete" : ""}`}
                aria-hidden="true"
              />
            ) : null}
          </Fragment>
        ))}
      </div>

      <div className="loyalty-points-summary">
        <div className="loyalty-points-summary__row">
          <span>Баланс баллов</span>
          <strong>{formatPointsBalance(pointsBalance)}</strong>
        </div>
        <div className="loyalty-points-summary__row loyalty-points-summary__expiry">
          <span>{expiryDate ? "Сгорят, если не заказать до" : "Баллы пока не сгорают"}</span>
          {expiryDate ? <strong>{expiryDate}</strong> : null}
        </div>
      </div>
    </section>
  );
}
