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
  categorySlug?: string | null;
  qty: number;
  imageUrl?: string | null;
};

export type FavoriteItem = {
  productId: string;
  title: string;
  price: number;
  categorySlug?: string | null;
  imageUrl: string | null;
  inStock: boolean;
};

export type DeliveryMethod = "pickup" | "delivery";

export type CheckoutDraft = {
  deliveryMethod: DeliveryMethod;
  address: string;
  comment: string;
  deliveryDate: string;
  deliveryTimeSlot: string;
};

export const EMPTY_CHECKOUT_DRAFT: CheckoutDraft = {
  deliveryMethod: "delivery",
  address: "",
  comment: "",
  deliveryDate: "",
  deliveryTimeSlot: "",
};

export type OrderEditRestoreSnapshot = {
  city: City | null;
  cartCity: City | null;
  cart: CartItem[];
  checkoutDraft: CheckoutDraft;
};

export type OrderEditSession = {
  orderId: string;
  city: City;
  expiresAt: string;
  discountAmount: number;
  restore: OrderEditRestoreSnapshot;
};

export type AppState = {
  isAdultConfirmed: boolean;
  city: City | null;
  cartCity: City | null;
  cart: CartItem[];
  favorites: FavoriteItem[];
  checkoutDraft: CheckoutDraft;
  orderEditSession: OrderEditSession | null;
};

type Action =
  | { type: "adult/confirm" }
  | { type: "city/set"; city: City }
  | { type: "city/clear" }
  | { type: "cart/add"; item: Omit<CartItem, "qty"> }
  | { type: "cart/replace"; city: City; items: CartItem[] }
  | { type: "cart/inc"; productId: string }
  | { type: "cart/dec"; productId: string }
  | { type: "cart/remove"; productId: string }
  | { type: "cart/clear" }
  | { type: "checkout/set"; patch: Partial<CheckoutDraft> }
  | { type: "checkout/reset"; draft?: Partial<CheckoutDraft> }
  | {
      type: "order-edit/start";
      session: Omit<OrderEditSession, "restore">;
      cart: CartItem[];
      checkoutDraft: CheckoutDraft;
    }
  | { type: "order-edit/cancel" }
  | { type: "order-edit/complete" }
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
  cartCity: null,
  cart: [],
  favorites: [],
  checkoutDraft: EMPTY_CHECKOUT_DRAFT,
  orderEditSession: null,
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
    (value.categorySlug === undefined ||
      value.categorySlug === null ||
      typeof value.categorySlug === "string") &&
    typeof value.qty === "number" &&
    Number.isInteger(value.qty) &&
    value.qty > 0 &&
    (value.imageUrl === undefined ||
      value.imageUrl === null ||
      typeof value.imageUrl === "string")
  );
}

function isFavoriteItem(value: unknown): value is FavoriteItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.productId === "string" &&
    typeof value.title === "string" &&
    typeof value.price === "number" &&
    Number.isFinite(value.price) &&
      (value.categorySlug === undefined ||
        value.categorySlug === null ||
        typeof value.categorySlug === "string") &&
      typeof value.inStock === "boolean" &&
      (value.imageUrl === null || typeof value.imageUrl === "string")
  );
}

function isDeliveryMethod(value: unknown): value is DeliveryMethod {
  return value === "pickup" || value === "delivery";
}

function sanitizeCheckoutDraft(value: unknown): CheckoutDraft {
  if (!isRecord(value)) {
    return EMPTY_CHECKOUT_DRAFT;
  }

  return {
    deliveryMethod: isDeliveryMethod(value.deliveryMethod)
      ? value.deliveryMethod
      : EMPTY_CHECKOUT_DRAFT.deliveryMethod,
    address: typeof value.address === "string" ? value.address : EMPTY_CHECKOUT_DRAFT.address,
    comment: typeof value.comment === "string" ? value.comment : EMPTY_CHECKOUT_DRAFT.comment,
    deliveryDate:
      typeof value.deliveryDate === "string"
        ? value.deliveryDate
        : EMPTY_CHECKOUT_DRAFT.deliveryDate,
    deliveryTimeSlot:
      typeof value.deliveryTimeSlot === "string"
        ? value.deliveryTimeSlot
        : EMPTY_CHECKOUT_DRAFT.deliveryTimeSlot,
  };
}

function sanitizeRestoreSnapshot(value: unknown): OrderEditRestoreSnapshot | null {
  if (!isRecord(value)) return null;

  const city = value.city === null || isCity(value.city) ? value.city : null;
  const cartCity = value.cartCity === null || isCity(value.cartCity) ? value.cartCity : null;
  const cartRaw = Array.isArray(value.cart) ? value.cart : [];
  const cart = cartRaw.filter(isCartItem);

  return {
    city,
    cartCity: cart.length > 0 ? cartCity : null,
    cart,
    checkoutDraft: sanitizeCheckoutDraft(value.checkoutDraft),
  };
}

