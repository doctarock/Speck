// Reading the user's workspace (admitted 2026-10-21): list_files and
// read_file over Speck's confined workspace, inbox and outbox, as a read-only
// tool family (tool-component.ts). Gate results: docs/REINTEGRATION.md.

import { toolComponent } from "./tool-component.js";

export const FILE_TOOLS = ["list_files", "read_file"] as const;

export const files = toolComponent({
  id: "files",
  tools: FILE_TOOLS,
  option: {
    label: "Read workspace files",
    description: "Lets Speck list and read files in its workspace and inbox when a message needs them. It is a feature: answers that need no file are unchanged.",
    cost: "about 5–8 s per message (the worker model decides whether a file is needed)",
    enabledByDefault: true
  },
  heading: "Speck read the user's workspace for this message (these results are real):"
});
