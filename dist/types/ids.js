import { randomUUID } from "node:crypto";
export const createWorkerId = () => randomUUID();
export const createMentalObjectId = () => randomUUID();
export const createCognitiveEventId = () => randomUUID();
function parseId(value, label) {
    const normalized = String(value ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
        throw new TypeError(`${label} must be a UUID`);
    }
    return normalized;
}
export const parseWorkerId = (value) => parseId(value, "WorkerId");
export const parseMentalObjectId = (value) => parseId(value, "MentalObjectId");
export const parseCognitiveEventId = (value) => parseId(value, "CognitiveEventId");
//# sourceMappingURL=ids.js.map