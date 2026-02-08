import { Link } from "react-router-dom";
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
      <div className="py-6 text-center">
        <div className="empty-heart-stage" aria-hidden="true">
          <span className="empty-heart-emoji">❤️</span>
        </div>

        <div className="text-lg font-semibold leading-tight text-slate-100">Пока пусто</div>
        <div className="mt-2 text-sm leading-[1.35] text-slate-400">
          Добавляйте товары сердечком в каталоге.
        </div>
        <Link
          to="/"
          className="mt-4 inline-flex rounded-xl bg-[#2f80ff] px-4 py-2 text-sm font-semibold text-white hover:bg-[#2370e3]"
        >
          Перейти в каталог
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-right text-xs text-slate-400">
        {state.favorites.length} шт
      </div>

      <div className="space-y-3">
        {state.favorites.map((item) => (
          <article
            key={item.productId}
            className="rounded-2xl border border-white/10 bg-[#252a31] p-4"
          >
            <div className="flex gap-3">
              {item.imageUrl ? (
                <img
                  src={item.imageUrl}
                  alt={item.title}
                  loading="lazy"
                  className="h-16 w-16 rounded-xl object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-[#2b3139] text-[10px] font-semibold uppercase text-slate-500">
                  Photo
                </div>
              )}

              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-slate-100">
                  {item.title}
                </div>
                <div className="mt-1 text-sm font-semibold text-white">
                  {formatPriceRub(item.price)}
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {item.inStock ? "В наличии" : "Нет в наличии"}
                </div>
              </div>

              <button
                type="button"
                className="self-start text-xs font-semibold text-rose-400 hover:text-rose-300"
                onClick={() =>
                  dispatch({ type: "favorite/remove", productId: item.productId })
                }
              >
                Убрать
              </button>
            </div>

            <button
              type="button"
              className="mt-3 w-full rounded-xl bg-[#2f80ff] px-4 py-2 text-sm font-semibold text-white hover:bg-[#2370e3] disabled:cursor-not-allowed disabled:bg-slate-600"
              disabled={!item.inStock}
              onClick={() =>
                dispatch({
                  type: "cart/add",
                  item: {
                    productId: item.productId,
                    title: item.title,
                    price: item.price,
                  },
                })
              }
            >
              {item.inStock ? "В корзину" : "Нет в наличии"}
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
