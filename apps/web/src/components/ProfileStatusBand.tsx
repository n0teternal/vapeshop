import { useState } from "react";

type StatusTier = {
  name: string;
  cashbackRate: string;
  progressLabel: string;
  progress: number;
  className: string;
};

const STATUS_TIERS: StatusTier[] = [
  {
    name: "Пока без кэшбека",
    cashbackRate: "0%",
    progressLabel: "До 3% осталось 2 150 ₽",
    progress: 25,
    className: "loyalty-band--locked",
  },
  {
    name: "Базовый",
    cashbackRate: "3%",
    progressLabel: "До 5% осталось 2 000 ₽",
    progress: 60,
    className: "loyalty-band--bronze",
  },
  {
    name: "Продвинутый",
    cashbackRate: "5%",
    progressLabel: "До 7% осталось 5 000 ₽",
    progress: 50,
    className: "loyalty-band--silver",
  },
  {
    name: "VIP",
    cashbackRate: "7%",
    progressLabel: "Максимальный статус",
    progress: 100,
    className: "loyalty-band--gold",
  },
];

export function ProfileStatusBand() {
  const [tierIndex, setTierIndex] = useState(0);
  const tier = STATUS_TIERS[tierIndex];
  const isLocked = tierIndex === 0;

  function showNextTier(): void {
    setTierIndex((current) => (current + 1) % STATUS_TIERS.length);
  }

  return (
    <section className="loyalty-status loyalty-status--embedded" aria-label="Статус Smoke Diller">
      <button
        type="button"
        className={`loyalty-band ${tier.className}`}
        onClick={showNextTier}
        aria-label={`Статус ${tier.name}. Нажмите, чтобы показать следующий уровень`}
      >
        <span className="loyalty-band__star" aria-hidden="true">
          {isLocked ? "☆" : "★"}
        </span>
        <span className="loyalty-band__title">{tier.name}</span>
        <span className="loyalty-band__cashback-rate">
          <span className="loyalty-band__cashback-value">{tier.cashbackRate}</span>
          <span className="loyalty-band__cashback-label">кэшбека</span>
        </span>

        <span className="loyalty-band__progress-copy">{tier.progressLabel}</span>
        <span className="loyalty-band__progress" aria-hidden="true">
          <span style={{ width: `${tier.progress}%` }} />
        </span>
      </button>
    </section>
  );
}
