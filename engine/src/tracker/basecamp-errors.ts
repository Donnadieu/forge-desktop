/**
 * Thrown by the Basecamp REST client when the API returns a non-2xx HTTP
 * response. Mirrors `linear-errors.ts`'s `LinearHttpError` — the status code
 * lets retry layers distinguish 4xx (do not retry) from 5xx (retry).
 */
export class BasecampHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
  ) {
    super(`Basecamp API error: ${status} ${statusText}`);
    this.name = "BasecampHttpError";
  }
}
