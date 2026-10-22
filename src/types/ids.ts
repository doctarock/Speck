import { randomUUID } from "node:crypto";

declare const workerIdBrand: unique symbol;
declare const mentalObjectIdBrand: unique symbol;
declare const eventIdBrand: unique symbol;

export type WorkerId = string & { readonly [workerIdBrand]: true };
export type MentalObjectId = string & { readonly [mentalObjectIdBrand]: true };
export type CognitiveEventId = string & { readonly [eventIdBrand]: true };

export const createWorkerId = (): WorkerId => randomUUID() as WorkerId;
export const createMentalObjectId = (): MentalObjectId => randomUUID() as MentalObjectId;
export const createCognitiveEventId = (): CognitiveEventId => randomUUID() as CognitiveEventId;

function parseId<T extends string>(value: string, label: string): T {
  const normalized = String(value ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return normalized as T;
}

export const parseWorkerId = (value: string): WorkerId => parseId<WorkerId>(value, "WorkerId");
export const parseMentalObjectId = (value: string): MentalObjectId => parseId<MentalObjectId>(value, "MentalObjectId");
export const parseCognitiveEventId = (value: string): CognitiveEventId => parseId<CognitiveEventId>(value, "CognitiveEventId");
