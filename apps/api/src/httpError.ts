export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isHttpError(value: unknown): value is HttpError {
  if (value instanceof HttpError) return true;
  if (!isRecord(value)) return false;

  return (
    typeof value.statusCode === "number" &&
    Number.isFinite(value.statusCode) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

