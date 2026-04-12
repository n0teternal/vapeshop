import { isValidIsoDate } from "./deliverySchedule.js";

export type OrderCommentPayload = {
  citySlug: "vvo" | "blg";
  deliveryMethod: string;
  address: string | null;
  comment: string | null;
  deliveryDate: string | null;
  deliveryTimeSlot: string | null;
};

export type ParsedOrderComment = {
  address: string | null;
  comment: string | null;
  deliveryDate: string | null;
  deliveryTimeSlot: string | null;
};

function formatDeliveryDateLabel(value: string): string {
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${day}.${month}.${year}`;
}

function normalizeLineValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildOrderComment(params: OrderCommentPayload): string | null {
  const trimmedComment = params.comment?.trim() ?? "";

  if (params.deliveryMethod !== "delivery") {
    return trimmedComment.length > 0 ? trimmedComment : null;
  }

  const lines: string[] = [];
  const trimmedAddress = params.address?.trim() ?? "";
  if (trimmedAddress.length > 0) {
    lines.push(`Адрес: ${trimmedAddress}`);
  }

  if (params.citySlug === "blg" && params.deliveryDate) {
    lines.push(`Дата доставки: ${formatDeliveryDateLabel(params.deliveryDate)}`);
  }

  if (params.citySlug === "blg" && params.deliveryTimeSlot) {
    lines.push(`Время доставки: ${params.deliveryTimeSlot}`);
  }

  if (trimmedComment.length > 0) {
    lines.push(`Комментарий: ${trimmedComment}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

export function parseOrderComment(comment: string | null): ParsedOrderComment {
  if (!comment) {
    return {
      address: null,
      comment: null,
      deliveryDate: null,
      deliveryTimeSlot: null,
    };
  }

  const lines = comment
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let address: string | null = null;
  let freeformComment: string | null = null;
  let deliveryDate: string | null = null;
  let deliveryTimeSlot: string | null = null;
  const remainingCommentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("Адрес:")) {
      address = normalizeLineValue(line.slice("Адрес:".length)) ?? address;
      continue;
    }

    if (line.startsWith("Дата доставки:")) {
      const rawValue = normalizeLineValue(line.slice("Дата доставки:".length));
      if (rawValue) {
        const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(rawValue);
        if (match) {
          const nextDate = `${match[3]}-${match[2]}-${match[1]}`;
          if (isValidIsoDate(nextDate)) {
            deliveryDate = nextDate;
          }
        }
      }
      continue;
    }

    if (line.startsWith("Время доставки:")) {
      deliveryTimeSlot = normalizeLineValue(line.slice("Время доставки:".length)) ?? deliveryTimeSlot;
      continue;
    }

    if (line.startsWith("Комментарий:")) {
      freeformComment = normalizeLineValue(line.slice("Комментарий:".length));
      continue;
    }

    remainingCommentLines.push(line);
  }

  if (!freeformComment && remainingCommentLines.length > 0) {
    freeformComment = remainingCommentLines.join("\n");
  } else if (freeformComment && remainingCommentLines.length > 0) {
    freeformComment = `${freeformComment}\n${remainingCommentLines.join("\n")}`;
  }

  return {
    address,
    comment: freeformComment,
    deliveryDate,
    deliveryTimeSlot,
  };
}
