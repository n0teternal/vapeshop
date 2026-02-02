const apiBaseUrl =
  typeof import.meta.env.VITE_API_BASE_URL === "string"
    ? import.meta.env.VITE_API_BASE_URL.trim()
    : "";

export const API_BASE_URL: string = apiBaseUrl || "http://localhost:8787";