function sanitizeOrderEditSession(value: unknown): OrderEditSession | null {
  if (!isRecord(value)) return null;
  if (typeof value.orderId !== "string" || value.orderId.trim().length === 0) return null;
  if (!isCity(value.city)) return null;
  if (typeof value.expiresAt !== "string" || value.expiresAt.trim().length === 0) return null;
  if (typeof value.discountAmount !== "number" || !Number.isFinite(value.discountAmount)) {
    return null;
  }

  const restore = sanitizeRestoreSnapshot(value.restore);
  if (!restore) return null;

  return {
    orderId: value.orderId,
    city: value.city,
    expiresAt: value.expiresAt,
    discountAmount: Math.max(0, Math.trunc(value.discountAmount)),
    restore,
  };
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
    const cartCity =
      parsed.cartCity === null || isCity(parsed.cartCity) ? parsed.cartCity : null;

    const cartRaw = Array.isArray(parsed.cart) ? parsed.cart : [];
    const parsedCart = cartRaw.filter(isCartItem);
    const cart =
      parsedCart.length > 0 && (!cartCity || cartCity !== city) ? [] : parsedCart;
    const favoritesRaw = Array.isArray(parsed.favorites) ? parsed.favorites : [];
    const favorites = favoritesRaw.filter(isFavoriteItem);
    const checkoutDraft = sanitizeCheckoutDraft(parsed.checkoutDraft);
    const orderEditSession = sanitizeOrderEditSession(parsed.orderEditSession);

    return {
      isAdultConfirmed,
      city,
      cartCity: cart.length > 0 ? cartCity : null,
      cart,
      favorites,
      checkoutDraft,
      orderEditSession,
    };
  } catch {
    return initialState;
  }
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "adult/confirm":
      return { ...state, isAdultConfirmed: true };
    case "city/set":
      if (state.orderEditSession && state.orderEditSession.city !== action.city) {
        return state;
      }
      if (state.city === action.city) {
        return state;
      }
      return {
        ...state,
        city: action.city,
        cartCity: null,
        cart: [],
        checkoutDraft: EMPTY_CHECKOUT_DRAFT,
      };
    case "city/clear":
      if (state.orderEditSession) {
        return state;
      }
      return {
        ...state,
        city: null,
        cartCity: null,
        cart: [],
        checkoutDraft: EMPTY_CHECKOUT_DRAFT,
      };
    case "cart/add": {
      const existing = state.cart.find((x) => x.productId === action.item.productId);
      if (existing) {
        return {
          ...state,
          cartCity: state.city,
          cart: state.cart.map((x) =>
            x.productId === action.item.productId
              ? {
                  ...x,
                  price: action.item.price,
                  categorySlug: x.categorySlug ?? action.item.categorySlug ?? null,
                  qty: x.qty + 1,
                  imageUrl: x.imageUrl ?? action.item.imageUrl ?? null,
                }
              : x,
          ),
        };
      }
      return {
        ...state,
        cartCity: state.city,
        cart: [
          ...state.cart,
          {
            ...action.item,
            categorySlug: action.item.categorySlug ?? null,
            qty: 1,
            imageUrl: action.item.imageUrl ?? null,
          },
        ],
      };
    }
    case "cart/replace":
      return {
        ...state,
        city: action.city,
        cartCity: action.city,
        cart: action.items,
      };
    case "cart/inc":
      return {
        ...state,
        cartCity: state.city,
        cart: state.cart.map((x) =>
          x.productId === action.productId ? { ...x, qty: x.qty + 1 } : x,
        ),
      };
    case "cart/dec":
      {
        const nextCart = state.cart
          .map((x) =>
            x.productId === action.productId ? { ...x, qty: x.qty - 1 } : x,
          )
          .filter((x) => x.qty > 0);
        return {
          ...state,
          cartCity: nextCart.length > 0 ? state.cartCity : null,
          cart: nextCart,
        };
      }
    case "cart/remove": {
      const nextCart = state.cart.filter((x) => x.productId !== action.productId);
      return {
        ...state,
        cartCity: nextCart.length > 0 ? state.cartCity : null,
        cart: nextCart,
      };
    }
    case "cart/clear":
      return { ...state, cartCity: null, cart: [] };
    case "checkout/set":
      return {
        ...state,
        checkoutDraft: {
          ...state.checkoutDraft,
          ...action.patch,
        },
      };
    case "checkout/reset":
      return {
        ...state,
        checkoutDraft: {
          ...EMPTY_CHECKOUT_DRAFT,
          ...(action.draft ?? {}),
        },
      };
    case "order-edit/start": {
      const restore =
        state.orderEditSession?.restore ?? {
          city: state.city,
          cartCity: state.cartCity,
          cart: state.cart,
          checkoutDraft: state.checkoutDraft,
        };

      return {
        ...state,
        city: action.session.city,
        cartCity: action.session.city,
        cart: action.cart,
        checkoutDraft: action.checkoutDraft,
        orderEditSession: {
          ...action.session,
          restore,
        },
      };
    }
    case "order-edit/cancel":
      if (!state.orderEditSession) {
        return state;
      }
      return {
        ...state,
        city: state.orderEditSession.restore.city,
        cartCity: state.orderEditSession.restore.cartCity,
        cart: state.orderEditSession.restore.cart,
        checkoutDraft: state.orderEditSession.restore.checkoutDraft,
        orderEditSession: null,
      };
    case "order-edit/complete":
      return {
        ...state,
        cartCity: null,
        cart: [],
        checkoutDraft: EMPTY_CHECKOUT_DRAFT,
        orderEditSession: null,
      };
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

export function getOrderEditRemainingMs(
  session: Pick<OrderEditSession, "expiresAt">,
  nowMs: number = Date.now(),
): number {
  const expiresAtMs = new Date(session.expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return 0;
  return Math.max(0, expiresAtMs - nowMs);
}

export function isOrderEditSessionExpired(
  session: Pick<OrderEditSession, "expiresAt">,
  nowMs: number = Date.now(),
): boolean {
  return getOrderEditRemainingMs(session, nowMs) <= 0;
}
