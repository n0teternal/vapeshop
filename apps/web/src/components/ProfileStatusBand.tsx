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
  if (index === total - 1) return "loyalty-band--gold";
  if (index === 1) return "loyalty-band--silver";
  return "loyalty-band--bronze";
}

export function ProfileStatusBand({
  pointsBalance,
  pointsNextExpiresAt,
  cashbackTiers,
}: ProfileStatusBandProps) {
  const [tierIndex, setTierIndex] = useState(0);
  const sortedTiers = [...cashbackTiers].sort(
    (left, right) => left.minOrderTotalRub - right.minOrderTotalRub,
  );
  const safeTierIndex = Math.min(tierIndex, Math.max(0, sortedTiers.length - 1));
  const tier = sortedTiers[safeTierIndex] ?? null;
  const expiryDate = formatExpiryDate(pointsNextExpiresAt);

  if (!tier) return null;

  function showNextTier(): void {
    setTierIndex((current) => (current + 1) % sortedTiers.length);
  }

  return (
    <section className="loyalty-status loyalty-status--embedded" aria-label="Кэшбек Smoke Diller">
      <button
        type="button"
        className={`loyalty-band ${tierClassName(safeTierIndex, sortedTiers.length)}`}
        onClick={showNextTier}
        aria-label={`Уровень кэшбека ${tier.name}: ${tier.ratePercent}% от заказа ${formatRub(tier.minOrderTotalRub)} ₽`}
      >
        <span className="loyalty-band__star" aria-hidden="true">★</span>
        <span className="loyalty-band__title">{tier.name}</span>
        <span className="loyalty-band__cashback-rate">
          <span className="loyalty-band__cashback-value">{tier.ratePercent}%</span>
          <span className="loyalty-band__cashback-label">кэшбека</span>
        </span>
        <span className="loyalty-band__progress-copy">
          С заказа от {formatRub(tier.minOrderTotalRub)} ₽
        </span>
      </button>

      <div
        className="loyalty-points-summary__pager"
        role="img"
        aria-label={`Условие ${safeTierIndex + 1} из ${sortedTiers.length}`}
      >
        {sortedTiers.map((statusTier, index) => (
          <Fragment key={statusTier.id}>
            <span className={index === safeTierIndex ? "is-active" : undefined} aria-hidden="true" />
            {index < sortedTiers.length - 1 ? (
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
