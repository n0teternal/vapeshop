export {};

declare global {
  interface Window {
    ymaps?: YMapsApi;
  }

  type YMapsCoords = [number, number];

  type YMapsEvent = {
    get(name: "coords"): YMapsCoords;
  };

  type YMapsGeoObject = {
    geometry: {
      getCoordinates(): YMapsCoords;
    };
    getAddressLine?(): string;
    properties?: {
      get(name: string): unknown;
    };
  };

  type YMapsGeocodeResult = {
    geoObjects: {
      get(index: number): YMapsGeoObject | undefined;
    };
  };

  type YMapsPlacemark = unknown;

  type YMapsMap = {
    destroy(): void;
    setCenter(coords: YMapsCoords, zoom?: number, options?: Record<string, unknown>): void;
    events: {
      add(name: string, handler: (event: YMapsEvent) => void): void;
    };
    geoObjects: {
      add(object: YMapsPlacemark): void;
      remove(object: YMapsPlacemark): void;
    };
  };

  type YMapsSuggestResult = {
    displayName?: string;
    value?: string;
  };

  type YMapsApi = {
    ready(callback: () => void): void;
    Map: new (
      element: HTMLElement,
      state: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => YMapsMap;
    Placemark: new (
      coords: YMapsCoords,
      properties?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => YMapsPlacemark;
    geocode(
      request: string | YMapsCoords,
      options?: Record<string, unknown>,
    ): Promise<YMapsGeocodeResult>;
    suggest?(
      request: string,
      options?: Record<string, unknown>,
    ): Promise<YMapsSuggestResult[]>;
  };
}
