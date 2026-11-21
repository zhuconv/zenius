// Portions adapted from citrolabs/ego-lite (MIT License), whose US keyboard
// layout and chord rules follow microsoft/playwright:
//   Copyright (c) Microsoft Corporation.
//   Licensed under the Apache License, Version 2.0 (the "License"); you may
//   not use this file except in compliance with the License. You may obtain
//   a copy at http://www.apache.org/licenses/LICENSE-2.0
//
// Key names, chords and the US layout, shared by the parent (validation and
// per-connection key state) and content processes (dispatch). No imports, so
// both sides can load it.

/** @typedef {{code: string, key: string, keyCode: number, keyCodeWithoutLocation: number, location: number, text: string, shifted?: KeyDefinition}} KeyDefinition */

export const KEYPAD_LOCATION = 3;
export const MODIFIER_NAMES = Object.freeze(["Alt", "Control", "Meta", "Shift"]);
const MODIFIER_ALIASES = new Map([
  ["alt", "Alt"],
  ["control", "Control"],
  ["meta", "Meta"],
  ["shift", "Shift"],
  ["controlormeta", "ControlOrMeta"],
]);

function buildKeyboardLayout() {
  const entries = {
    Escape: { keyCode: 27, key: "Escape" },
    Backquote: { keyCode: 192, key: "`", shiftKey: "~" },
    Minus: { keyCode: 189, key: "-", shiftKey: "_" },
    Equal: { keyCode: 187, key: "=", shiftKey: "+" },
    Backslash: { keyCode: 220, key: "\\", shiftKey: "|" },
    Backspace: { keyCode: 8, key: "Backspace" },
    Tab: { keyCode: 9, key: "Tab" },
    BracketLeft: { keyCode: 219, key: "[", shiftKey: "{" },
    BracketRight: { keyCode: 221, key: "]", shiftKey: "}" },
    CapsLock: { keyCode: 20, key: "CapsLock" },
    Semicolon: { keyCode: 186, key: ";", shiftKey: ":" },
    Quote: { keyCode: 222, key: "'", shiftKey: '"' },
    Enter: { keyCode: 13, key: "Enter", text: "\r" },
    ShiftLeft: { keyCode: 160, keyCodeWithoutLocation: 16, key: "Shift", location: 1 },
    ShiftRight: { keyCode: 161, keyCodeWithoutLocation: 16, key: "Shift", location: 2 },
    Comma: { keyCode: 188, key: ",", shiftKey: "<" },
    Period: { keyCode: 190, key: ".", shiftKey: ">" },
    Slash: { keyCode: 191, key: "/", shiftKey: "?" },
    ControlLeft: { keyCode: 162, keyCodeWithoutLocation: 17, key: "Control", location: 1 },
    MetaLeft: { keyCode: 91, key: "Meta", location: 1 },
    AltLeft: { keyCode: 164, keyCodeWithoutLocation: 18, key: "Alt", location: 1 },
    Space: { keyCode: 32, key: " " },
    AltRight: { keyCode: 165, keyCodeWithoutLocation: 18, key: "Alt", location: 2 },
    AltGraph: { keyCode: 225, key: "AltGraph" },
    MetaRight: { keyCode: 92, key: "Meta", location: 2 },
    ContextMenu: { keyCode: 93, key: "ContextMenu" },
    ControlRight: { keyCode: 163, keyCodeWithoutLocation: 17, key: "Control", location: 2 },
    PrintScreen: { keyCode: 44, key: "PrintScreen" },
    ScrollLock: { keyCode: 145, key: "ScrollLock" },
    Pause: { keyCode: 19, key: "Pause" },
    PageUp: { keyCode: 33, key: "PageUp" },
    PageDown: { keyCode: 34, key: "PageDown" },
    Insert: { keyCode: 45, key: "Insert" },
    Delete: { keyCode: 46, key: "Delete" },
    Home: { keyCode: 36, key: "Home" },
    End: { keyCode: 35, key: "End" },
    ArrowLeft: { keyCode: 37, key: "ArrowLeft" },
    ArrowUp: { keyCode: 38, key: "ArrowUp" },
    ArrowRight: { keyCode: 39, key: "ArrowRight" },
    ArrowDown: { keyCode: 40, key: "ArrowDown" },
    NumLock: { keyCode: 144, key: "NumLock" },
    NumpadDivide: { keyCode: 111, key: "/", location: 3 },
    NumpadMultiply: { keyCode: 106, key: "*", location: 3 },
    NumpadSubtract: { keyCode: 109, key: "-", location: 3 },
    NumpadAdd: { keyCode: 107, key: "+", location: 3 },
    NumpadDecimal: { keyCode: 46, shiftKeyCode: 110, key: "\0", shiftKey: ".", location: 3 },
    NumpadEnter: { keyCode: 13, key: "Enter", text: "\r", location: 3 },
  };
  for (let number = 0; number <= 9; number += 1) {
    entries[`Digit${number}`] = { keyCode: 48 + number, key: String(number), shiftKey: ")!@#$%^&*("[number] };
  }
  for (let index = 0; index < 26; index += 1) {
    const upper = String.fromCharCode(65 + index);
    entries[`Key${upper}`] = { keyCode: 65 + index, key: upper.toLowerCase(), shiftKey: upper };
  }
  for (let number = 1; number <= 12; number += 1) {
    entries[`F${number}`] = { keyCode: 111 + number, key: `F${number}` };
  }
  const numpad = [
    ["Numpad7", 36, 103, "Home", "7"],
    ["Numpad8", 38, 104, "ArrowUp", "8"],
    ["Numpad9", 33, 105, "PageUp", "9"],
    ["Numpad4", 37, 100, "ArrowLeft", "4"],
    ["Numpad5", 12, 101, "Clear", "5"],
    ["Numpad6", 39, 102, "ArrowRight", "6"],
    ["Numpad1", 35, 97, "End", "1"],
    ["Numpad2", 40, 98, "ArrowDown", "2"],
    ["Numpad3", 34, 99, "PageDown", "3"],
    ["Numpad0", 45, 96, "Insert", "0"],
  ];
  for (const [code, keyCode, shiftKeyCode, key, shiftKey] of numpad) {
    entries[code] = { keyCode, shiftKeyCode, key, shiftKey, location: 3 };
  }

  /** @type {Map<string, KeyDefinition>} */
  const layout = new Map();
  for (const [code, entry] of Object.entries(entries)) {
    const definition = {
      code,
      key: entry.key,
      keyCode: entry.keyCode,
      keyCodeWithoutLocation: entry.keyCodeWithoutLocation ?? entry.keyCode,
      location: entry.location ?? 0,
      text: entry.text ?? (entry.key.length === 1 ? entry.key : ""),
    };
    if (entry.shiftKey) {
      definition.shifted = {
        ...definition,
        key: entry.shiftKey,
        keyCode: entry.shiftKeyCode ?? definition.keyCode,
        text: entry.shiftKey,
      };
    }
    layout.set(code, definition);
    // Characters resolve to the main keyboard, never the numpad (whose
    // shifted keys are digits and would shadow Digit0-9).
    if (definition.location !== 0) {
      continue;
    }
    if (definition.key.length === 1) {
      layout.set(definition.key, definition);
    }
    if (definition.shifted) {
      layout.set(definition.shifted.key, { ...definition.shifted, shifted: undefined });
    }
  }
  const aliases = { Alt: "AltLeft", Control: "ControlLeft", Meta: "MetaLeft", Shift: "ShiftLeft", " ": "Space", "\n": "Enter", "\r": "Enter" };
  for (const [alias, code] of Object.entries(aliases)) {
    layout.set(alias, layout.get(code));
  }
  return layout;
}

