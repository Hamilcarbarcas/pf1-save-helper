// ============================================================
// PF1 Save Helper — Entry Point
// ============================================================

import { SaveCard } from "./save-card.mjs";

const MODULE_ID = "pf1-save-helper";

Hooks.on("renderChatMessageHTML", (message, html, _data) => {
  SaveCard.inject(message, html);
});

Hooks.once("ready", () => {
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    if (!game.user.isGM) return;
    if (data?.type === "recordResult") {
      await SaveCard.gmSetResult(data.messageId, data.tokenUUID, data.result);
    }
  });
});
