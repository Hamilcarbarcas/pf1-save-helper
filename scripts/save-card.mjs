// ============================================================
// PF1 Save Helper — Save Card Logic
// ============================================================

const MODULE_ID = "pf1-save-helper";
const FLAG_SCOPE = "pf1-save-helper";
const FLAG_KEY = "results";

export class SaveCard {

  // ----------------------------------------------------------
  // Inject save card into an action chat message
  // ----------------------------------------------------------

  static async inject(message, html) {
    const saveType = message.system?.save?.type;
    if (!saveType) return;

    const targetUUIDs = message.system?.targets ?? [];
    if (!targetUUIDs.length) return;

    const dc = message.system.save.dc ?? null;
    const results = message.getFlag(FLAG_SCOPE, FLAG_KEY) ?? {};

    // Build per-target data
    const targets = [];
    for (const uuid of targetUUIDs) {
      const tokenDoc = fromUuidSync(uuid);
      if (!tokenDoc) continue;
      const actor = tokenDoc.actor;
      if (!actor) continue;

      const isHidden = !!tokenDoc.hidden;
      const saveTotal = actor.system?.attributes?.savingThrows?.[saveType]?.total ?? 0;
      const saveBonusDisplay = saveTotal >= 0 ? `+${saveTotal}` : `${saveTotal}`;

      const rawResult = results[uuid] ?? null;
      const hasRawResult = rawResult !== null;

      // Effective pass/fail: manual override takes precedence over dice result
      let effectivePass = null;
      if (hasRawResult && dc !== null) {
        effectivePass = rawResult.manualOverride != null
          ? rawResult.manualOverride
          : rawResult.pass;
      }

      const canRoll = !!actor.isOwner;
      // OBSERVER level = 2 in Foundry
      const canSeeDetails = game.user.isGM || actor.testUserPermission(game.user, "OBSERVER");
      const hasDetails = hasRawResult && !!rawResult.rollData && canSeeDetails;
      const showResult = hasRawResult && canSeeDetails;

      const passClass = effectivePass === true ? "psh-pass" : effectivePass === false ? "psh-fail" : "";
      const passIcon = effectivePass === false ? "fa-times" : "fa-check";
      const passActive = rawResult?.manualOverride === true;
      const failActive = rawResult?.manualOverride === false;

      targets.push({
        uuid,
        name: tokenDoc.name,
        img: tokenDoc.texture?.src ?? actor.img,
        isHidden,
        saveBonusDisplay,
        canRoll,
        hasResult: showResult,
        resultTotal: rawResult?.total ?? "",
        effectivePass,
        passClass,
        passIcon,
        passIconTitle: effectivePass === true ? "Passed" : "Failed",
        passActive,
        failActive,
        hasDetails,
        isNPC: actor.type !== "character",
      });
    }

    if (!targets.length) return;

    const rawLabel = pf1?.config?.savingThrows?.[saveType] ?? saveType;
    const saveTypeLabel = game.i18n.localize(rawLabel);

    const data = {
      saveTypeLabel,
      dc,
      showDC: dc !== null,
      isGM: game.user.isGM,
      targets,
    };

    const cardHtml = await renderTemplate(`modules/${MODULE_ID}/templates/save-card.hbs`, data);
    const frag = document.createElement("div");
    frag.innerHTML = cardHtml;
    const card = frag.firstElementChild;
    if (!card) return;

    // Strip hidden-token rows for non-GMs
    if (!game.user.isGM) {
      card.querySelectorAll(".gm-only").forEach(el => el.remove());
    }

    // Append to the message HTML
    const wrapper = html.querySelector?.(".message-content") ?? html;
    wrapper.appendChild(card);

    // Fill roll detail slots async (HTML already in DOM by this point)
    SaveCard._renderRollDetails(card, targets, results);

    // Bind all interactive events
    SaveCard._bindEvents(card, message, targets, dc, saveType);
  }

  // ----------------------------------------------------------
  // Render saved roll data into collapsible detail slots
  // ----------------------------------------------------------

  static async _renderRollDetails(card, targets, results) {
    for (const target of targets) {
      if (!target.hasDetails) continue;
      const rawResult = results[target.uuid];
      if (!rawResult?.rollData) continue;
      try {
        const roll = Roll.fromData(rawResult.rollData);
        const slot = card.querySelector(`.psh-details[data-uuid="${target.uuid}"]`);
        if (slot) slot.innerHTML = await roll.render();
      } catch (err) {
        console.error(`${MODULE_ID} | roll details render failed for ${target.uuid}`, err);
      }
    }
  }

  // ----------------------------------------------------------
  // Event binding
  // ----------------------------------------------------------

