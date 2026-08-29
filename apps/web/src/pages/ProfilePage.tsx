import { Clock3, Gift, PackageSearch, Plus, Save, ShieldCheck, Trash2, Truck, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, apiGet, apiPut } from "../api/client";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { ProfileStatusBand } from "../components/ProfileStatusBand";
import {
  writeCachedDeliveryPricingSettings,
  type DeliveryPeakSurchargeRule,
  type DeliveryPricingSettings,
  type DeliveryPricingRule,
} from "../lib/deliveryPricingCache";
import { useTelegram } from "../telegram/TelegramProvider";

type AdminMe = {
  tgUserId: number;
  username: string | null;
  role: string;
};

const DELIVERY_PRICING_ALLOWED_TG_USER_ID = 1208488286;

function normalizeNumericInput(value: string): number {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function ProfilePage() {
  const { webApp, isTelegram } = useTelegram();

  const [admin, setAdmin] = useState<AdminMe | null>(null);
  const [showCredit, setShowCredit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deliveryPricing, setDeliveryPricing] = useState<DeliveryPricingSettings | null>(null);
  const [deliveryPricingLoading, setDeliveryPricingLoading] = useState(false);
  const [deliveryPricingSaving, setDeliveryPricingSaving] = useState(false);
  const [deliveryPricingError, setDeliveryPricingError] = useState<string | null>(null);
  const [deliveryPricingSaved, setDeliveryPricingSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setShowCredit(false);

    apiGet<AdminMe>("/api/admin/me")
      .then((me) => {
        if (cancelled) return;
        setAdmin(me);
        setShowCredit(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setAdmin(null);

        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          setShowCredit(true);
          return;
        }

        setShowCredit(false);
        setError(e instanceof Error ? e.message : "Не удалось проверить доступ");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const tgUser = webApp.initDataUnsafe?.user;
  const shouldShowLoyaltyStatus = tgUser?.id === DELIVERY_PRICING_ALLOWED_TG_USER_ID;
  const canManageDeliveryPricing =
    isTelegram && tgUser?.id === DELIVERY_PRICING_ALLOWED_TG_USER_ID;

  useEffect(() => {
    let cancelled = false;

    if (!canManageDeliveryPricing) {
      setDeliveryPricing(null);
      setDeliveryPricingError(null);
      setDeliveryPricingSaved(false);
      return () => {
        cancelled = true;
      };
    }

    setDeliveryPricingLoading(true);
    setDeliveryPricingError(null);
    apiGet<DeliveryPricingSettings>("/api/delivery/pricing?citySlug=blg", {
      withTelegramAuth: false,
    })
      .then((settings) => {
        if (cancelled) return;
        setDeliveryPricing(settings);
        writeCachedDeliveryPricingSettings(settings);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setDeliveryPricingError(e instanceof Error ? e.message : "Не удалось загрузить доставку");
      })
      .finally(() => {
        if (cancelled) return;
        setDeliveryPricingLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [canManageDeliveryPricing]);

  const displayName = useMemo(() => {
    if (typeof tgUser?.username === "string" && tgUser.username.length > 0) {
      return `@${tgUser.username}`;
    }
    if (typeof tgUser?.first_name === "string" && tgUser.first_name.length > 0) {
      return tgUser.first_name;
    }
    return "Гость";
  }, [tgUser?.first_name, tgUser?.username]);

  const photoUrl =
    typeof tgUser?.photo_url === "string" && tgUser.photo_url.length > 0
      ? tgUser.photo_url
      : null;

  function patchDeliveryPricing(patch: Partial<DeliveryPricingSettings>): void {
    setDeliveryPricing((current) => (current ? { ...current, ...patch } : current));
    setDeliveryPricingSaved(false);
  }

  function patchDeliveryPricingRule(
    index: number,
    patch: Partial<DeliveryPricingRule>,
  ): void {
    setDeliveryPricing((current) => {
      if (!current) return current;
      return {
        ...current,
        rules: current.rules.map((rule, ruleIndex) =>
          ruleIndex === index ? { ...rule, ...patch } : rule,
        ),
      };
    });
    setDeliveryPricingSaved(false);
  }

  function addDeliveryPricingRule(): void {
    setDeliveryPricing((current) => {
      if (!current) return current;
      return {
        ...current,
        rules: [
          ...current.rules,
          {
            minDistanceKm: 3,
            feeRub: Math.max(current.baseFeeRub, 200),
          },
        ],
      };
    });
    setDeliveryPricingSaved(false);
  }

  function removeDeliveryPricingRule(index: number): void {
    setDeliveryPricing((current) => {
      if (!current) return current;
      return {
        ...current,
        rules: current.rules.filter((_, ruleIndex) => ruleIndex !== index),
      };
    });
    setDeliveryPricingSaved(false);
  }

  function patchPeakSurchargeRule(
    index: number,
    patch: Partial<DeliveryPeakSurchargeRule>,
  ): void {
    setDeliveryPricing((current) => {
      if (!current) return current;
      return {
        ...current,
        peakSurchargeRules: current.peakSurchargeRules.map((rule, ruleIndex) =>
          ruleIndex === index ? { ...rule, ...patch } : rule,
        ),
      };
    });
    setDeliveryPricingSaved(false);
  }

  function addPeakSurchargeRule(): void {
    setDeliveryPricing((current) => {
      if (!current) return current;
      return {
        ...current,
        peakSurchargeRules: [
          ...current.peakSurchargeRules,
          {
            startTime: "18:00",
            endTime: "21:00",
            surchargeRub: 100,
          },
        ],
      };
    });
    setDeliveryPricingSaved(false);
  }

  function removePeakSurchargeRule(index: number): void {
    setDeliveryPricing((current) => {
      if (!current) return current;
      return {
        ...current,
        peakSurchargeRules: current.peakSurchargeRules.filter(
          (_, ruleIndex) => ruleIndex !== index,
        ),
      };
    });
    setDeliveryPricingSaved(false);
  }

  async function saveDeliveryPricing(): Promise<void> {
    if (!deliveryPricing || deliveryPricingSaving) return;

    setDeliveryPricingSaving(true);
    setDeliveryPricingError(null);
    setDeliveryPricingSaved(false);
    try {
      const saved = await apiPut<DeliveryPricingSettings>("/api/delivery/pricing", {
        citySlug: deliveryPricing.citySlug,
        baseFeeRub: deliveryPricing.baseFeeRub,
        rules: deliveryPricing.rules,
        peakSurchargeRules: deliveryPricing.peakSurchargeRules,
      });
      setDeliveryPricing(saved);
      writeCachedDeliveryPricingSettings(saved);
      setDeliveryPricingSaved(true);
    } catch (e: unknown) {
      setDeliveryPricingError(e instanceof Error ? e.message : "Не удалось сохранить доставку");
    } finally {
      setDeliveryPricingSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Профиль</h2>

      <Card className="border-border/80 bg-card/90">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            {photoUrl ? (
              <img src={photoUrl} alt={displayName} className="h-14 w-14 rounded-full object-cover" />
            ) : (
              <div className="grid h-14 w-14 place-items-center rounded-full bg-primary/15 text-primary">
                <UserRound className="h-7 w-7" />
              </div>
            )}

            <div>
              <div className="text-base font-semibold">{displayName}</div>
              <div className="text-xs text-muted-foreground">
                {typeof tgUser?.id === "number" ? `ID: ${tgUser.id}` : "Telegram user"}
              </div>
            </div>
          </div>
          {shouldShowLoyaltyStatus ? <ProfileStatusBand /> : null}
        </CardContent>
      </Card>

      {canManageDeliveryPricing ? (
        <Card className="border-border/80 bg-card/90">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4" />
              Регуляция доставки
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {deliveryPricingLoading ? (
              <div className="text-sm text-muted-foreground">Загрузка...</div>
            ) : deliveryPricing ? (
              <>
                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-semibold text-muted-foreground">
                    Обычная доставка
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={10000}
                    step={1}
                    value={deliveryPricing.baseFeeRub}
                    onChange={(event) =>
                      patchDeliveryPricing({
                        baseFeeRub: Math.max(
                          0,
                          Math.round(normalizeNumericInput(event.target.value)),
                        ),
                      })
                    }
                  />
                </label>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold">Условия</div>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-8 w-8"
                      onClick={addDeliveryPricingRule}
                      title="Добавить условие"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>

                  {deliveryPricing.rules.map((rule, index) => (
                    <div
                      key={`${rule.minDistanceKm}-${index}`}
                      className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-end gap-2"
                    >
                      <div className="pb-2 text-sm font-semibold">&gt;</div>
                      <label className="grid gap-1 text-xs text-muted-foreground">
                        км
                        <Input
                          type="number"
                          min={0.1}
                          max={100}
                          step={0.1}
                          value={rule.minDistanceKm}
                          onChange={(event) =>
                            patchDeliveryPricingRule(index, {
                              minDistanceKm: Math.max(
                                0.1,
                                normalizeNumericInput(event.target.value),
                              ),
                            })
                          }
                        />
                      </label>
                      <div className="pb-2 text-sm font-semibold">=</div>
                      <label className="grid gap-1 text-xs text-muted-foreground">
                        ₽
                        <Input
                          type="number"
                          min={0}
                          max={10000}
                          step={1}
                          value={rule.feeRub}
                          onChange={(event) =>
                            patchDeliveryPricingRule(index, {
                              feeRub: Math.max(
                                0,
                                Math.round(normalizeNumericInput(event.target.value)),
                              ),
                            })
                          }
                        />
                      </label>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-10 w-10"
                        onClick={() => removeDeliveryPricingRule(index)}
                        title="Удалить условие"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <Clock3 className="h-4 w-4" />
                      Час пик
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-8 w-8"
                      onClick={addPeakSurchargeRule}
                      title="Добавить час пик"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>

                  {deliveryPricing.peakSurchargeRules.map((rule, index) => (
                    <div
                      key={`${rule.startTime}-${rule.endTime}-${index}`}
                      className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2"
                    >
                      <label className="grid gap-1 text-xs text-muted-foreground">
                        с
                        <Input
                          type="time"
                          value={rule.startTime}
                          onChange={(event) =>
                            patchPeakSurchargeRule(index, {
                              startTime: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="grid gap-1 text-xs text-muted-foreground">
                        до
                        <Input
                          type="time"
                          value={rule.endTime}
                          onChange={(event) =>
                            patchPeakSurchargeRule(index, {
                              endTime: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="grid gap-1 text-xs text-muted-foreground">
                        + ₽
                        <Input
                          type="number"
                          min={0}
                          max={10000}
                          step={1}
                          value={rule.surchargeRub}
                          onChange={(event) =>
                            patchPeakSurchargeRule(index, {
                              surchargeRub: Math.max(
                                0,
                                Math.round(normalizeNumericInput(event.target.value)),
                              ),
                            })
                          }
                        />
                      </label>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-10 w-10"
                        onClick={() => removePeakSurchargeRule(index)}
                        title="Удалить час пик"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    className="inline-flex items-center gap-2"
                    disabled={deliveryPricingSaving}
                    onClick={() => void saveDeliveryPricing()}
                  >
                    <Save className="h-4 w-4" />
                    {deliveryPricingSaving ? "Сохраняем..." : "Сохранить"}
                  </Button>
                  <div className="text-xs text-muted-foreground">
                    Скидка 150 ₽ от {deliveryPricing.freeDeliveryThresholdRub} ₽
                  </div>
                </div>
              </>
            ) : null}

            {deliveryPricingSaved ? (
              <div className="text-xs font-medium text-emerald-500">Сохранено</div>
            ) : null}
            {deliveryPricingError ? (
              <div className="text-xs text-destructive">{deliveryPricingError}</div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-border/80 bg-card/90">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Управление заказами</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button asChild>
            <Link to="/orders" className="inline-flex items-center gap-2">
              <PackageSearch className="h-4 w-4" />
              Открыть управление заказами
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/90">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Рефералка и баллы</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button asChild>
              <Link to="/referrals" className="inline-flex items-center gap-2">
                <Gift className="h-4 w-4" />
                Открыть рефералку
              </Link>
            </Button>
          </CardContent>
      </Card>

      {admin ? (
        <Card className="border-border/80 bg-card/90">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Админ-доступ</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Badge variant="success" className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              {admin.username ? `@${admin.username}` : admin.tgUserId} ({admin.role})
            </Badge>
            <div>
              <Button asChild>
                <Link to="/admin">Открыть админку</Link>
              </Button>
            </div>

            {error ? <div className="text-xs text-destructive">{error}</div> : null}
            {!isTelegram ? (
              <div className="text-xs text-muted-foreground">
                Для корректной проверки открывайте мини-приложение из Telegram.
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {showCredit ? (
        <div className="pb-3 pt-2 text-center text-[11px] font-medium text-muted-foreground/60">
          сделано @nottt_eternal
        </div>
      ) : null}
    </div>
  );
}

