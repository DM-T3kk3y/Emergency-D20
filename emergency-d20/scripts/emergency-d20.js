const E20_MODULE_ID = "emergency-d20";

console.log("Emergency D20 | Script file loaded (v1.5)");

Hooks.once("init", () => {
  console.log("Emergency D20 | init hook fired");

  game.settings.register(E20_MODULE_ID, "itemName", {
    name: "Emergency D20 Item Name",
    hint: "Name of the item on the Actor that represents an Emergency D20.",
    scope: "world",
    config: true,
    type: String,
    default: "Emergency D20"
  });
});

Hooks.once("ready", () => {
  console.log("Emergency D20 | ready hook fired");
});

/* ----------------- Helpers ----------------- */

function getActorFromSpeaker(speaker) {
  if (!speaker) return null;

  if (speaker.actor) {
    const actor = game.actors.get(speaker.actor);
    if (actor) return actor;
  }

  if (speaker.token && canvas?.tokens) {
    const token = canvas.tokens.get(speaker.token);
    if (token?.actor) return token.actor;
  }

  if (canvas?.tokens && canvas.tokens.controlled.length === 1) {
    return canvas.tokens.controlled[0].actor;
  }

  return null;
}

function findEmergencyD20Item(actor) {
  if (!actor) return null;
  const itemName = game.settings.get(E20_MODULE_ID, "itemName");
  return actor.items.find(i => i.name === itemName) ?? null;
}

// PRIMARY: use quantity as the emergency pool; SECONDARY: uses.value
function hasUsesRemaining(item) {
  if (!item) return false;
  const sys = item.system ?? item.data?.data;

  if (typeof sys?.quantity === "number") {
    return sys.quantity > 0;
  }

  if (sys?.uses && typeof sys.uses.value === "number") {
    return sys.uses.value > 0;
  }

  return true;
}

async function consumeEmergencyD20(item) {
  if (!item) return false;
  const sys = item.system ?? item.data?.data;
  const update = {};

  console.log("Emergency D20 | consumeEmergencyD20 before", {
    uses: sys?.uses,
    quantity: sys?.quantity
  });

  if (typeof sys?.quantity === "number") {
    if (sys.quantity <= 0) return false;
    update["system.quantity"] = sys.quantity - 1;
  } else if (sys?.uses && typeof sys.uses.value === "number") {
    if (sys.uses.value <= 0) return false;
    update["system.uses.value"] = sys.uses.value - 1;
  } else {
    console.log("Emergency D20 | Item has no quantity/uses, treating as infinite.");
    return true;
  }

  console.log("Emergency D20 | consumeEmergencyD20 update", update);
  await item.update(update);
  return true;
}

function isD20TestMessage(message) {
  const rolls = message.rolls ?? [];
  if (!rolls.length) return false;

  const roll = rolls[0];
  if (!roll?.dice?.length) return false;

  return roll.dice.some(d => d.faces === 20);
}

function computeModifierFromRoll(roll) {
  const terms = roll.terms ?? [];
  const DieTerm = foundry.dice.terms.Die;

  let d20Total = 0;
  for (const term of terms) {
    if (term instanceof DieTerm && term.faces === 20) {
      d20Total += term.total ?? 0;
    }
  }

  if (d20Total === 0) return 0;
  return roll.total - d20Total;
}

/* ------------- Core Hook: renderChatMessageHTML (v13-friendly) ------------- */
/**
 * message: ChatMessage
 * html: HTMLElement (NOT jQuery)
 * data: render context
 */
