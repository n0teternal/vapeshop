import { useEffect, useMemo, useState } from "react";
import { buildImageCandidates } from "../utils/imageCandidates";

type ProductImagePreviewProps = {
  imageUrl: string | null | undefined;
  alt: string;
  className: string;
  placeholderClassName: string;
  placeholderLabel?: string;
  loading?: "eager" | "lazy";
  targetWidth?: number;
};

export function ProductImagePreview({
  imageUrl,
  alt,
  className,
  placeholderClassName,
  placeholderLabel = "Photo",
  loading = "lazy",
  targetWidth,
}: ProductImagePreviewProps) {
  const imageCandidates = useMemo(
    () => buildImageCandidates(imageUrl, { targetWidth }),
    [imageUrl, targetWidth],
  );
  const [imageIndex, setImageIndex] = useState(0);

  useEffect(() => {
    setImageIndex(0);
  }, [imageUrl, targetWidth]);

  const imageSrc = imageCandidates[imageIndex] ?? null;

  if (!imageSrc) {
    return (
      <div className={placeholderClassName}>
        {placeholderLabel}
      </div>
    );
  }

  return (
    <img
      src={imageSrc}
      alt={alt}
      loading={loading}
      fetchPriority={loading === "eager" ? "high" : "auto"}
      decoding="async"
      referrerPolicy="no-referrer"
      className={className}
      onError={() => {
        setImageIndex((prev) => {
          if (prev >= imageCandidates.length - 1) return prev;
          return prev + 1;
        });
      }}
    />
  );
}
