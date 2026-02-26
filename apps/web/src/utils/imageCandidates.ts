import { buildApiUrl } from "../config";

const SUPABASE_OBJECT_PUBLIC_MARKER = "/storage/v1/object/public/";
const SUPABASE_RENDER_PUBLIC_MARKER = "/storage/v1/render/image/public/";

function buildSupabaseRenderUrl(absoluteUrl: string, width: number): string | null {
  try {
    const parsed = new URL(absoluteUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.pathname.includes(SUPABASE_OBJECT_PUBLIC_MARKER)) {
      return null;
    }

    const markerIndex = parsed.pathname.indexOf(SUPABASE_OBJECT_PUBLIC_MARKER);
    if (markerIndex < 0) return null;
    const tail = parsed.pathname.slice(markerIndex + SUPABASE_OBJECT_PUBLIC_MARKER.length);
    if (!tail) return null;

    const rendered = new URL(parsed.toString());
    rendered.pathname = `${parsed.pathname.slice(
      0,
      markerIndex,
    )}${SUPABASE_RENDER_PUBLIC_MARKER}${tail}`;

    const query = rendered.searchParams;
    query.set("width", String(width));
    query.set("quality", "76");
    query.delete("format");
    rendered.search = query.toString();
    return rendered.toString();
  } catch {
    return null;
  }
}

function getResponsiveWidths(targetWidth: number | undefined): number[] {
  if (!targetWidth || !Number.isFinite(targetWidth)) {
    return [];
  }

  const safe = Math.max(64, Math.min(1920, Math.round(targetWidth)));
  const retina = Math.max(64, Math.min(1920, Math.round(safe * 2)));
  if (retina === safe) return [safe];
  return [retina, safe];
}

function buildProxyImageUrl(absoluteUrl: string): string | null {
  if (absoluteUrl.startsWith("/api/image-proxy?url=")) return null;

  try {
    const parsed = new URL(absoluteUrl);
    if (parsed.pathname.startsWith("/api/image-proxy")) {
      return null;
    }
    if (parsed.pathname.includes(SUPABASE_RENDER_PUBLIC_MARKER)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return buildApiUrl(`/api/image-proxy?url=${encodeURIComponent(parsed.toString())}`);
  } catch {
    return null;
  }
}

export function buildImageCandidates(
  imageUrl: string | null | undefined,
  options?: { targetWidth?: number },
): string[] {
  const raw = imageUrl?.trim() ?? "";
  if (!raw) return [];
  const responsiveWidths = getResponsiveWidths(options?.targetWidth);

  const directCandidates = new Set<string>();
  const pushDirect = (value: string) => {
    if (value.trim().length === 0) return;
    directCandidates.add(value);
  };

  const match = raw.match(/^([^?#]+)(.*)$/);
  if (!match) {
    pushDirect(raw);
  } else {
    const pathPart = match[1];
    const suffix = match[2] ?? "";
    if (pathPart) {
      const extMatch = pathPart.match(/\.([a-z0-9]{2,10})$/i);
      if (extMatch) {
        const ext = `.${(extMatch[1] ?? "").toLowerCase()}`;
        const base = pathPart.slice(0, -ext.length);
        const variants = [".webp", ".jpg", ".jpeg", ".png"];
        // Keep the original first when extension is already known.
        pushDirect(raw);
        for (const variant of variants) {
          if (variant === ext) continue;
          pushDirect(`${base}${variant}${suffix}`);
        }
      } else {
        // If extension is missing, try common image formats first.
        pushDirect(`${pathPart}.webp${suffix}`);
        pushDirect(`${pathPart}.jpg${suffix}`);
        pushDirect(`${pathPart}.jpeg${suffix}`);
        pushDirect(`${pathPart}.png${suffix}`);
        pushDirect(raw);
      }
    } else {
      pushDirect(raw);
    }
  }

  const prioritizedDirect = new Set<string>();
  for (const candidate of directCandidates) {
    for (const width of responsiveWidths) {
      const rendered = buildSupabaseRenderUrl(candidate, width);
      if (rendered) prioritizedDirect.add(rendered);
    }
    prioritizedDirect.add(candidate);
  }

  const candidates = new Set<string>();
  for (const candidate of prioritizedDirect) {
    // Try direct URLs first; proxy is fallback.
    candidates.add(candidate);
    const proxied = buildProxyImageUrl(candidate);
    if (proxied) candidates.add(proxied);
  }

  return Array.from(candidates);
}
