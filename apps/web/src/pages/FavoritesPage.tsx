import { Heart, ShoppingBag } from "lucide-react";
import { Link } from "react-router-dom";
import { ProductImagePreview } from "../components/ProductImagePreview";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { useAppState } from "../state/AppStateProvider";

function formatPriceRub(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

export function FavoritesPage() {
  const { state, dispatch } = useAppState();

  if (state.favorites.length === 0) {
    return (
      <Card className="overflow-hidden border-border/70 bg-card/82">
        <CardContent className="flex flex-col items-center py-10 text-center">
          <div className="mb-3 grid h-16 w-16 place-items-center rounded-full bg-primary/15 text-primary">
            <Heart className="h-8 w-8" />
          </div>
          <div className="text-lg font-semibold">Пока пусто</div>
          <p className="mt-2 max-w-[24ch] text-sm text-muted-foreground">
            Добавляйте товары сердечком в каталоге.
          </p>
          <Button asChild className="mt-5">
            <Link to="/">Перейти в каталог</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Избранное</h2>
        <Badge variant="secondary">{state.favorites.length} шт</Badge>
      </div>

      <div className="space-y-3">
        {state.favorites.map((item) => (
          <Card key={item.productId} className="border-border/70 bg-card/82">
            <CardHeader className="pb-3">
              <div className="flex gap-3">
                <ProductImagePreview
                  imageUrl={item.imageUrl}
                  alt={item.title}
                  loading="lazy"
                  className="h-20 w-20 rounded-lg object-cover"
                  placeholderClassName="flex h-20 w-20 items-center justify-center rounded-lg bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
                />

                <div className="min-w-0 flex-1">
                  <CardTitle className="line-clamp-2 text-base">{item.title}</CardTitle>
                  <div className="mt-1 text-sm font-semibold">{formatPriceRub(item.price)}</div>
                  <Badge className="mt-2" variant={item.inStock ? "success" : "outline"}>
                    {item.inStock ? "В наличии" : "Нет в наличии"}
                  </Badge>
                </div>

                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="self-start text-destructive hover:text-destructive"
                  onClick={() =>
                    dispatch({ type: "favorite/remove", productId: item.productId })
                  }
                >
                  Убрать
                </Button>
              </div>
            </CardHeader>

            <CardContent className="pt-0">
              <Button
                type="button"
                className="w-full"
                disabled={!item.inStock}
                onClick={() =>
                  dispatch({
                    type: "cart/add",
                    item: {
                      productId: item.productId,
                      title: item.title,
                      price: item.price,
                      imageUrl: item.imageUrl,
                    },
                  })
                }
              >
                <ShoppingBag className="h-4 w-4" />
                {item.inStock ? "В корзину" : "Нет в наличии"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
