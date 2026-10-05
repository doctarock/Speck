// The Genesis profile: listing, options and selection.
import fs from "node:fs/promises";
import path from "node:path";
import { buildPublicProfile, getActiveProfileSelection, listAvailableProfiles, saveProfileSelection } from "genesis-runtime/profile-manager";
import { profilePayload, errorMessage } from "../presentation.js";
export function registerProfileRoutes(ctx) {
    const { app, runtime, config, options, state, archived, saveState, logClients, eventClients, workspaceRoot, inboxRoot, outboxRoot } = ctx;
    app.get("/api/profile", async (_req, res) => res.json(await profilePayload(options.profile, options.profileRoot)));
    app.get("/api/profile/options", async (_req, res) => res.json({
        ...(await profilePayload(options.profile, options.profileRoot)),
        envOverride: Boolean(process.env.SPECK_GENESIS_PROFILE || process.env.GENESIS_PROFILE)
    }));
    app.post("/api/profile/select", async (req, res) => {
        try {
            const profileId = String(req.body?.profileId ?? "").trim();
            const profiles = await listAvailableProfiles({ fs, rootDir: options.profileRoot });
            if (!profiles.some((candidate) => candidate.id === profileId)) {
                return res.status(400).json({ ok: false, error: `profile ${profileId || "(empty)"} is not available` });
            }
            const saved = await saveProfileSelection({
                fs,
                preferencePath: path.join(config.genesisRuntimePath, "profile-selection.json"),
                profileId
            });
            return res.json({
                ok: true,
                message: `Profile ${profileId} saved. Restart Speck to apply it.`,
                saved,
                profile: buildPublicProfile(options.profile),
                profiles,
                selection: getActiveProfileSelection(),
                restart: { requested: req.body?.restart === true, supported: false, scheduled: false, required: true },
                envOverride: Boolean(process.env.SPECK_GENESIS_PROFILE || process.env.GENESIS_PROFILE)
            });
        }
        catch (error) {
            return res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
}
//# sourceMappingURL=profile.js.map