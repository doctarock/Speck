import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeVoiceMessage, isConversationCancellation, isConversationParking } from "../genesis-ui.js";

test("conversation cancellation accepts direct stop commands without matching negations", () => {
  for (const command of ["cancel", "cancel that", "stop this task", "abort the request", "never mind", "forget it", "don't do that"]) {
    assert.equal(isConversationCancellation(command), true, command);
  }
  for (const command of ["do not cancel", "don't stop", "stop asking and write file.txt", "make a story", "cancellation policy"]) {
    assert.equal(isConversationCancellation(command), false, command);
  }
});

test("voice transcription canonicalizes the assistant name before persistence", () => {
  assert.equal(canonicalizeVoiceMessage("hello spec"), "hello Speck");
  assert.equal(canonicalizeVoiceMessage("SPEC please listen"), "Speck please listen");
});

test("parking commands set a task aside; they are not cancellations", () => {
  for (const phrase of ["park this", "Park it.", "come back to this later", "let's come back to it later", "set this aside", "put it on hold", "save this for later", "pause"]) {
    assert.ok(isConversationParking(phrase), phrase);
    assert.ok(!isConversationCancellation(phrase), phrase);
  }
  for (const phrase of ["park the car at A17", "I will come back to you", "cancel"]) assert.ok(!isConversationParking(phrase), phrase);
});
