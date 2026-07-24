/**
 * Typed HTTP client over `fetch` — the SPA's only REST surface
 * (docs/api-contract.md §6, docs/frontend-brief.md §8.5). A pure API
 * consumer: no engine/db access, ever. Non-2xx responses reject with a
 * structured {@link ApiError} carrying the envelope `code`/`current_status`,
 * so callers branch on `code` (never on message text — api-contract §3).
 *
 * `baseUrl` defaults to same-origin (""), matching the deployment: in dev the
 * Vite server proxies `/tasks`, `/events`, `/health` to the api; in prod the
 * api serves the built SPA. The key travels as `Authorization: Bearer <key>`
 * on every REST call; `/events` uses `?api_key=` (see sse.ts).
 */
import type {
  ErrorEnvelope,
  HistoryResponse,
  SubmitInput,
  Task,
  TaskFilters,
  TaskListResponse,
  TaskStatus,
} from "./types.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentStatus?: TaskStatus;
  readonly lane?: string;
  /** True when the request never reached the server (offline, DNS, CORS…). */
  readonly isNetworkError: boolean;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    currentStatus?: TaskStatus;
    lane?: string;
    isNetworkError?: boolean;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.currentStatus = init.currentStatus;
    this.lane = init.lane;
    this.isNetworkError = init.isNetworkError ?? false;
  }
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

export class ApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = ""
  ) {}

  /** The raw key — sse.ts needs it to build the `?api_key=` stream URL. */
  get key(): string {
    return this.apiKey;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
      });
    } catch (err) {
      throw new ApiError({
        status: 0,
        code: "network_error",
        message: err instanceof Error ? err.message : "Could not reach the server.",
        isNetworkError: true,
      });
    }

    const text = await res.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }

    if (!res.ok) {
      const envelope = (body as ErrorEnvelope | null)?.error;
      throw new ApiError({
        status: res.status,
        code: envelope?.code ?? "internal_error",
        message: envelope?.message ?? `Request failed with status ${res.status}.`,
        currentStatus: envelope?.current_status,
        lane: typeof envelope?.lane === "string" ? envelope.lane : undefined,
      });
    }

    return body as T;
  }

  /** `GET /tasks` — snapshot/hydration, filter changes, pagination. Also the
   * key-validation call (a `limit: 1` fetch that 401s on a bad key). */
  listTasks(filters: TaskFilters = {}, opts: ListOptions = {}): Promise<TaskListResponse> {
    const query = buildQuery({
      status: filters.status,
      lane: filters.lane,
      from: filters.from,
      to: filters.to,
      sort: filters.sort,
      limit: opts.limit,
      cursor: opts.cursor,
    });
    return this.request<TaskListResponse>(`/tasks${query}`);
  }

  /** `GET /tasks/id/{id}` — detail mount, and the event-driven backfill for a
   * task the store has not seen (frontend-brief §5.1). */
  getById(id: string): Promise<Task> {
    return this.request<Task>(`/tasks/id/${encodeURIComponent(id)}`);
  }

  /** `GET /tasks/id/{id}/history` — the detail timeline. */
  getHistory(id: string): Promise<HistoryResponse> {
    return this.request<HistoryResponse>(`/tasks/id/${encodeURIComponent(id)}/history`);
  }

  /** `POST /tasks` — submit. Returns the 201 task object; the store still
   * waits for the `accepted` event before confirming (frontend-brief §6.4). */
  submit(input: SubmitInput): Promise<Task> {
    const params: Record<string, unknown> = {};
    if (input.duration_ms !== undefined) params.duration_ms = input.duration_ms;
    if (input.fail !== undefined) params.fail = input.fail;
    if (input.fail_permanent !== undefined) params.fail_permanent = input.fail_permanent;

    const body: Record<string, unknown> = { lane: input.lane, params };
    if (input.max_attempts !== undefined) body.max_attempts = input.max_attempts;

    return this.request<Task>("/tasks", { method: "POST", body: JSON.stringify(body) });
  }

  /** `GET /tasks/{handle}/result` — the one side-effecting read: flips
   * `collected`, frees the handle, emits `collected`. Call ONLY on an explicit
   * operator action, never on render/navigation (frontend-brief §6.1). */
  collect(handle: string): Promise<Task> {
    return this.request<Task>(`/tasks/${encodeURIComponent(handle)}/result`);
  }

  /** `POST /tasks/{handle}/cancel`. */
  cancel(handle: string): Promise<Task> {
    return this.request<Task>(`/tasks/${encodeURIComponent(handle)}/cancel`, { method: "POST" });
  }

  /** `POST /tasks/{handle}/retry`. */
  retry(handle: string): Promise<Task> {
    return this.request<Task>(`/tasks/${encodeURIComponent(handle)}/retry`, { method: "POST" });
  }
}
