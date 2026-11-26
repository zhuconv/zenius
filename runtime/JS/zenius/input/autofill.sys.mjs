// Saved logins, addresses and cards stay out of agent tabs (the input layer).
//
// An agent must never see the user's saved passwords. Firefox fills them
// into the page as it loads, where evaluate, snapshot or a page script
// could read them, and from there they'd reach the agent's transcript and
// the model provider. Cookies and sessions stay shared (SPEC). An agent that
// needs to log in hands off to the user.
//
// In a tab of an agent task, whoever holds control:
// - nothing fills on load: the password manager's content side gets no
//   saved login, only a placeholder that fits no page (below);
// - nothing is captured: no "save password" doorhanger, no address or card
//   capture, no form history, and nothing reaches the user's stores.
// While the agent drives the tab, no suggestion popup opens: no saved
// logins, addresses, cards or form history, and form autofill refills
// nothing. While the user holds control (handOff, takeover), their own
// clicks get their saved logins, addresses and cards as in their own tabs
// (not form history). When the agent gets the tab back, the passwords and
// card details filled in the meantime are cleared first
// (handback.sys.mjs); addresses stay, for the agent to go on with.
//
// Each guard wraps a parent actor's receiveMessage, so every frame and
// process is covered.

const PATCHED = Symbol("zenius.autofill");

/** @type {{isAgentTask: (browser: Element) => boolean, isAgentDriven: (browser: Element) => boolean} | null} */
let host = null;

function browserOf(actor) {
  try {
    return actor.browsingContext?.top?.embedderElement ?? null;
  } catch {
    return null;
  }
}

function holds(test, actor) {
  const browser = browserOf(actor);
  try {
    return !!browser && !!test?.(browser);
  } catch {
    return false;
  }
}

/** The tab belongs to an agent task, whoever holds control. */
const inAgentTask = actor => holds(host?.isAgentTask, actor);
/** The agent itself drives the tab. */
const agentDrives = actor => holds(host?.isAgentDriven, actor);

/**
 * Wrap Class.prototype.receiveMessage with `guard(actor, msg, original)`,
 * which returns what the actor should answer.
 */
function wrap(Class, guard) {
  const proto = Class.prototype;
  if (proto[PATCHED]) {
    return;
  }
  const original = proto.receiveMessage;
  proto.receiveMessage = function (msg) {
    return guard(this, msg, m => original.call(this, m));
  };
  proto[PATCHED] = true;
}

// The content side's answer to "which logins fit this form?" in agent tabs:
// one login for a site that doesn't exist. Seeing a login, LoginManagerChild
// attaches the saved-login suggestions to the username field, so the user's
// own click opens them while they hold the tab (the search runs here, in
// the parent, against the real store). Then it fills only logins for this
// page's origin, so it fills nothing, as for a login saved for another
// site. It carries none of the user's data. With no login at all, the
// field would get no suggestions.
const PLACEHOLDER_ORIGIN = "https://zenius-agent-tab.invalid";
const PLACEHOLDER_LOGIN = Object.freeze({
  origin: PLACEHOLDER_ORIGIN,
  formActionOrigin: PLACEHOLDER_ORIGIN,
  httpRealm: null,
  username: "",
  password: "",
  usernameField: "",
  passwordField: "",
});

/** Firefox's field-detection fixes for the page's site; no user data. */
async function recipesFor(actor, LoginManagerParent) {
  try {
    const host = URL.parse(actor.origin)?.host;
    if (!host) {
      return [];
    }
    const manager = await LoginManagerParent.recipeParentPromise;
    return manager.getRecipesForHost(host) ?? [];
  } catch {
    return [];
  }
}

const LOGIN_CAPTURE = new Set([
  "PasswordManager:onFormSubmit",
  "PasswordManager:onPasswordEditedOrGenerated",
  "PasswordManager:ShowDoorhanger",
]);

function guardLogins(actor, msg, original, LoginManagerParent) {
  if (msg.name === "PasswordManager:findLogins" && inAgentTask(actor)) {
    // The store stays untouched: no decryption, so no primary password prompt.
    return recipesFor(actor, LoginManagerParent).then(recipes => ({ logins: [PLACEHOLDER_LOGIN], recipes }));
  }
  if (LOGIN_CAPTURE.has(msg.name) && inAgentTask(actor)) {
    return undefined;
  }
  if (msg.name === "PasswordManager:autoCompleteLogins" && agentDrives(actor)) {
    return { logins: [] };
  }
  return original(msg);
}

const AUTOFILL_CAPTURE = new Set(["FormAutofill:OnFormSubmit", "FormAutofill:SaveAddress", "FormAutofill:SaveCreditCard"]);

function guardFormAutofill(actor, msg, original) {
  if (msg.name === "FormAutofill:GetRecords" && inAgentTask(actor)) {
    return { records: [] };
  }
  if (AUTOFILL_CAPTURE.has(msg.name) && inAgentTask(actor)) {
    return undefined;
  }
  // A refill after the form changed, just after the user's own fill: not
  // once the agent has the tab.
  if (msg.name === "FormAutofill:FieldsUpdatedDuringAutofill" && agentDrives(actor)) {
    return undefined;
  }
  return original(msg);
}

function guardFormHistory(actor, msg, original) {
  // Whatever browser.formfill.enable says.
  if (msg.name === "FormHistory:FormSubmitEntries" && inAgentTask(actor)) {
    return undefined;
  }
  return original(msg);
}

/** What the user's own clicks may search while they hold an agent tab. */
const USER_PROVIDERS = new Set(["LoginManager", "FormAutofill"]);

function guardAutoComplete(actor, msg, original) {
  if (msg.name === "AutoComplete:StartSearch" && inAgentTask(actor)) {
    if (agentDrives(actor)) {
      return [];
    }
    // The user holds control: their saved logins, addresses and cards.
    const providers = (msg.data?.data ?? []).filter(p => USER_PROVIDERS.has(p.actorName));
    return original({ name: msg.name, data: { ...msg.data, data: providers } });
  }
  if (msg.name === "AutoComplete:MaybeOpenPopup" && agentDrives(actor)) {
    return false;
  }
  return original(msg);
}

/**
 * Install once per parent process.
 *
 * @param {{isAgentTask: (browser: Element) => boolean, isAgentDriven: (browser: Element) => boolean}} h
 */
export function installAutofillGuards(h) {
  host = h;
  const { LoginManagerParent } = ChromeUtils.importESModule("resource://gre/modules/LoginManagerParent.sys.mjs");
  wrap(LoginManagerParent, (actor, msg, original) => guardLogins(actor, msg, original, LoginManagerParent));
  const { AutoCompleteParent } = ChromeUtils.importESModule("moz-src:///toolkit/actors/AutoCompleteParent.sys.mjs");
  wrap(AutoCompleteParent, guardAutoComplete);
  const { FormHistoryParent } = ChromeUtils.importESModule("resource://gre/actors/FormHistoryParent.sys.mjs");
  wrap(FormHistoryParent, guardFormHistory);
  try {
    // Form autofill is a built-in add-on; a build may leave it out.
    const { FormAutofillParent } = ChromeUtils.importESModule("resource://autofill/FormAutofillParent.sys.mjs");
    wrap(FormAutofillParent, guardFormAutofill);
  } catch (e) {
    console.warn("[zenius] form autofill guard not installed", e);
  }
}
