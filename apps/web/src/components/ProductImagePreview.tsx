import { useEffect, useMemo, useState } from "react";
import { buildImageCandidates } from "../utils/imageCandidates";

type ProductImagePreviewProps = {
  imageUrl: string | null | undefined;
  alt: string;
  className: string;
  placeholderClassName: string;
  placeholderLabel?: string;
  loading?: "eager" | "lazy";
};

export function ProductImagePreview({
  imageUrl,
  alt,
  className,
  placeholderClassName,
  placeholderLabel = "Photo",
  loading = "lazy",
}: ProductImagePreviewProps) {
  const imageCandidates = useMemo(() => buildImageCandidates(imageUrl), [imageUrl]);
  const [imageIndex, setImageIndex] = useState(0);

  useEffect(() => {
    setImageIndex(0);
  }, [imageUrl]);

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
