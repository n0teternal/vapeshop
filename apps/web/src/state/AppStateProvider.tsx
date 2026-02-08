import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";

export type City = "vvo" | "blg";

export type CartItem = {
  productId: string;
  title: string;
  price: number;
  qty: number;
};

export type FavoriteItem = {
  productId: string;
  title: string;
  price: number;
  imageUrl: string | null;
  inStock: boolean;
};

export type AppState = {
  isAdultConfirmed: boolean;
  city: City | null;
  cart: CartItem[];
  favorites: FavoriteItem[];
};

type Action =
  | { type: "adult/confirm" }
  | { type: "city/set"; city: City }
  | { type: "city/clear" }
  | { type: "cart/add"; item: Omit<CartItem, "qty"> }
  | { type: "cart/inc"; productId: string }
  | { type: "cart/dec"; productId: string }
  | { type: "cart/remove"; productId: string }
  | { type: "cart/clear" }
  | { type: "favorite/toggle"; item: FavoriteItem }
  | { type: "favorite/remove"; productId: string };

type AppStateContextValue = {
  state: AppState;
  dispatch: Dispatch<Action>;
  cartCount: number;
  favoritesCount: number;
};

const STORAGE_KEY = "miniapp.state.v1";

const initialState: AppState = {
  isAdultConfirmed: false,
  city: null,
  cart: [],
  favorites: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCity(value: unknown): value is City {
  return value === "vvo" || value === "blg";
}

function isCartItem(value: unknown): value is CartItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.productId === "string" &&
    typeof value.title === "string" &&
    typeof value.price === "number" &&
    Number.isFinite(value.price) &&
    typeof value.qty === "number" &&
    Number.isInteger(value.qty) &&
    value.qty > 0
  );
}

function isFavoriteItem(value: unknown): value is FavoriteItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.productId === "string" &&
    typeof value.title === "string" &&
    typeof value.price === "number" &&
    Number.isFinite(value.price) &&
    typeof value.inStock === "boolean" &&
    (value.imageUrl === null || typeof value.imageUrl === "string")
  );
}

function loadStateFromStorage(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState;

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return initialState;

    const isAdultConfirmed =
      typeof parsed.isAdultConfirmed === "boolean"
        ? parsed.isAdultConfirmed
        : initialState.isAdultConfirmed;
    const city = parsed.city === null || isCity(parsed.city) ? parsed.city : null;

    const cartRaw = Array.isArray(parsed.cart) ? parsed.cart : [];
    const cart = cartRaw.filter(isCartItem);
    const favoritesRaw = Array.isArray(parsed.favorites) ? parsed.favorites : [];
    const favorites = favoritesRaw.filter(isFavoriteItem);

    return { isAdultConfirmed, city, cart, favorites };
  } catch {
    return initialState;
  }
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "adult/confirm":
      return { ...state, isAdultConfirmed: true };
    case "city/set":
      return { ...state, city: action.city };
    case "city/clear":
      return { ...state, city: null };
    case "cart/add": {
      const existing = state.cart.find((x) => x.productId === action.item.productId);
      if (existing) {
        return {
          ...state,
          cart: state.cart.map((x) =>
            x.productId === action.item.productId ? { ...x, qty: x.qty + 1 } : x,
          ),
        };
      }
      return { ...state, cart: [...state.cart, { ...action.item, qty: 1 }] };
    }
    case "cart/inc":
      return {
        ...state,
        cart: state.cart.map((x) =>
          x.productId === action.productId ? { ...x, qty: x.qty + 1 } : x,
        ),
      };
    case "cart/dec":
      return {
        ...state,
        cart: state.cart
          .map((x) =>
            x.productId === action.productId ? { ...x, qty: x.qty - 1 } : x,
          )
          .filter((x) => x.qty > 0),
      };
    case "cart/remove":
      return {
        ...state,
        cart: state.cart.filter((x) => x.productId !== action.productId),
      };
    case "cart/clear":
      return { ...state, cart: [] };
    case "favorite/toggle": {
      const exists = state.favorites.some((x) => x.productId === action.item.productId);
      if (exists) {
        return {
          ...state,
          favorites: state.favorites.filter((x) => x.productId !== action.item.productId),
        };
      }
      return { ...state, favorites: [...state.favorites, action.item] };
    }
    case "favorite/remove":
      return {
        ...state,
        favorites: state.favorites.filter((x) => x.productId !== action.productId),
      };
    default: {
      const _exhaustiveCheck: never = action;
      return _exhaustiveCheck;
    }
  }
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadStateFromStorage);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const cartCount = useMemo(() => {
    return state.cart.reduce((sum, item) => sum + item.qty, 0);
  }, [state.cart]);

  const favoritesCount = useMemo(() => {
    return state.favorites.length;
  }, [state.favorites]);

  const value = useMemo<AppStateContextValue>(() => {
    return { state, dispatch, cartCount, favoritesCount };
  }, [state, dispatch, cartCount, favoritesCount]);

  return (
    <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
  );
}


export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error("useAppState must be used within AppStateProvider");
  }
  return ctx;
}
