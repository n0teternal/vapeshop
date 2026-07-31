import { config } from "../config.js";
import { HttpError } from "../httpError.js";

type CitySlug = "vvo" | "blg";

export type DeliveryGeocodeResult = {
  address: string;
  lat: number;
  lon: number;
};

type YandexSuggestResult = {
  uri: string;
  address: string | null;
};

type CityGeocodeConfig = {
  label: string;
  queryPrefix: string;
  ll: string;
  spn: string;
};

const CITY_GEOCODE_CONFIGS: Record<CitySlug, CityGeocodeConfig> = {
  vvo: {
    label: "Владивосток",
    queryPrefix: "Россия, Приморский край, Владивосток",
    ll: "131.90,43.12",
    spn: "0.45,0.38",
  },
  blg: {
    label: "Благовещенск",
    queryPrefix: "Россия, Амурская область, Благовещенск",
    ll: "127.55,50.27",
    spn: "0.30,0.18",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function getAddressTailAfterCity(citySlug: CitySlug, rawQuery: string): string | null {
  const cityConfig = CITY_GEOCODE_CONFIGS[citySlug];
  const cityLabel = normalizeSearchText(cityConfig.label);
  const parts = rawQuery
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const cityIndex = parts.findIndex((part) => normalizeSearchText(part).includes(cityLabel));
  if (cityIndex < 0 || cityIndex >= parts.length - 1) return null;

  return parts.slice(cityIndex + 1).join(", ");
}

function buildGeocodeQueries(citySlug: CitySlug, address: string): string[] {
  const query = address.trim();
  const cityConfig = CITY_GEOCODE_CONFIGS[citySlug];
  const baseQueries = uniqueStrings([query, getAddressTailAfterCity(citySlug, query) ?? ""]);
  const queryVariants = baseQueries.flatMap((value) => buildStreetHouseQueryVariants(value));

  return uniqueStrings(
    queryVariants.flatMap((value) => [
      `${cityConfig.queryPrefix}, ${value}`,
      `Россия, ${value}`,
      value,
    ]),
  );
}

function buildSuggestQueries(citySlug: CitySlug, address: string): string[] {
  const query = address.trim();
  const cityConfig = CITY_GEOCODE_CONFIGS[citySlug];
  const tail = getAddressTailAfterCity(citySlug, query);

  return uniqueStrings([
    tail ?? "",
    query,
    tail ? `${cityConfig.queryPrefix}, ${tail}` : "",
    `${cityConfig.queryPrefix}, ${query}`,
  ]);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getYandexErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const message = readString(payload.message) ?? readString(payload.error);
  if (message) return message;

  const response = payload.response;
  if (!isRecord(response)) return null;
  return readString(response.message) ?? readString(response.error);
}

function parseYandexGeocodeResult(payload: unknown): DeliveryGeocodeResult | null {
  if (!isRecord(payload)) return null;
  const response = payload.response;
  if (!isRecord(response)) return null;
  const collection = response.GeoObjectCollection;
  if (!isRecord(collection)) return null;
  const featureMember = collection.featureMember;
  if (!Array.isArray(featureMember)) return null;
  const first = featureMember[0];
  if (!isRecord(first)) return null;
  const geoObject = first.GeoObject;
  if (!isRecord(geoObject)) return null;

  const point = geoObject.Point;
  if (!isRecord(point)) return null;
  const pos = readString(point.pos);
  if (!pos) return null;

  const [lonRaw, latRaw] = pos.split(/\s+/g);
  const lon = Number(lonRaw);
  const lat = Number(latRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const meta = geoObject.metaDataProperty;
  const geocoderMeta = isRecord(meta) ? meta.GeocoderMetaData : null;
  const address =
    isRecord(geocoderMeta)
      ? readString(geocoderMeta.text) ?? readString(geocoderMeta.AddressDetails)
      : null;
  const name = readString(geoObject.name);
  const description = readString(geoObject.description);

  return {
    address: address ?? [name, description].filter(Boolean).join(", "),
    lat,
    lon,
  };
}

async function requestYandexGeocode(params: {
  citySlug: CitySlug;
  query: string;
  restrictToCity: boolean;
}): Promise<DeliveryGeocodeResult | null> {
  if (!config.yandex.geocoderApiKey) {
    throw new HttpError(
      503,
      "YANDEX_GEOCODER_NOT_CONFIGURED",
      "Добавь YANDEX_GEOCODER_API_KEY в Railway.",
    );
  }

  const cityConfig = CITY_GEOCODE_CONFIGS[params.citySlug];
  const url = new URL("https://geocode-maps.yandex.ru/v1/");
  url.searchParams.set("apikey", config.yandex.geocoderApiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("lang", "ru_RU");
  url.searchParams.set("results", "1");
  url.searchParams.set("geocode", params.query);

  if (params.restrictToCity) {
    url.searchParams.set("ll", cityConfig.ll);
    url.searchParams.set("spn", cityConfig.spn);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });
  } catch (error) {
    throw new HttpError(
      502,
      "YANDEX_GEOCODER_NETWORK",
      error instanceof Error ? error.message : "Yandex Geocoder network error",
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const yandexMessage = getYandexErrorMessage(payload);
    throw new HttpError(
      response.status,
      "YANDEX_GEOCODER_ERROR",
      yandexMessage ?? `Yandex Geocoder returned HTTP ${response.status}`,
    );
  }

  return parseYandexGeocodeResult(payload);
}

function parseYandexSuggestResults(payload: unknown): YandexSuggestResult[] {
  if (!isRecord(payload)) return [];
  const results = payload.results;
  if (!Array.isArray(results)) return [];

  const out: YandexSuggestResult[] = [];
  const seen = new Set<string>();

  for (const item of results) {
    if (!isRecord(item)) continue;
    const uri = readString(item.uri);
    if (!uri || seen.has(uri)) continue;

    const title = isRecord(item.title) ? readString(item.title.text) : null;
    const subtitle = isRecord(item.subtitle) ? readString(item.subtitle.text) : null;
    const address = isRecord(item.address)
      ? readString(item.address.formatted_address)
      : null;
    const fallbackAddress = [subtitle, title].filter(Boolean).join(", ");

    seen.add(uri);
    out.push({
      uri,
      address: address ?? (fallbackAddress || null),
    });
  }

  return out;
}

async function requestYandexSuggest(params: {
  citySlug: CitySlug;
  query: string;
}): Promise<YandexSuggestResult[]> {
  if (!config.yandex.geosuggestApiKey) return [];

  const cityConfig = CITY_GEOCODE_CONFIGS[params.citySlug];
  const url = new URL("https://suggest-maps.yandex.ru/v1/suggest");
  url.searchParams.set("apikey", config.yandex.geosuggestApiKey);
  url.searchParams.set("text", params.query);
  url.searchParams.set("lang", "ru_RU");
  url.searchParams.set("results", "5");
  url.searchParams.set("attrs", "uri");
  url.searchParams.set("print_address", "1");
  url.searchParams.set("types", "house");
  url.searchParams.set("countries", "ru");
  url.searchParams.set("ll", cityConfig.ll);
  url.searchParams.set("spn", cityConfig.spn);
  url.searchParams.set("strict_bounds", "1");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });
  } catch {
    return [];
  }

  if (!response.ok) return [];

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  return parseYandexSuggestResults(payload);
}

