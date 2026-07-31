import { Map as MapIcon, MapPin, Navigation, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DELIVERY_ORIGINS,
  YANDEX_MAPS_API_KEY,
  YANDEX_MAPS_SUGGEST_API_KEY,
} from "../config";
import { ApiError, apiGet } from "../api/client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export type DeliveryMapSelection = {
  address: string;
  lat: number;
  lon: number;
  distanceKm: number;
  zone: DeliveryDistanceZone;
};

export type DeliveryDistancePreview = {
  address: string;
  distanceKm: number;
};

export type DeliveryDistanceZone = {
  id: "near" | "middle" | "far" | "manual";
  title: string;
  feeHint: string;
  toneClassName: string;
};

type CitySlug = "vvo" | "blg";

type DeliveryGeocodeResponse = {
  address: string;
  lat: number;
  lon: number;
};

type DeliveryDistancePreviewResponse = {
  address: string;
  distanceKm: number;
  source: "geosuggest";
};

type AddressSearchOptions = {
  showErrors?: boolean;
};

type AddressSearchAttempt = {
  found: boolean;
  errorMessage: string | null;
};

type AddressSuggestion = {
  value: string;
  label: string;
};

type DeliveryAddressMapProps = {
  city: CitySlug;
  address: string;
  disabled: boolean;
  required?: boolean;
  inputClassName?: string;
  onAddressChange: (address: string) => void;
  onSelectionChange: (selection: DeliveryMapSelection | null) => void;
  onDistancePreviewChange?: (preview: DeliveryDistancePreview | null) => void;
};

type CitySearchConfig = {
  label: string;
  queryPrefix: string;
  boundedBy: [YMapsCoords, YMapsCoords];
};

const CITY_SEARCH_CONFIGS: Record<CitySlug, CitySearchConfig> = {
  vvo: {
    label: "Владивосток",
    queryPrefix: "Россия, Приморский край, Владивосток",
    boundedBy: [
      [42.94, 131.72],
      [43.32, 132.16],
    ],
  },
  blg: {
    label: "Благовещенск",
    queryPrefix: "Россия, Амурская область, Благовещенск",
    boundedBy: [
      [50.18, 127.42],
      [50.36, 127.68],
    ],
  },
};

let yandexMapsPromise: Promise<YMapsApi> | null = null;

