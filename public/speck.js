// The Speck interface: startup. Everything else lives in ./ui/.
import { createWorldScene } from "./world-3d.js";
import { createMemoryScene } from "./memory-3d.js";
import { $, $$, scenes } from "./ui/core.js";
import { refreshWorkspace, setWorldMode, selectMemory, activateWorldEntity, describeWorldEntity, describeMemory, setView, initializeAmbientCanvas } from "./ui/workspace.js";
import { openTaskDialog, createTask } from "./ui/tasks.js";
import { submitQuickPrompt, resizeQuickPrompt } from "./ui/conversation.js";
import { initializeVoice, toggleVoice } from "./ui/voice.js";

$$('[data-view]').forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
$$('[data-world-mode]').forEach((button) => button.addEventListener("click", () => setWorldMode(button.dataset.worldMode)));
$("#closePanelButton").addEventListener("click", () => setView("world"));
$("#newTaskButton").addEventListener("click", openTaskDialog);
$("#speckSprite").addEventListener("click", openTaskDialog);
$("#cancelTaskButton").addEventListener("click", () => $("#taskDialog").close());
$("#taskForm").addEventListener("submit", createTask);
$("#refreshButton").addEventListener("click", () => refreshWorkspace());
$("#voiceButton").addEventListener("click", toggleVoice);
$("#composerVoiceButton").addEventListener("click", toggleVoice);
$("#quickComposer").addEventListener("submit", submitQuickPrompt);
$("#quickPrompt").addEventListener("input", resizeQuickPrompt);
$("#quickPrompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("#quickComposer").requestSubmit();
  }
});
setInterval(() => { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }, 1000);
setInterval(() => refreshWorkspace({ quiet: true }), 20_000);
try {
  scenes.world = createWorldScene({
    canvas: $("#worldCanvas"),
    onActivate: activateWorldEntity,
    onFocus: describeWorldEntity
  });
} catch (error) {
  console.error("Three.js workspace unavailable", error);
  $("#worldCanvas").hidden = true;
  $("#entityField").hidden = false;
  $("#worldSelection").textContent = "3D rendering is unavailable; showing the accessible workspace map.";
}
try {
  scenes.memory = createMemoryScene({
    canvas: $("#memoryCanvas"),
    onActivate: (memory) => selectMemory(memory?.id),
    onFocus: describeMemory
  });
} catch (error) {
  console.error("Three.js memory constellation unavailable", error);
  $("#memoryCanvas").hidden = true;
  $("#memoryMapEmpty").textContent = "The 3D memory constellation is unavailable.";
}
initializeAmbientCanvas();
initializeVoice();
refreshWorkspace({ quiet: true });
