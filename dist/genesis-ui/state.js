// The interface's persisted state.
import fs from "node:fs/promises";
import { normalizeMemoryAdmissionPolicy } from "../memory/admission.js";
export async function loadState(statePath) {
    try {
        const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
        return {
            archivedWorkerIds: Array.isArray(parsed.archivedWorkerIds) ? parsed.archivedWorkerIds.map(String) : [],
            queuePaused: parsed.queuePaused === true,
            app: parsed.app && typeof parsed.app === "object" ? parsed.app : {},
            toolApprovals: parsed.toolApprovals && typeof parsed.toolApprovals === "object" ? parsed.toolApprovals : {},
            memoryAdmission: normalizeMemoryAdmissionPolicy(parsed.memoryAdmission),
            cronJobs: Array.isArray(parsed.cronJobs) ? parsed.cronJobs : [],
            cronEvents: Array.isArray(parsed.cronEvents) ? parsed.cronEvents : []
        };
    }
    catch {
        return { archivedWorkerIds: [], queuePaused: false, app: {}, toolApprovals: {}, memoryAdmission: normalizeMemoryAdmissionPolicy(null), cronJobs: [], cronEvents: [] };
    }
}
//# sourceMappingURL=state.js.map