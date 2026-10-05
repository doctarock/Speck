export class SpeckError extends Error {
    code;
    statusCode;
    constructor(message, code, statusCode = 400) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.name = "SpeckError";
    }
}
export class NotFoundError extends SpeckError {
    constructor(entity, id) {
        super(`${entity} ${id} was not found`, "NOT_FOUND", 404);
    }
}
export class InvalidTransitionError extends SpeckError {
    constructor(from, to) {
        super(`Invalid worker transition: ${from} -> ${to}`, "INVALID_TRANSITION", 409);
    }
}
export class RevisionConflictError extends SpeckError {
    constructor(id) {
        super(`Worker ${id} was modified concurrently`, "REVISION_CONFLICT", 409);
    }
}
//# sourceMappingURL=errors.js.map