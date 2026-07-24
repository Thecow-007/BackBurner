/**
 * Typed engine errors — docs/architecture.md §2. These map 1:1 to HTTP
 * statuses in @backburner/api via `instanceof` checks; the engine itself
 * never knows about HTTP.
 */
export class UnknownLaneError extends Error {
  readonly name = "UnknownLaneError";
  readonly lane: string;
  constructor(lane: string) {
    super(`no worker is registered for lane "${lane}"`);
    this.lane = lane;
    Object.setPrototypeOf(this, UnknownLaneError.prototype);
  }
}

export class ValidationError extends Error {
  readonly name = "ValidationError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class NotFoundError extends Error {
  readonly name = "NotFoundError";
  constructor(message = "task not found") {
    super(message);
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class InvalidStateError extends Error {
  readonly name = "InvalidStateError";
  readonly current_status: string;
  constructor(current_status: string, message?: string) {
    super(message ?? `illegal transition from current status "${current_status}"`);
    this.current_status = current_status;
    Object.setPrototypeOf(this, InvalidStateError.prototype);
  }
}