export const KEY_LAYOUT = buildKeyboardLayout();

const NAMED_KEY_NAMES = new Map(
  [...KEY_LAYOUT.keys()].filter(key => key.length > 1).map(key => [key.toLowerCase(), key])
);

/** @param {string} key */
export function isModifier(key) {
  return MODIFIER_NAMES.includes(key);
}

/**
 * Split a chord without losing a literal `+` key ("Shift++", "+").
 *
 * @param {string} chord
 * @param {string} [operation] for messages
 */
export function splitChord(chord, operation = "page.keyboard.press") {
  if (typeof chord !== "string" || chord.length === 0) {
    throw new TypeError(`${operation} requires a non-empty key`);
  }
  const tokens = [];
  let building = "";
  for (const character of chord) {
    if (character === "+" && building) {
      tokens.push(building);
      building = "";
    } else {
      building += character;
    }
  }
  tokens.push(building);
  if (tokens.some(token => token.length === 0)) {
    throw new TypeError(`${operation} received invalid chord: ${chord}`);
  }
  return tokens;
}

/**
 * Case-insensitive modifier and named-key aliases; ControlOrMeta becomes Meta
 * on macOS and Control elsewhere.
 *
 * @param {string} key
 * @param {boolean} isMac
 */
export function resolveKeyName(key, isMac) {
  const lower = key.toLowerCase();
  const normalized = MODIFIER_ALIASES.get(lower) ?? NAMED_KEY_NAMES.get(lower) ?? key;
  if (normalized === "ControlOrMeta") {
    return isMac ? "Meta" : "Control";
  }
  return normalized;
}

/**
 * @param {string} input  a resolved key name or single character
 * @param {boolean} shift whether Shift is held
 * @returns {KeyDefinition}
 */
export function keyDefinition(input, shift) {
  const definition = KEY_LAYOUT.get(input);
  if (!definition) {
    const arrow = { Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown" }[input];
    const hint = arrow ? `. Use ${JSON.stringify(arrow)}` : "";
    throw new TypeError(`Unknown key: ${JSON.stringify(input)}${hint}`);
  }
  return shift && definition.shifted ? definition.shifted : definition;
}

/** Whether `type` sends real key events for this character (else insertText). */
export function hasKey(character) {
  return KEY_LAYOUT.has(character);
}

/**
 * The text a key produces with these modifiers held: none when a modifier
 * other than Shift is down.
 *
 * @param {KeyDefinition} definition
 * @param {Iterable<string>} modifiers
 */
export function keyText(definition, modifiers) {
  const held = new Set(modifiers);
  if (held.size > 1 || (held.size === 1 && !held.has("Shift"))) {
    return "";
  }
  return definition.text;
}
