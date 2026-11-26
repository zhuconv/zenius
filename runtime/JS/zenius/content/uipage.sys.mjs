// The UI's reads of a page for its cards (ui/index.sys.mjs), through
// ZeniusService.content: "uipage#<fn>". They read; they change nothing.

import { secretFields } from "chrome://userscripts/content/zenius/content/secrets.sys.mjs";

/**
 * The kinds of secret field in the frame's document: a password, a card's
 * details, a one-time code (the input layer's secretFields). The card a page the
 * agent made carries shows only when the page asks for one.
 *
 * @param {JSWindowActorChild} actor
 * @returns {Array<"password"|"card"|"code">}
 */
export function secretKinds(actor) {
  const doc = actor.document;
  return doc ? [...new Set(secretFields(doc).values())] : [];
}
