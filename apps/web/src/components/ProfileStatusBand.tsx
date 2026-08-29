import { useState } from "react";

type StatusTier = {
  name: string;
  threshold: string;
  balance?: string;
  expiry?: string;
  expiryProgress?: number;
  className: string;
};

const STATUS_TIERS: StatusTier[] = [
  {
    name: "Пока без кэшбека",
    threshold: "До 3% осталось 2 150 ₽",
    className: "loyalty-band--locked",
  },
  {
    name: "Базовый",
    threshold: "",
    balance: "340 ₽",
    expiry: "2 октября",
    expiryProgress: 17,
    className: "loyalty-band--bronze",
  },
  {
    name: "Продвинутый",
    threshold: "",
    balance: "1 240 ₽",
    expiry: "14 сентября",
    expiryProgress: 23,
    className: "loyalty-band--silver",
  },
  {
    name: "VIP",
    threshold: "",
    balance: "3 080 ₽",
    expiry: "29 августа",
    expiryProgress: 8,
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

        {isLocked ? (
          <span className="loyalty-band__progress-copy">{tier.threshold}</span>
        ) : null}

        {isLocked ? (
          <span className="loyalty-band__progress" aria-hidden="true">
            <span />
          </span>
        ) : null}
      </button>

      {!isLocked ? (
        <div className="loyalty-status__details loyalty-status__details--earned">
          <p>
            <span>Баланс баллов</span>
            <strong>{tier.balance}</strong>
          </p>
          <p>
            <span>Сгорят, если не заказать до</span>
            <strong>{tier.expiry}</strong>
          </p>
          <span className="loyalty-status__expiry" aria-hidden="true">
            <span style={{ width: `${tier.expiryProgress}%` }} />
          </span>
        </div>
      ) : null}
    </section>
  );
}
