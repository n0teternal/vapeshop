import { PackageSearch, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, apiGet, apiPut } from "../api/client";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

type OrderStatus = "new" | "processing" | "done" | "cancelled";

type CustomerOrder = {
  id: string;
  status: OrderStatus;
  cityLabel: string;
  totalPrice: number;
  createdAt: string;
  deliveryMethod: string;
  comment: string | null;
  canCancel: boolean;
  cancelDisabledReason: "done" | "cancelled" | "deadline" | null;
  items: Array<{
    title: string;
    qty: number;
    unitPrice: number;
  }>;
};

type OrdersResponse = {
  orders: CustomerOrder[];
};

type CancelOrderResponse = {
  changed: boolean;
  status: OrderStatus;
};

function formatPriceRub(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatOrderDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatStatusLabel(status: OrderStatus): string {
  if (status === "processing") return "В работе";
  if (status === "done") return "Done";
  if (status === "cancelled") return "Отменён";
  return "Новый";
}

function getStatusBadge(status: OrderStatus): {
  variant: "default" | "secondary" | "outline" | "success" | "warning";
  className?: string;
} {
  if (status === "processing") return { variant: "warning" };
  if (status === "done") return { variant: "success" };
  if (status === "cancelled") {
    return {
      variant: "outline",
      className: "border-destructive/40 bg-destructive/10 text-destructive",
    };
  }
  return { variant: "secondary" };
}

function formatApiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (
      error.code === "TG_INIT_DATA_REQUIRED" ||
      error.code === "TG_INIT_DATA_INVALID" ||
      error.code === "TG_INIT_DATA_EXPIRED"
    ) {
      return "Откройте мини-приложение внутри Telegram, чтобы управлять заказами.";
    }
    return error.message;
  }

  return error instanceof Error ? error.message : "Не удалось выполнить запрос";
}

function shortOrderId(orderId: string): string {
  return orderId.slice(-6).toUpperCase();
}

function getCancelDisabledMessage(order: CustomerOrder): string {
  if (order.cancelDisabledReason === "deadline") {
    return "Этот заказ уже нельзя отменить: до начала выбранного интервала доставки остался час или меньше.";
  }
  if (order.cancelDisabledReason === "done" || order.status === "done") {
    return "Заказ завершён и больше не может быть отменён.";
  }
  return "Этот заказ уже отменён.";
}

export function OrdersPage() {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadOrders(options?: { silent?: boolean }): Promise<void> {
    const silent = options?.silent ?? false;
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    setError(null);

    try {
      const data = await apiGet<OrdersResponse>("/api/orders");
      setOrders(data.orders);
    } catch (e: unknown) {
      setError(formatApiErrorMessage(e));
    } finally {
      if (silent) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void loadOrders();
  }, []);

  async function handleCancel(orderId: string): Promise<void> {
    const confirmed = window.confirm(
      "Отменить заказ? Это действие доступно, пока заказ не завершён и до начала выбранного интервала доставки остаётся больше часа.",
    );
    if (!confirmed) return;

    setBusyOrderId(orderId);
    setError(null);
    setNotice(null);

    try {
      const result = await apiPut<CancelOrderResponse>(`/api/orders/${orderId}/cancel`, {});

      setOrders((prev) => prev.filter((order) => order.id !== orderId));
      setNotice(
        result.status === "cancelled"
          ? "Заказ отменён и скрыт из списка."
          : "Статус заказа обновлён.",
      );
    } catch (e: unknown) {
      setError(formatApiErrorMessage(e));
    } finally {
      setBusyOrderId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Управление заказами</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Здесь можно посмотреть свои заказы и отменить те, которые ещё не дошли до статуса done.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading || refreshing || busyOrderId !== null}
          onClick={() => void loadOrders({ silent: true })}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Обновить
        </Button>
      </div>

      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <Card className="border-border/80 bg-card/90">
          <CardContent className="p-4 text-sm text-muted-foreground">
            Загружаем ваши заказы...
          </CardContent>
        </Card>
      ) : orders.length === 0 ? (
        <Card className="border-border/80 bg-card/90">
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <div className="grid h-16 w-16 place-items-center rounded-full bg-primary/15 text-primary">
              <PackageSearch className="h-8 w-8" />
            </div>
            <div className="text-base font-semibold">Активных заказов пока нет</div>
            <div className="max-w-[28ch] text-sm text-muted-foreground">
              Здесь показываются только заказы в статусах new и processing.
            </div>
            <Button asChild>
              <Link to="/">Перейти в каталог</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => {
            const badge = getStatusBadge(order.status);

            return (
              <Card key={order.id} className="border-border/80 bg-card/90">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">Заказ #{shortOrderId(order.id)}</CardTitle>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {order.cityLabel} • {formatOrderDate(order.createdAt)}
                      </div>
                    </div>
                    <Badge variant={badge.variant} className={badge.className}>
                      {formatStatusLabel(order.status)}
                    </Badge>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  <div className="space-y-1 text-sm">
                    <div>
                      <span className="text-muted-foreground">Получение:</span>{" "}
                      <span className="font-medium">{order.deliveryMethod}</span>
                    </div>
                    {order.comment ? (
                      <div className="whitespace-pre-line text-muted-foreground">
                        Комментарий: {order.comment}
                      </div>
                    ) : null}
                  </div>

                  <div className="space-y-2 rounded-xl border border-border/70 bg-background/40 p-3">
                    {order.items.map((item, index) => (
                      <div
                        key={`${order.id}-${index}-${item.title}`}
                        className="flex items-start justify-between gap-3 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="font-medium">{item.title}</div>
                          <div className="text-xs text-muted-foreground">Количество: {item.qty}</div>
                        </div>
                        <div className="shrink-0 font-semibold">
                          {formatPriceRub(item.unitPrice)}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">Итого</div>
                    <div className="text-base font-semibold">{formatPriceRub(order.totalPrice)}</div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {order.canCancel ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={busyOrderId === order.id}
                        onClick={() => void handleCancel(order.id)}
                      >
                        <XCircle className="h-4 w-4" />
                        {busyOrderId === order.id ? "Отменяем..." : "Отменить заказ"}
                      </Button>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        {getCancelDisabledMessage(order)}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
