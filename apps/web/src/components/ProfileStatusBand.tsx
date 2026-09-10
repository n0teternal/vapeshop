import { Fragment, useState } from "react";
import type { CashbackTier } from "../lib/cashback";

type ProfileStatusBandProps = {
  pointsBalance: number | null;
  pointsNextExpiresAt: string | null;
  cashbackTiers: CashbackTier[];
};

function formatPointsBalance(value: number | null): string {
  if (value === null) return "-";
  return `${new Intl.NumberFormat("ru-RU").format(value)} ₽`;
}

function formatRub(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function formatExpiryDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
  }).format(date);
}

function tierClassName(index: number, total: number): string {
  if (index === 0) return "loyalty-band--locked";
  if (index === total - 1) return "loyalty-band--gold";
  if (index === 2) return "loyalty-band--silver";
  return "loyalty-band--bronze";
}

type DisplayTier = {
  id: string;
  name: string;
  ratePercent: number;
  minOrderTotalRub: number;
  progressLabel: string;
  progress: number;
};

export function ProfileStatusBand({
  pointsBalance,
  pointsNextExpiresAt,
  cashbackTiers,
}: ProfileStatusBandProps) {
  const [tierIndex, setTierIndex] = useState(0);
  const [isChanging, setIsChanging] = useState(false);
  const sortedTiers = [...cashbackTiers].sort(
    (left, right) => left.minOrderTotalRub - right.minOrderTotalRub,
  );
  const displayTiers: DisplayTier[] = [
    {
      id: "locked",
      name: "Пока без кэшбека",
      ratePercent: 0,
      minOrderTotalRub: 0,
      progressLabel:
        sortedTiers.length > 0
          ? `До ${sortedTiers[0].ratePercent}% - заказ от ${formatRub(sortedTiers[0].minOrderTotalRub)} ₽`
          : "Условия кэшбека загружаются",
      progress: 0,
    },
    ...sortedTiers.map((tier, index) => {
      const nextTier = sortedTiers[index + 1];
      return {
        ...tier,
        progressLabel: nextTier
          ? `До ${nextTier.ratePercent}% - заказ от ${formatRub(nextTier.minOrderTotalRub)} ₽`
          : "Максимальный кэшбек",
        progress: Math.round(((index + 1) / sortedTiers.length) * 100),
      };
    }),
  ];
  const safeTierIndex = Math.min(tierIndex, Math.max(0, displayTiers.length - 1));
  const tier = displayTiers[safeTierIndex] ?? null;
  const expiryDate = formatExpiryDate(pointsNextExpiresAt);

  if (!tier || sortedTiers.length === 0) return null;

  function showNextTier(): void {
    if (isChanging) return;

    setTierIndex((current) => (current + 1) % displayTiers.length);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIsChanging(true);
    }
  }

  const isLocked = safeTierIndex === 0;
  const cardClassName = tierClassName(safeTierIndex, displayTiers.length);
  const statusClassName = cardClassName.replace("loyalty-band", "loyalty-status");

  return (
    <section
      className={`loyalty-status loyalty-status--embedded ${statusClassName}`}
      aria-label="Кэшбек Smoke Diller"
    >
      <button
        type="button"
        className={`loyalty-band ${cardClassName}${isChanging ? " loyalty-band--changing" : ""}`}
        onClick={showNextTier}
        onAnimationEnd={() => setIsChanging(false)}
        aria-label={
          isLocked
            ? `${tier.name}. ${tier.progressLabel}`
            : `Уровень кэшбека ${tier.name}: ${tier.ratePercent}% от заказа ${formatRub(tier.minOrderTotalRub)} ₽`
        }
      >
        <span className="loyalty-band__star" aria-hidden="true">{isLocked ? "☆" : "★"}</span>
        <span className="loyalty-band__title">{tier.name}</span>
        <span className="loyalty-band__cashback-rate">
          <span className="loyalty-band__cashback-value">{tier.ratePercent}%</span>
          <span className="loyalty-band__cashback-label">кэшбека</span>
        </span>
        <span className="loyalty-band__progress-copy">{tier.progressLabel}</span>
        <span className="loyalty-band__progress" aria-hidden="true">
          <span style={{ width: `${tier.progress}%` }} />
        </span>
      </button>

      <div
        className="loyalty-points-summary__pager"
        role="img"
        aria-label={`Карточка ${safeTierIndex + 1} из ${displayTiers.length}`}
      >
        {displayTiers.map((statusTier, index) => (
          <Fragment key={statusTier.id}>
            <span className={index === safeTierIndex ? "is-active" : undefined} aria-hidden="true" />
            {index < displayTiers.length - 1 ? (
              <span
                className={`loyalty-points-summary__pager-line${index < safeTierIndex ? " is-complete" : ""}`}
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