  static _bindEvents(card, message, targets, dc, saveType) {

    // Individual roll button
    card.querySelectorAll("[data-action='rollSave']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uuid = btn.dataset.uuid;
        const target = targets.find(t => t.uuid === uuid);
        if (!target) return;
        await SaveCard._rollSave(message, uuid, saveType, dc, target.isHidden);
      });
    });

    // Roll All (GM-only button)
    card.querySelector("[data-action='rollAll']")?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!game.user.isGM) return;
      for (const target of targets) {
        const current = message.getFlag(FLAG_SCOPE, FLAG_KEY) ?? {};
        if (current[target.uuid] !== undefined) continue;
        await SaveCard._rollSave(message, target.uuid, saveType, dc, target.isHidden);
      }
    });

    // Roll All NPCs (GM-only button)
    card.querySelector("[data-action='rollAllNPC']")?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!game.user.isGM) return;
      for (const target of targets.filter(t => t.isNPC)) {
        const current = message.getFlag(FLAG_SCOPE, FLAG_KEY) ?? {};
        if (current[target.uuid] !== undefined) continue;
        await SaveCard._rollSave(message, target.uuid, saveType, dc, target.isHidden);
      }
    });

    // Manual pass override (GM-only)
    card.querySelectorAll("[data-action='setPass']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!game.user.isGM) return;
        await SaveCard._toggleOverride(message, btn.dataset.uuid, true);
      });
    });

    // Manual fail override (GM-only)
    card.querySelectorAll("[data-action='setFail']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!game.user.isGM) return;
        await SaveCard._toggleOverride(message, btn.dataset.uuid, false);
      });
    });

    // Canvas token selection
    card.querySelector("[data-action='selectAll']")?.addEventListener("click", (e) => {
      e.preventDefault();
      SaveCard._selectTokens(targets, () => true);
    });

    card.querySelector("[data-action='selectPassed']")?.addEventListener("click", (e) => {
      e.preventDefault();
      const results = message.getFlag(FLAG_SCOPE, FLAG_KEY) ?? {};
      SaveCard._selectTokens(targets, (t) => {
        const r = results[t.uuid];
        if (!r) return false;
        return r.manualOverride != null ? r.manualOverride : r.pass;
      });
    });

    card.querySelector("[data-action='selectFailed']")?.addEventListener("click", (e) => {
      e.preventDefault();
      const results = message.getFlag(FLAG_SCOPE, FLAG_KEY) ?? {};
      SaveCard._selectTokens(targets, (t) => {
        const r = results[t.uuid];
        if (!r) return false;
        const pass = r.manualOverride != null ? r.manualOverride : r.pass;
        return !pass;
      });
    });

    // Row click → expand/collapse roll details
    card.querySelectorAll(".psh-row.psh-has-details").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const entry = row.closest(".psh-entry");
        const details = entry?.querySelector(".psh-details");
        if (!details) return;
        const expanded = entry.classList.toggle("psh-expanded");
        const chevron = row.querySelector(".psh-chevron");
        if (chevron) {
          chevron.classList.toggle("fa-chevron-down", !expanded);
          chevron.classList.toggle("fa-chevron-up", expanded);
        }
      });
    });
  }

  // ----------------------------------------------------------
  // Roll a saving throw for one token
  // ----------------------------------------------------------

  static async _rollSave(message, tokenUUID, saveType, dc, isHidden) {
    const tokenDoc = fromUuidSync(tokenUUID);
    if (!tokenDoc) return;
    const actor = tokenDoc.actor;
    if (!actor?.isOwner) return;

    const rollMode = isHidden ? "gmroll" : "roll";

    const resultMsg = await actor.rollSavingThrow(saveType, {
      skipDialog: true,
      rollMode,
      token: tokenDoc,
    });
    if (!resultMsg) return;

    const roll = resultMsg.rolls?.[0];
    if (!roll) return;

    const total = roll.total;
    const pass = dc !== null ? total >= dc : null;
    const rollData = roll.toJSON();

    const result = { total, pass, rollData, manualOverride: null };

    if (game.user.isGM) {
      await SaveCard.gmSetResult(message.id, tokenUUID, result);
    } else {
      game.socket.emit(`module.${MODULE_ID}`, {
        type: "recordResult",
        messageId: message.id,
        tokenUUID,
        result,
      });
    }
  }

  // ----------------------------------------------------------
  // Toggle manual pass/fail override (GM only)
  // ----------------------------------------------------------

  static async _toggleOverride(message, tokenUUID, pass) {
    const existing = foundry.utils.deepClone(message.getFlag(FLAG_SCOPE, FLAG_KEY) ?? {});
    const entry = existing[tokenUUID];
    if (!entry) return; // can only override after a roll exists
    // Clicking the same state twice clears the override
    entry.manualOverride = entry.manualOverride === pass ? null : pass;
    await message.setFlag(FLAG_SCOPE, FLAG_KEY, existing);
  }

  // ----------------------------------------------------------
  // Record a roll result on the message (GM-side)
  // ----------------------------------------------------------

  static async gmSetResult(messageId, tokenUUID, result) {
    const message = game.messages.get(messageId);
    if (!message) return;
    const existing = foundry.utils.deepClone(message.getFlag(FLAG_SCOPE, FLAG_KEY) ?? {});
    existing[tokenUUID] = result;
    await message.setFlag(FLAG_SCOPE, FLAG_KEY, existing);
  }

  // ----------------------------------------------------------
  // Select matching tokens on the canvas
  // ----------------------------------------------------------

  static _selectTokens(targets, condition) {
    if (!canvas?.tokens) return;
    canvas.tokens.releaseAll();
    for (const target of targets) {
      if (!condition(target)) continue;
      const token = fromUuidSync(target.uuid)?.object;
      if (token) token.control({ releaseOthers: false });
    }
  }
}