async function requestYandexGeocodeByUri(params: {
  uri: string;
  fallbackAddress: string | null;
}): Promise<DeliveryGeocodeResult | null> {
  if (!config.yandex.geocoderApiKey) {
    throw new HttpError(
      503,
      "YANDEX_GEOCODER_NOT_CONFIGURED",
      "Добавь YANDEX_GEOCODER_API_KEY в Railway.",
    );
  }

  const url = new URL("https://geocode-maps.yandex.ru/v1/");
  url.searchParams.set("apikey", config.yandex.geocoderApiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("lang", "ru_RU");
  url.searchParams.set("results", "1");
  url.searchParams.set("uri", params.uri);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });
  } catch (error) {
    throw new HttpError(
      502,
      "YANDEX_GEOCODER_NETWORK",
      error instanceof Error ? error.message : "Yandex Geocoder network error",
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const yandexMessage = getYandexErrorMessage(payload);
    throw new HttpError(
      response.status,
      "YANDEX_GEOCODER_ERROR",
      yandexMessage ?? `Yandex Geocoder returned HTTP ${response.status}`,
    );
  }

  const result = parseYandexGeocodeResult(payload);
  if (!result) return null;

  return {
    ...result,
    address: result.address || params.fallbackAddress || "",
  };
}

export async function geocodeDeliveryAddress(params: {
  citySlug: CitySlug;
  address: string;
}): Promise<DeliveryGeocodeResult> {
  const trimmedAddress = params.address.trim();
  if (trimmedAddress.length < 3) {
    throw new HttpError(400, "BAD_REQUEST", "address is too short");
  }

  const queries = buildGeocodeQueries(params.citySlug, trimmedAddress);
  const suggestQueries = buildSuggestQueries(params.citySlug, trimmedAddress);
  const seenSuggestUris = new Set<string>();

  for (const query of suggestQueries) {
    const suggestions = await requestYandexSuggest({
      citySlug: params.citySlug,
      query,
    });

    for (const suggestion of suggestions) {
      if (seenSuggestUris.has(suggestion.uri)) continue;
      seenSuggestUris.add(suggestion.uri);

      const byUri = await requestYandexGeocodeByUri({
        uri: suggestion.uri,
        fallbackAddress: suggestion.address ?? trimmedAddress,
      });
      if (byUri) return byUri;
    }
  }

  for (const query of queries) {
    const restricted = await requestYandexGeocode({
      citySlug: params.citySlug,
      query,
      restrictToCity: true,
    });
    if (restricted) return restricted;
  }

  for (const query of queries) {
    const unrestricted = await requestYandexGeocode({
      citySlug: params.citySlug,
      query,
      restrictToCity: false,
    });
    if (unrestricted) return unrestricted;
  }

  throw new HttpError(
    404,
    "ADDRESS_NOT_FOUND",
    "Адрес не найден. Попробуй добавить улицу, дом и город.",
  );
}
