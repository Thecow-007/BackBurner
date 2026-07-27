/**
 * Thin typed HTTP client over `fetch` for the contract in api-contract.md §6.
 * Never throws on a non-2xx response — the criteria and supplemental suites
 * assert on status codes and error envelopes directly, so every call
 * resolves to `{ status, headers, body }` regardless of outcome. Timing is
 * never encoded here; callers measure and compare against `timing.ts`.
 */

export type TaskStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export interface TaskError {
  reason: string;
  retryable: boolean;
}

/** The task object (api-contract §4): nine spec fields, four additive fields. */
export interface TaskObject {
  // Spec fields — [SPEC]
  handle: string;
  lane: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  result: unknown | null;
  error: TaskError | null;
  created_at: string;
  updated_at: string;
  collected: boolean;
  // Additive fields — [EXTENSION]
  id: string;
  attempts: number;
  max_attempts: number;
  seeded: boolean;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    current_status?: string;
    lane?: string;
    [key: string]: unknown;
  };
}

/** A lane's `[min, max]` range for an omitted `params.duration_ms`
 * (api-contract §1, §6.2's `lane_defaults`). */
export interface LaneDurationDefault {
  duration_ms: { min: number; max: number };
}

/** The `counts` object on the list envelope (api-contract §6.2,
 * [EXTENSION]). Every field has its own filter basis — see the contract. */
export interface TaskCounts {
  all: number;
  matching: number;
  uncollected: number;
  status: Record<TaskStatus, number>;
  lane: Record<string, number>;
  lanes: string[];
  /** One entry per mock-worker-backed lane, in registration order. */
  lane_defaults: Record<string, LaneDurationDefault>;
}

/** `GET /tasks` response envelope (api-contract §6.2). */
export interface TaskListResponse {
  tasks: TaskObject[];
  as_of: number;
  next_cursor: string | null;
  counts: TaskCounts;
}

export interface HistoryTransition {
  event_type: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  at: string;
  meta: Record<string, unknown>;
}

/** `GET /tasks/id/{id}/history` response envelope (api-contract §6.8). */
export interface HistoryResponse {
  transitions: HistoryTransition[];
}

/** Query parameters for `GET /tasks` (api-contract §7). Left as loose types
 * (not enums) on purpose: the validation-400s suite deliberately sends
 * out-of-range/invalid values (bad status, bad sort key, limit=201, ...) and
 * must be able to construct them through this same helper. */
export interface ListQuery {
  status?: string;
  lane?: string;
  from?: string;
  to?: string;
  sort?: string;
  limit?: number | string;
  cursor?: string;
  /** `?uncollected=` — the only valid value is the string `"true"`; the
   * validation suite deliberately sends others. */
  uncollected?: string;
  /** `?q=` free-text handle/id lookup. */
  q?: string;
}

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

export interface RequestOptions {
  method?: string;
  path: string;
  /** Raw API key. Sent as `Authorization: Bearer <key>`. Omit for unauthenticated calls. */
  key?: string;
  /** JSON-serialized if not already a string. Use a string directly to send
   * deliberately malformed JSON (validation-400s suite). */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Raw header overrides/additions — e.g. a malformed `Authorization` value,
   * or `?api_key=` parity tests. Applied after the computed defaults, so
   * these win on conflict. */
  headers?: Record<string, string>;
}

/**
 * Escape hatch: an arbitrary request against the running server. Never
 * throws on non-2xx; the body is parsed as JSON when possible, otherwise
 * returned as the raw text (empty string becomes `null`).
 */
export async function request<T = unknown>(
  baseUrl: string,
  options: RequestOptions
): Promise<ApiResponse<T>> {
  const url = new URL(options.path, baseUrl);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {};
  if (options.key !== undefined) {
    headers["Authorization"] = `Bearer ${options.key}`;
  }

  let bodyText: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyText = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }

  Object.assign(headers, options.headers);

  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: bodyText,
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  return { status: res.status, headers: res.headers, body: parsed as T };
}

export interface SubmitBody {
  lane: string;
  params?: Record<string, unknown>;
  max_attempts?: number;
}

/** `POST /tasks` (api-contract §6.1). `body` is intentionally `unknown` —
 * the validation-400s suite sends malformed shapes (arrays, wrong types,
 * unknown top-level fields, raw invalid-JSON strings). */
export function submit(
  baseUrl: string,
  key: string,
  body: unknown
): Promise<ApiResponse<TaskObject | ErrorEnvelope>> {
  return request(baseUrl, { method: "POST", path: "/tasks", key, body });
}

/** `GET /tasks/{handle}` (api-contract §6.3). */
export function getTask(
  baseUrl: string,
  key: string,
  handle: string
): Promise<ApiResponse<TaskObject | ErrorEnvelope>> {
  return request(baseUrl, { path: `/tasks/${handle}`, key });
}

/** `GET /tasks/{handle}/result` (api-contract §6.4) — the one GET with a
 * side effect (flips `collected`, frees the handle, emits `collected`).
 * Never call this automatically; only on explicit test action. */
export function collect(
  baseUrl: string,
  key: string,
  handle: string
): Promise<ApiResponse<TaskObject | ErrorEnvelope>> {
  return request(baseUrl, { path: `/tasks/${handle}/result`, key });
}

/** `POST /tasks/{handle}/cancel` (api-contract §6.5). */
export function cancel(
  baseUrl: string,
  key: string,
  handle: string
): Promise<ApiResponse<TaskObject | ErrorEnvelope>> {
  return request(baseUrl, { method: "POST", path: `/tasks/${handle}/cancel`, key });
}

/** `POST /tasks/{handle}/retry` (api-contract §6.6). */
export function retry(
  baseUrl: string,
  key: string,
  handle: string
): Promise<ApiResponse<TaskObject | ErrorEnvelope>> {
  return request(baseUrl, { method: "POST", path: `/tasks/${handle}/retry`, key });
}

/** `GET /tasks` (api-contract §6.2, §7). */
export function listTasks(
  baseUrl: string,
  key: string,
  query: ListQuery = {}
): Promise<ApiResponse<TaskListResponse | ErrorEnvelope>> {
  return request(baseUrl, { path: "/tasks", key, query: query as Record<string, string | number | undefined> });
}

/** `GET /tasks/id/{id}` (api-contract §6.7). */
export function getById(
  baseUrl: string,
  key: string,
  id: string
): Promise<ApiResponse<TaskObject | ErrorEnvelope>> {
  return request(baseUrl, { path: `/tasks/id/${id}`, key });
}

/** `GET /tasks/id/{id}/history` (api-contract §6.8). */
export function getHistory(
  baseUrl: string,
  key: string,
  id: string
): Promise<ApiResponse<HistoryResponse | ErrorEnvelope>> {
  return request(baseUrl, { path: `/tasks/id/${id}/history`, key });
}

/** `GET /health` (api-contract §6.10) — unauthenticated. */
export function health(
  baseUrl: string
): Promise<ApiResponse<{ status: string } | ErrorEnvelope>> {
  return request(baseUrl, { path: "/health" });
}
