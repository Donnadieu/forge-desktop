/** Linear GraphQL error shape, exposed for retry layers and tests. */
export interface LinearGraphQLErrorEntry {
  message: string;
  extensions?: { code?: string };
}

/**
 * Thrown by the GraphQL helper when the Linear API returns a non-2xx HTTP
 * response. The status code lets retry layers distinguish 4xx (do not retry)
 * from 5xx (retry).
 */
export class LinearHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
  ) {
    super(`Linear API error: ${status} ${statusText}`);
    this.name = "LinearHttpError";
  }
}

/**
 * Thrown when the Linear API returns a 200 with `errors[]`. The first error's
 * `extensions.code` is exposed so retry layers can recognize transient
 * `INTERNAL_ERROR` responses.
 */
export class LinearGraphQLError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly errors: LinearGraphQLErrorEntry[],
  ) {
    super(message);
    this.name = "LinearGraphQLError";
  }
}
