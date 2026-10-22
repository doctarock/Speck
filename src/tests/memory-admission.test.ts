import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MEMORY_ADMISSION_POLICY, normalizeMemoryAdmissionPolicy } from "../memory/admission.js";

test("memory admission defaults every optional category off and ignores unknown settings", () => {
  assert.ok(Object.values(DEFAULT_MEMORY_ADMISSION_POLICY).every((value) => value === false));
  assert.deepEqual(normalizeMemoryAdmissionPolicy({ rawPrompts: true, unknown: true }), {
    ...DEFAULT_MEMORY_ADMISSION_POLICY,
    rawPrompts: true
  });
});
