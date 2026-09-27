/** Minimal HTTP helpers shared by every route handler. */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/**
 * Turn a thrown value into a response.
 *
 * `HttpError` messages are written by us and are safe to return — they
 * are what the user is meant to read. Anything else is an unexpected
 * failure whose message may quote a SQL fragment, a file path or a
 * provider payload, so production returns a fixed sentence and logs the
 * real thing server-side instead.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.status },
    );
  }
  const isProduction = (process.env.NODE_ENV ?? "").toLowerCase() === "production";
  if ((process.env.NODE_ENV ?? "").toLowerCase() !== "test") {
    console.error("[api] unhandled error", error);
  }
  return Response.json(
    {
      error: {
        code: "INTERNAL",
        message: isProduction
          ? "Something went wrong on our side. Try again in a moment."
          : error instanceof Error
            ? error.message
            : "Unexpected error",
      },
    },
    { status: 500 },
  );
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body must be JSON.");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
