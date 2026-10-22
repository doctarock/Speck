export class SpeckError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 400) {
    super(message);
    this.name = "SpeckError";
  }
}

export class NotFoundError extends SpeckError {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was not found`, "NOT_FOUND", 404);
  }
}

export class InvalidTransitionError extends SpeckError {
  constructor(from: string, to: string) {
    super(`Invalid worker transition: ${from} -> ${to}`, "INVALID_TRANSITION", 409);
  }
}

export class RevisionConflictError extends SpeckError {
  constructor(id: string) {
    super(`Worker ${id} was modified concurrently`, "REVISION_CONFLICT", 409);
  }
}
