export function FavoritesPage() {
  return (
    <div className="space-y-4">
      <div className="text-lg font-semibold">Избранное</div>

      <div className="rounded-2xl border border-white/10 bg-[#252a31] p-6 text-center">
        <div className="text-base font-semibold text-slate-100">Пока пусто</div>
        <div className="mt-2 text-sm text-slate-400">
          Здесь будут ваши избранные товары.
        </div>
      </div>
    </div>
  );
}
