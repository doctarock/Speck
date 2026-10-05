export class EventBus {
    repository;
    handlers = new Map();
    constructor(repository) {
        this.repository = repository;
    }
    on(type, handler) {
        const handlers = this.handlers.get(type) ?? new Set();
        handlers.add(handler);
        this.handlers.set(type, handlers);
        return () => handlers.delete(handler);
    }
    persist(event) {
        return this.repository.append(event);
    }
    async dispatch(event) {
        const handlers = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get("*") ?? [])];
        for (const handler of handlers)
            await handler(event);
    }
    async publish(event) {
        const persisted = this.persist(event);
        await this.dispatch(persisted);
        return persisted;
    }
}
//# sourceMappingURL=event-bus.js.map