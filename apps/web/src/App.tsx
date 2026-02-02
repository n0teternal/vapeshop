import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./app/Layout";
import { AdminPage } from "./pages/AdminPage";
import { CartPage } from "./pages/CartPage";
import { CatalogPage } from "./pages/CatalogPage";
import { AppStateProvider } from "./state/AppStateProvider";
import { TelegramProvider } from "./telegram/TelegramProvider";

export default function App() {
  return (
    <TelegramProvider>
      <AppStateProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<CatalogPage />} />
            <Route path="/cart" element={<CartPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AppStateProvider>
    </TelegramProvider>
  );
}