Hooks.on("renderChatMessageHTML", (message, html, data) => {
  try {
    console.log("Emergency D20 | renderChatMessageHTML fired for message", message.id);

    // Avoid recursive buttons on our own emergency rolls
    if (message.getFlag(E20_MODULE_ID, "isEmergency")) {
      console.log("Emergency D20 | message is an Emergency D20 roll, skipping button");
      return;
    }

    const rolls = message.rolls ?? [];
    if (!rolls.length) {
      console.log("Emergency D20 | message has no rolls, skipping");
      return;
    }

    if (!isD20TestMessage(message)) {
      console.log("Emergency D20 | not a d20 test, skipping");
      return;
    }

    const used = message.getFlag(E20_MODULE_ID, "used");
    if (used) {
      console.log("Emergency D20 | already used on this message, skipping");
      return;
    }

    const actor = getActorFromSpeaker(message.speaker);
    if (!actor) {
      console.log("Emergency D20 | no actor found for speaker, skipping");
      return;
    }

    if (!actor.isOwner && !game.user.isGM) {
      console.log("Emergency D20 | user does not own actor, skipping");
      return;
    }

    const item = findEmergencyD20Item(actor);
    if (!item) {
      console.log("Emergency D20 | no Emergency D20 item on actor, skipping");
      return;
    }

    if (!hasUsesRemaining(item)) {
      console.log("Emergency D20 | no uses/quantity remaining on Emergency D20, skipping");
      return;
    }

    // Wrap html element in jQuery so we can use jQuery APIs
    const $html = $(html);

    // Build button wrapper
    const $buttonWrapper = $(`
      <div class="emergency-d20-wrapper" style="margin-top: 0.25rem; text-align: right;">
        <button type="button"
                class="emergency-d20-btn"
                data-message-id="${message.id}"
                data-actor-id="${actor.id}"
                data-item-id="${item.id}"
                style="cursor: pointer; pointer-events: auto; position: relative; z-index: 999;">
          <i class="fas fa-dice-d20"></i> Use Emergency D20
        </button>
      </div>
    `);

    // Append into the chat card
    $html.append($buttonWrapper);

    const btn = $buttonWrapper.find("button")[0];
    if (!btn) {
      console.warn("Emergency D20 | Could not find button element after append");
      return;
    }

    console.log("Emergency D20 | Attaching click handler to button for message", message.id);

    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      console.log("Emergency D20 | Button clicked (direct handler)", event.currentTarget);

      const messageId = btn.dataset.messageId;
      const actorId   = btn.dataset.actorId;
      const itemId    = btn.dataset.itemId;

      const msg = game.messages.get(messageId);
      if (!msg) {
        console.warn("Emergency D20 | No message found for id", messageId);
        return;
      }

      let act = game.actors.get(actorId);
      if (!act && canvas?.tokens) {
        const token = canvas.tokens.placeables.find(t => t.actor?.id === actorId);
        act = token?.actor ?? null;
      }
      if (!act) {
        ui.notifications.warn("Emergency D20: Could not find actor.");
        return;
      }

      const itm = act.items.get(itemId);
      if (!itm) {
        ui.notifications.warn("Emergency D20: Could not find Emergency D20 item.");
        return;
      }

      await handleEmergencyD20Click({
        message: msg,
        actor: act,
        item: itm,
        buttonElement: btn
      });
    });

  } catch (err) {
    console.error("Emergency D20 | Error in renderChatMessageHTML:", err);
  }
});

/* ------------- Click Handler Logic ------------- */

async function handleEmergencyD20Click({ message, actor, item, buttonElement }) {
  console.log("Emergency D20 | handleEmergencyD20Click", {
    messageId: message.id,
    actorId: actor.id,
    itemId: item.id
  });

  if (!actor || (!actor.isOwner && !game.user.isGM)) {
    ui.notifications.warn("You do not control this actor.");
    return;
  }

  if (!item || !hasUsesRemaining(item)) {
    ui.notifications.warn("No Emergency D20 remaining.");
    return;
  }

  const rolls = message.rolls ?? [];
  if (!rolls.length) return;

  const originalRoll = rolls[0];
  const modifier = computeModifierFromRoll(originalRoll);
  const formula = modifier === 0 ? "1d20" : `1d20${modifier >= 0 ? "+" : ""}${modifier}`;

  console.log("Emergency D20 | Rolling formula", formula);

  const consumed = await consumeEmergencyD20(item);
  if (!consumed) {
    ui.notifications.warn("Could not consume an Emergency D20.");
    return;
  }

  await message.setFlag(E20_MODULE_ID, "used", true);

  // v13+ roll evaluation: no async option
  const roll = new Roll(formula);
  await roll.evaluate();

  const flavorBase = originalRoll.options?.flavor || message.flavor || "Emergency D20";
  const flavor = `${flavorBase} (Emergency D20)`;

  const newMessage = await roll.toMessage({
    speaker: message.speaker,
    flavor,
    flags: {
      [E20_MODULE_ID]: {
        sourceMessageId: message.id,
        actorId: actor.id,
        itemId: item.id,
        isEmergency: true
      }
    }
  });

  if (newMessage) {
    await newMessage.setFlag(E20_MODULE_ID, "isEmergency", true);
  }

  if (buttonElement) {
    const wrapper = buttonElement.closest(".emergency-d20-wrapper");
    if (wrapper) wrapper.remove();
  }

  ui.notifications.info("Emergency D20 used!");
}