function loadYandexMaps(): Promise<YMapsApi> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Maps are unavailable outside browser"));
  }
  if (window.ymaps) return Promise.resolve(window.ymaps);
  if (yandexMapsPromise) return yandexMapsPromise;
  if (!YANDEX_MAPS_API_KEY) {
    return Promise.reject(new Error("Yandex Maps API key is not configured"));
  }

  yandexMapsPromise = new Promise((resolve, reject) => {
    const scriptId = "yandex-maps-js-api";
    const existingScript = document.getElementById(scriptId) as HTMLScriptElement | null;

    const waitForReady = () => {
      if (!window.ymaps) {
        reject(new Error("Yandex Maps did not initialize"));
        return;
      }
      window.ymaps.ready(() => resolve(window.ymaps as YMapsApi));
    };

    if (existingScript) {
      existingScript.addEventListener("load", waitForReady, { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("Failed to load Yandex Maps")),
        { once: true },
      );
      return;
    }

    const query = new URLSearchParams({
      apikey: YANDEX_MAPS_API_KEY,
      lang: "ru_RU",
    });
    if (YANDEX_MAPS_SUGGEST_API_KEY) {
      query.set("suggest_apikey", YANDEX_MAPS_SUGGEST_API_KEY);
    }

    const script = document.createElement("script");
    script.id = scriptId;
    script.src = `https://api-maps.yandex.ru/2.1/?${query.toString()}`;
    script.async = true;
    script.onload = waitForReady;
    script.onerror = () => {
      yandexMapsPromise = null;
      reject(new Error("Failed to load Yandex Maps"));
    };
    document.head.appendChild(script);
  });

  return yandexMapsPromise;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function distanceKmBetween(a: YMapsCoords, b: YMapsCoords): number {
  const earthRadiusKm = 6371;
  const dLat = toRadians(b[0] - a[0]);
  const dLon = toRadians(b[1] - a[1]);
  const lat1 = toRadians(a[0]);
  const lat2 = toRadians(b[0]);
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function getDistanceZone(distanceKm: number): DeliveryDistanceZone {
  if (distanceKm <= 3) {
    return {
      id: "near",
      title: "Ближняя зона",
      feeHint: "обычный тариф",
      toneClassName: "border-emerald-300/40 bg-emerald-400/10 text-emerald-500",
    };
  }
  if (distanceKm <= 5) {
    return {
      id: "middle",
      title: "Средняя зона",
      feeHint: "проверить маржу",
      toneClassName: "border-amber-300/40 bg-amber-400/10 text-amber-500",
    };
  }
  if (distanceKm <= 7) {
    return {
      id: "far",
      title: "Дальняя зона",
      feeHint: "повысить доставку",
      toneClassName: "border-orange-300/40 bg-orange-400/10 text-orange-500",
    };
  }
  return {
    id: "manual",
    title: "По согласованию",
    feeHint: "не отдавать бесплатно",
    toneClassName: "border-destructive/40 bg-destructive/10 text-destructive",
  };
}

function formatDistanceKm(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)} км`;
}

function getGeoObjectAddress(geoObject: YMapsGeoObject, fallback: string): string {
  const addressLine = geoObject.getAddressLine?.();
  if (addressLine && addressLine.trim().length > 0) return addressLine.trim();
  const text = geoObject.properties?.get("text");
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : fallback;
}

function isValidCoords(coords: YMapsCoords): boolean {
  const [lat, lon] = coords;
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeSearchText(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }

  return out;
}

function formatAddressSuggestionLabel(city: CitySlug, value: string): string {
  const config = CITY_SEARCH_CONFIGS[city];
  const blockedParts = new Set(
    [
      "Россия",
      config.label,
      ...config.queryPrefix.split(","),
    ].map((part) => normalizeSearchText(part)),
  );
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !blockedParts.has(normalizeSearchText(part)));

  return parts.length > 0 ? parts.join(", ") : value;
}

function buildAddressSuggestion(city: CitySlug, value: string): AddressSuggestion | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return {
    value: trimmed,
    label: formatAddressSuggestionLabel(city, trimmed),
  };
}

function buildStreetHouseQueryVariants(rawQuery: string): string[] {
  const query = rawQuery.trim();
  const commaStreetHouseMatch = /^(.+?),\s*(\d+[0-9A-Za-zА-Яа-я/-]*)$/.exec(query);
  if (commaStreetHouseMatch) {
    const street = commaStreetHouseMatch[1]?.trim();
    const house = commaStreetHouseMatch[2]?.trim();
    if (!street || !house) return [query];

    const streetSuffixMatch =
      /^(.+?)\s+(улица|проспект|переулок|проезд|бульвар|шоссе|тракт|набережная)$/i.exec(street);
    const streetPrefixMatch =
      /^(улица|проспект|переулок|проезд|бульвар|шоссе|тракт|набережная)\s+(.+?)$/i.exec(street);
    const streetName =
      streetSuffixMatch?.[1]?.trim() ?? streetPrefixMatch?.[2]?.trim() ?? street;
    const streetType =
      streetSuffixMatch?.[2]?.trim() ?? streetPrefixMatch?.[1]?.trim() ?? "улица";

    return uniqueStrings([
      query,
      `${streetType} ${streetName}, ${house}`,
      `${streetName} ${streetType}, ${house}`,
      `${streetName}, ${house}`,
    ]);
  }

  const streetHouseMatch = /^(.+?)\s+(\d+[0-9A-Za-zА-Яа-я/-]*)$/.exec(query);
  if (!streetHouseMatch) return [query];

  const street = streetHouseMatch[1]?.trim();
  const house = streetHouseMatch[2]?.trim();
  if (!street || !house || street.includes(",")) return [query];

  return uniqueStrings([
    query,
    `${street}, ${house}`,
    `улица ${street}, ${house}`,
    `${street} улица, ${house}`,
  ]);
}

function getAddressTailAfterCity(city: CitySlug, rawQuery: string): string | null {
  const config = CITY_SEARCH_CONFIGS[city];
  const cityLabel = normalizeSearchText(config.label);
  const parts = rawQuery
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const cityIndex = parts.findIndex((part) => normalizeSearchText(part).includes(cityLabel));
  if (cityIndex < 0 || cityIndex >= parts.length - 1) return null;

  return parts.slice(cityIndex + 1).join(", ");
}

function buildAddressSearchQueries(city: CitySlug, rawQuery: string): string[] {
  const query = rawQuery.trim();
  const config = CITY_SEARCH_CONFIGS[city];
  const baseQueries = uniqueStrings([query, getAddressTailAfterCity(city, query) ?? ""]);

  const queryVariants = baseQueries.flatMap((value) => buildStreetHouseQueryVariants(value));
  const scopedQueries = queryVariants.flatMap((value) => [
    `${config.queryPrefix}, ${value}`,
    `Россия, ${value}`,
    `${config.label}, ${value}`,
    value,
  ]);

  return uniqueStrings(scopedQueries);
}

export function DeliveryAddressMap({
  city,
  address,
  disabled,
  required,
  inputClassName,
  onAddressChange,
  onSelectionChange,
  onDistancePreviewChange,
}: DeliveryAddressMapProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<YMapsMap | null>(null);
  const customerPlacemarkRef = useRef<YMapsPlacemark | null>(null);
  const [ymapsApi, setYmapsApi] = useState<YMapsApi | null>(null);
  const [localAddress, setLocalAddress] = useState(address);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [selection, setSelection] = useState<DeliveryMapSelection | null>(null);
  const [distancePreview, setDistancePreview] = useState<DeliveryDistancePreview | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const origin = DELIVERY_ORIGINS[city];
  const originCoords = useMemo<YMapsCoords>(() => [origin.lat, origin.lon], [origin.lat, origin.lon]);
  const mapConfigured = Boolean(YANDEX_MAPS_API_KEY);

  useEffect(() => {
    setLocalAddress(address);
  }, [address]);

  useEffect(() => {
    let cancelled = false;
    setMapError(null);

    if (!mapConfigured) {
      setYmapsApi(null);
      setMapError("Добавь VITE_YANDEX_MAPS_API_KEY, чтобы включить карту.");
      return () => {
        cancelled = true;
      };
    }

    loadYandexMaps()
      .then((api) => {
        if (cancelled) return;
        setYmapsApi(api);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setYmapsApi(null);
        setMapError(error instanceof Error ? error.message : "Не удалось загрузить карту.");
      });

    return () => {
      cancelled = true;
    };
  }, [mapConfigured]);

  useEffect(() => {
    if (!mapOpen || !ymapsApi || !mapElementRef.current) return undefined;

    const map = new ymapsApi.Map(
      mapElementRef.current,
      {
        center: originCoords,
        zoom: 12,
        controls: [],
      },
      {
        suppressMapOpenBlock: true,
      },
    );
    mapRef.current = map;

    const originPlacemark = new ymapsApi.Placemark(
      originCoords,
      { hintContent: origin.label },
      { preset: "islands#blueHomeIcon" },
    );
    map.geoObjects.add(originPlacemark);

    map.events.add("click", (event) => {
      const coords = event.get("coords");
      if (!isValidCoords(coords)) return;
      void selectCoords(coords);
    });

    return () => {
      customerPlacemarkRef.current = null;
      map.destroy();
      mapRef.current = null;
    };
    // selectCoords intentionally uses current ymaps/map refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapOpen, origin.label, originCoords, ymapsApi]);

  useEffect(() => {
    if (!ymapsApi?.suggest || localAddress.trim().length < 3 || disabled) {
      setSuggestions([]);
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      const config = CITY_SEARCH_CONFIGS[city];
      const request = `${config.queryPrefix}, ${localAddress.trim()}`;
      ymapsApi
        .suggest?.(request, {
          boundedBy: config.boundedBy,
          provider: "yandex#map",
          results: 5,
        })
        .then((items) => {
          const nextSuggestions = items
            .map((item) => item.value ?? item.displayName ?? "")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
            .map((value) => buildAddressSuggestion(city, value))
            .filter((suggestion): suggestion is AddressSuggestion => suggestion !== null)
            .slice(0, 5);
          const seen = new Set<string>();
          setSuggestions(
            nextSuggestions.filter((suggestion) => {
              const key = normalizeSearchText(suggestion.value);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }),
          );
        })
        .catch(() => {
          setSuggestions([]);
        });
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [city, disabled, localAddress, ymapsApi]);

  function clearCustomerPlacemark(): void {
    if (mapRef.current && customerPlacemarkRef.current) {
      mapRef.current.geoObjects.remove(customerPlacemarkRef.current);
      customerPlacemarkRef.current = null;
    }
  }

  function setCustomerPlacemark(coords: YMapsCoords): void {
    if (!ymapsApi || !mapRef.current) return;
    clearCustomerPlacemark();
    const placemark = new ymapsApi.Placemark(
      coords,
      { hintContent: "Адрес доставки" },
      { draggable: false, preset: "islands#redDotIcon" },
    );
    customerPlacemarkRef.current = placemark;
    mapRef.current.geoObjects.add(placemark);
    mapRef.current.setCenter(coords, 15, { duration: 250 });
  }

  function applyDeliverySelection(addressLine: string, coords: YMapsCoords): void {
    const distanceKm = distanceKmBetween(originCoords, coords);
    const nextSelection: DeliveryMapSelection = {
      address: addressLine,
      lat: coords[0],
      lon: coords[1],
      distanceKm,
      zone: getDistanceZone(distanceKm),
    };

    setCustomerPlacemark(coords);
    setLocalAddress(addressLine);
    setSelection(nextSelection);
    setDistancePreview(null);
    setSuggestions([]);
    setMapError(null);
    onAddressChange(addressLine);
    onSelectionChange(nextSelection);
    onDistancePreviewChange?.(null);
  }

  async function selectCoords(coords: YMapsCoords, fallbackAddress = localAddress): Promise<void> {
    if (!ymapsApi || disabled) return;

    setLoading(true);
    setMapError(null);
    try {
      const result = await ymapsApi.geocode(coords, { results: 1 });
      const geoObject = result.geoObjects.get(0);
      const nextAddress = geoObject ? getGeoObjectAddress(geoObject, fallbackAddress) : fallbackAddress;
      applyDeliverySelection(nextAddress, coords);
    } catch {
      setMapError("Не удалось получить адрес по точке.");
    } finally {
      setLoading(false);
    }
  }

  async function searchAddressViaApi(
    query: string,
    options: AddressSearchOptions = {},
  ): Promise<AddressSearchAttempt> {
    const showErrors = options.showErrors ?? true;

    try {
      const search = new URLSearchParams({
        citySlug: city,
        address: query,
      });
      const result = await apiGet<DeliveryGeocodeResponse>(
        `/api/delivery/geocode?${search.toString()}`,
      );
      const coords: YMapsCoords = [result.lat, result.lon];
      if (!isValidCoords(coords)) {
        return {
          found: false,
          errorMessage: "Геокодер вернул некорректные координаты.",
        };
      }

      applyDeliverySelection(result.address || query, coords);
      return { found: true, errorMessage: null };
    } catch (error) {
      if (error instanceof ApiError) {
        if (
          error.code === "YANDEX_GEOCODER_NOT_CONFIGURED" ||
          error.code === "YANDEX_GEOCODER_ERROR" ||
          error.code === "ADDRESS_NOT_FOUND"
        ) {
          return { found: false, errorMessage: showErrors ? error.message : null };
        }
      }
      return { found: false, errorMessage: null };
    }
  }

  async function previewDistanceViaApi(
    query: string,
    options: AddressSearchOptions = {},
  ): Promise<AddressSearchAttempt> {
    const showErrors = options.showErrors ?? true;

    try {
      const search = new URLSearchParams({
        citySlug: city,
        address: query,
        originLat: String(origin.lat),
        originLon: String(origin.lon),
      });
      const result = await apiGet<DeliveryDistancePreviewResponse>(
        `/api/delivery/distance-preview?${search.toString()}`,
      );

      const nextPreview: DeliveryDistancePreview = {
        address: result.address || query,
        distanceKm: result.distanceKm,
      };
      setDistancePreview(nextPreview);
      onDistancePreviewChange?.(nextPreview);
      setMapError(null);
      return { found: true, errorMessage: null };
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "YANDEX_GEOSUGGEST_NOT_CONFIGURED") {
          return { found: false, errorMessage: null };
        }
        if (error.code === "YANDEX_GEOSUGGEST_NETWORK") {
          return { found: false, errorMessage: null };
        }
        if (error.code === "YANDEX_GEOSUGGEST_ERROR" || error.code === "ADDRESS_NOT_FOUND") {
          return { found: false, errorMessage: showErrors ? error.message : null };
        }
      }
      return { found: false, errorMessage: null };
    }
  }

  async function searchAddressViaYmaps(query: string): Promise<AddressSearchAttempt> {
    if (!ymapsApi) return { found: false, errorMessage: null };

    const searchQueries = buildAddressSearchQueries(city, query);

    for (const searchQuery of searchQueries) {
      const result = await ymapsApi.geocode(searchQuery, {
        results: 1,
      }).catch(() => null);
      if (!result) continue;
      const geoObject = result.geoObjects.get(0);
      if (!geoObject) continue;

      const coords = geoObject.geometry.getCoordinates();
      if (!isValidCoords(coords)) continue;

      applyDeliverySelection(getGeoObjectAddress(geoObject, query), coords);
      return { found: true, errorMessage: null };
    }

    return { found: false, errorMessage: null };
  }

  async function searchAddress(
    nextAddress = localAddress,
    options: AddressSearchOptions = {},
  ): Promise<void> {
    const showErrors = options.showErrors ?? true;
    const query = nextAddress.trim();
    if (!query || disabled) return;

    setLoading(true);
    setMapError(null);
    setDistancePreview(null);
    onDistancePreviewChange?.(null);
    try {
      const ymapsAttempt = await searchAddressViaYmaps(query);
      if (ymapsAttempt.found) return;

      if (!ymapsApi) {
        const apiAttempt = await searchAddressViaApi(query, { showErrors });
        if (apiAttempt.found) return;

        const previewAttempt = await previewDistanceViaApi(query, { showErrors });
        if (previewAttempt.found) return;

        if (showErrors) {
          setMapError(
            previewAttempt.errorMessage ??
              apiAttempt.errorMessage ??
              "Карта еще загружается. Попробуй еще раз через пару секунд.",
          );
        }
        return;
      }

      const apiAttempt = await searchAddressViaApi(query, { showErrors });
      if (apiAttempt.found) return;

      const previewAttempt = await previewDistanceViaApi(query, { showErrors });
      if (previewAttempt.found) return;

      if (showErrors) {
        setMapError(
          previewAttempt.errorMessage ??
            apiAttempt.errorMessage ??
            "Адрес не найден. Попробуй добавить улицу, дом и город.",
        );
      }
    } catch {
      if (showErrors) {
        setMapError("Не удалось найти адрес.");
      }
    } finally {
      setLoading(false);
    }
  }

  function handleAddressInput(value: string): void {
    setLocalAddress(value);
    setSelection(null);
    setDistancePreview(null);
    setMapError(null);
    onAddressChange(value);
    onSelectionChange(null);
    onDistancePreviewChange?.(null);
  }

  return (
    <div className="grid gap-2 text-sm">
      <label className="grid gap-1.5">
        <span className="text-xs font-semibold text-muted-foreground">
          Ваш адрес {required ? <span className="text-destructive">*</span> : null}
        </span>
        <div className="flex gap-2">
          <Input
            className={inputClassName}
            value={localAddress}
            disabled={disabled}
            onChange={(event) => handleAddressInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void searchAddress();
              }
            }}
            placeholder="Улица, дом"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-10 w-10 shrink-0"
            disabled={disabled || loading || localAddress.trim().length === 0}
            onClick={() => void searchAddress()}
            aria-label="Найти адрес"
          >
            <Search className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-10 w-10 shrink-0"
            disabled={disabled || !mapConfigured}
            onClick={() => setMapOpen((value) => !value)}
            aria-label={mapOpen ? "Скрыть карту" : "Открыть карту"}
            title={mapOpen ? "Скрыть карту" : "Открыть карту"}
          >
            <MapIcon className="h-4 w-4" />
          </Button>
        </div>
      </label>

      {suggestions.length > 0 ? (
        <div className="grid gap-1 rounded-md border border-border/70 bg-background/95 p-1">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.value}
              type="button"
              className="min-w-0 rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted/70"
              disabled={disabled}
              onClick={() => {
                setLocalAddress(suggestion.value);
                onAddressChange(suggestion.value);
                setSelection(null);
                onSelectionChange(null);
                setSuggestions([]);
                setMapError(null);
                void searchAddress(suggestion.value, { showErrors: false });
              }}
            >
              <span className="line-clamp-2">{suggestion.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      {mapOpen ? (
        <div className="overflow-hidden rounded-md border border-border/70 bg-muted/25">
          <div ref={mapElementRef} className="h-44 w-full" />
          {!ymapsApi ? (
            <div className="flex min-h-10 items-center gap-2 border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
              <MapPin className="h-4 w-4 shrink-0" />
              <span>Карта загружается...</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {loading || selection || distancePreview || mapError ? (
        <div
          className={`flex min-h-11 items-start gap-2 rounded-md border px-3 py-2 text-xs ${
            selection
              ? selection.zone.toneClassName
              : distancePreview
                ? "border-amber-300/40 bg-amber-400/10 text-amber-400"
              : loading
                ? "border-sky-300/40 bg-sky-400/10 text-sky-400"
                : "border-border/70 bg-background/55 text-muted-foreground"
          }`}
        >
          {selection ? (
            <Navigation className="mt-0.5 h-4 w-4 shrink-0" />
          ) : distancePreview ? (
            <Navigation className="mt-0.5 h-4 w-4 shrink-0" />
          ) : loading ? (
            <Search className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span className="min-w-0">
            <span className="block font-semibold">
              {selection
                ? `Расстояние от точки: ${formatDistanceKm(selection.distanceKm)}`
                : distancePreview
                  ? `Примерное расстояние от точки: ${formatDistanceKm(distancePreview.distanceKm)}`
                : loading
                  ? "Считаю расстояние..."
                  : "Расстояние не посчитано"}
            </span>
            <span className="mt-0.5 block text-[11px] opacity-80">
              {selection
                ? `${origin.label} • ${selection.zone.title} • ${selection.zone.feeHint}`
                : distancePreview
                  ? `${origin.label} • через подсказки Яндекса • координаты пока не получены`
                : loading
                  ? localAddress
                  : mapError}
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
