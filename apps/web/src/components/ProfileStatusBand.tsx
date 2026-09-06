import { useEffect, useRef, useState } from "react";

type ProfileStatusBandProps = {
  pointsBalance: number | null;
  pointsNextExpiresAt: string | null;
};

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

function formatPointsBalance(value: number | null): string {
  if (value === null) return "—";
  return `${new Intl.NumberFormat("ru-RU").format(value)} ₽`;
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

export function ProfileStatusBand({
  pointsBalance,
  pointsNextExpiresAt,
}: ProfileStatusBandProps) {
  const [tierIndex, setTierIndex] = useState(0);
  const [isFlipping, setIsFlipping] = useState(false);
  const flipTimersRef = useRef<number[]>([]);
  const tier = STATUS_TIERS[tierIndex];
  const isLocked = tierIndex === 0;
  const expiryDate = formatExpiryDate(pointsNextExpiresAt);

  useEffect(
    () => () => {
      flipTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    },
    [],
  );

  function showNextTier(): void {
    if (isFlipping) return;

    const showNext = () => {
      setTierIndex((current) => (current + 1) % STATUS_TIERS.length);
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      showNext();
      return;
    }

    setIsFlipping(true);
    flipTimersRef.current = [
      window.setTimeout(showNext, 280),
      window.setTimeout(() => setIsFlipping(false), 560),
    ];
  }

  return (
    <section className="loyalty-status loyalty-status--embedded" aria-label="Статус Smoke Diller">
      <button
        type="button"
        className={`loyalty-band ${tier.className}${isFlipping ? " loyalty-band--flipping" : ""}`}
        onClick={showNextTier}
        disabled={isFlipping}
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

      <div className="loyalty-points-summary">
        <div className="loyalty-points-summary__row">
          <span>Баланс баллов</span>
          <strong>{formatPointsBalance(pointsBalance)}</strong>
        </div>
        <div className="loyalty-points-summary__row loyalty-points-summary__expiry">
          <span>{expiryDate ? "Сгорят, если не заказать до" : "Баллы пока не сгорают"}</span>
          {expiryDate ? <strong>{expiryDate}</strong> : null}
        </div>
        <p className="loyalty-points-summary__hint">Нажмите на карту, чтобы посмотреть уровни</p>
      </div>
    </section>
  );
}
