import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./app/Layout";
import { ReferralBootstrap } from "./components/ReferralBootstrap";
import { AdminPage } from "./pages/AdminPage";
import { CartPage } from "./pages/CartPage";
import { CatalogPage } from "./pages/CatalogPage";
import { FavoritesPage } from "./pages/FavoritesPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ReferralPage } from "./pages/ReferralPage";
import { AppStateProvider } from "./state/AppStateProvider";
import { useTelegram } from "./telegram/TelegramProvider";
import { TelegramProvider } from "./telegram/TelegramProvider";

const REFERRAL_OWNER_TG_USER_ID = 1208488286;

function ReferralRoute() {
  const { webApp } = useTelegram();
  const tgUserId = webApp.initDataUnsafe?.user?.id ?? null;

  if (tgUserId !== REFERRAL_OWNER_TG_USER_ID) {
    return <Navigate to="/profile" replace />;
  }

  return <ReferralPage />;
}

export default function App() {
  return (
    <TelegramProvider>
      <AppStateProvider>
        <ReferralBootstrap />
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<CatalogPage />} />
            <Route path="/favorites" element={<FavoritesPage />} />
            <Route path="/cart" element={<CartPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/referrals" element={<ReferralRoute />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AppStateProvider>
    </TelegramProvider>
  );
}
