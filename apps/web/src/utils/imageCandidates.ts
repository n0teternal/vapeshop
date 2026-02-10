function buildProxyImageUrl(absoluteUrl: string): string | null {
  if (absoluteUrl.startsWith("/api/image-proxy?url=")) return null;

  try {
    const parsed = new URL(absoluteUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return `/api/image-proxy?url=${encodeURIComponent(parsed.toString())}`;
  } catch {
    return null;
  }
}

export function buildImageCandidates(imageUrl: string | null | undefined): string[] {
  const raw = imageUrl?.trim() ?? "";
  if (!raw) return [];

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
      pushDirect(raw);

      const extMatch = pathPart.match(/\.([a-z0-9]{2,10})$/i);
      if (extMatch) {
        const ext = `.${(extMatch[1] ?? "").toLowerCase()}`;
        const base = pathPart.slice(0, -ext.length);
        const variants = [".webp", ".jpg", ".jpeg", ".png"];
        for (const variant of variants) {
          if (variant === ext) continue;
          pushDirect(`${base}${variant}${suffix}`);
        }
      } else {
        pushDirect(`${pathPart}.webp${suffix}`);
        pushDirect(`${pathPart}.jpg${suffix}`);
        pushDirect(`${pathPart}.jpeg${suffix}`);
        pushDirect(`${pathPart}.png${suffix}`);
      }
    } else {
      pushDirect(raw);
    }
  }

  const candidates = new Set<string>();
  for (const candidate of directCandidates) {
    const proxied = buildProxyImageUrl(candidate);
    if (proxied) {
      candidates.add(proxied);
    }
    candidates.add(candidate);
  }

  return Array.from(candidates);
}
