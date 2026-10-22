import type { EventRepository } from "../persistence/event-repository.js";
import type { CognitiveEvent, CognitiveEventType, NewCognitiveEvent } from "../types/model.js";

export type EventHandler = (event: CognitiveEvent<unknown>) => void | Promise<void>;

export class EventBus {
  private readonly handlers = new Map<CognitiveEventType | "*", Set<EventHandler>>();

  constructor(private readonly repository: EventRepository) {}

  on(type: CognitiveEventType | "*", handler: EventHandler): () => void {
    const handlers = this.handlers.get(type) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    return () => handlers.delete(handler);
  }

  persist<T>(event: NewCognitiveEvent<T>): CognitiveEvent<T> {
    return this.repository.append(event);
  }

  async dispatch(event: CognitiveEvent<unknown>): Promise<void> {
    const handlers = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get("*") ?? [])];
    for (const handler of handlers) await handler(event);
  }

  async publish<T>(event: NewCognitiveEvent<T>): Promise<CognitiveEvent<T>> {
    const persisted = this.persist(event);
    await this.dispatch(persisted);
    return persisted;
  }
}
