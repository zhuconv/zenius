// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Actionability for page actions (the input layer): composed-tree walks, the
// enabled state, the action point, the scroll request, the hit test and the
// wrapper-to-control rules. These follow Ego's action-target.ts so that the
// same element passes or fails, with the same message, on both browsers.
// Everything takes elements as chrome sees them (Xrays).

// ---------------------------------------------------------------- composed tree

/** Slotted nodes go to their slot, shadow children to their host. */
export function composedParent(element) {
  if (element?.assignedSlot) {
    return element.assignedSlot;
  }
  if (element?.parentElement) {
    return element.parentElement;
  }
  const root = element?.getRootNode ? element.getRootNode() : null;
  return root && root.nodeType === 11 ? root.host : null;
}

/** Children in the composed tree; open shadow roots replace light children. */
export function composedChildren(element) {
  if (!element) {
    return [];
  }
  if (tagOf(element) === "SLOT") {
    const assigned = element.assignedElements?.({ flatten: true }) || [];
    if (assigned.length > 0) {
      return Array.from(assigned);
    }
  }
  const container = element.shadowRoot || element;
  return Array.from(container.children || []);
}

export function nearestComposedAncestor(element, predicate) {
  let current = composedParent(element);
  while (current) {
    if (predicate(current)) {
      return current;
    }
    current = composedParent(current);
  }
  return null;
}

export function composedDescendantMatches(root, predicate, stopAtMatch = false) {
  const matches = [];
  const visit = parent => {
    for (const child of composedChildren(parent)) {
      const matched = predicate(child);
      if (matched) {
        matches.push(child);
      }
      if (!(matched && stopAtMatch)) {
        visit(child);
      }
    }
  };
  visit(root);
  return matches;
}

export function containsComposed(container, element) {
  for (let current = element; current; current = composedParent(current)) {
    if (current === container) {
      return true;
    }
  }
  return false;
}

export function tagOf(element) {
  return String(element?.tagName || "").toUpperCase();
}

function roleAttr(element) {
  return String(element?.getAttribute?.("role") || "").toLowerCase();
}

// ---------------------------------------------------------------- enabled state

const NATIVE_ACTION_CONTROL_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "OPTGROUP"]);
const ARIA_DISABLED_ACTION_ROLES = new Set([
  "application", "button", "composite", "gridcell", "group", "input",
  "link", "menuitem", "scrollbar", "separator", "tab", "checkbox",
  "columnheader", "combobox", "grid", "listbox", "menu", "menubar",
  "menuitemcheckbox", "menuitemradio", "option", "radio", "radiogroup",
  "row", "rowheader", "searchbox", "select", "slider", "spinbutton",
  "switch", "tablist", "textbox", "toolbar", "tree", "treegrid",
  "treeitem",
]);

function actionStateRole(element) {
  const explicit = String(element?.getAttribute?.("role") || "").trim().toLowerCase().split(/\s+/)[0];
  if (explicit) {
    return explicit;
  }
  const tag = tagOf(element);
  if (tag === "BUTTON" || tag === "SUMMARY") {
    return "button";
  }
  if (tag === "INPUT") {
    return "input";
  }
  if (tag === "SELECT") {
    return "select";
  }
  if (tag === "TEXTAREA" || element?.isContentEditable) {
    return "textbox";
  }
  if (tag === "OPTION") {
    return "option";
  }
  if (tag === "OPTGROUP" || tag === "FIELDSET") {
    return "group";
  }
  if ((tag === "A" || tag === "AREA") && element?.hasAttribute?.("href")) {
    return "link";
  }
  return "";
}

function isNativelyDisabledForAction(element) {
  for (let current = element; current; current = composedParent(current)) {
    if (NATIVE_ACTION_CONTROL_TAGS.has(tagOf(current)) && (current.disabled === true || current.matches?.(":disabled"))) {
      return true;
    }
  }
  return false;
}

function hasInheritedAriaDisabled(element) {
  let current = element;
  while (current && !ARIA_DISABLED_ACTION_ROLES.has(actionStateRole(current))) {
    current = composedParent(current);
  }
  for (; current; current = composedParent(current)) {
    const value = String(current.getAttribute?.("aria-disabled") ?? "").trim().toLowerCase();
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }
  return false;
}

/** Native disabled (the element or a composed ancestor), or inherited aria-disabled. */
export function isActionTargetDisabled(element) {
  return isNativelyDisabledForAction(element) || hasInheritedAriaDisabled(element);
}

// ---------------------------------------------------------------- points and scrolling

/**
 * The center of the visible part of the element's client rect with the
 * largest visible area (viewport clipping only), or that rect's center when
 * none of it is visible (a scroll request follows). Null without a box.
 */
export function actionPointForElement(target) {
  const view = target?.ownerDocument?.defaultView;
  if (!view) {
    return null;
  }
  const rects = Array.from(target.getClientRects?.() || []).filter(r => r.width > 0 && r.height > 0);
  if (rects.length === 0) {
    const rect = target.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    rects.push(rect);
  }
  let best = null;
  for (const rect of rects) {
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(view.innerWidth, rect.right);
    const bottom = Math.min(view.innerHeight, rect.bottom);
    const visibleArea = Math.max(0, right - left) * Math.max(0, bottom - top);
    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    const distanceX = centerX - Math.max(0, Math.min(view.innerWidth, centerX));
    const distanceY = centerY - Math.max(0, Math.min(view.innerHeight, centerY));
    const viewportDistance = distanceX * distanceX + distanceY * distanceY;
    if (!best || visibleArea > best.visibleArea || (visibleArea === best.visibleArea && viewportDistance < best.viewportDistance)) {
      best = { rect, left, top, right, bottom, visibleArea, viewportDistance };
    }
  }
  if (best.visibleArea > 0) {
    return { x: (best.left + best.right) / 2, y: (best.top + best.bottom) / 2 };
  }
  return { x: (best.rect.left + best.rect.right) / 2, y: (best.rect.top + best.rect.bottom) / 2 };
}

/** The point for a `position` option: bounding-box top-left plus the offset. */
export function positionPoint(target, position) {
  const rect = target.getBoundingClientRect();
  return { x: rect.x + position.x, y: rect.y + position.y };
}

function visibleScrollArea(rect, view) {
  return {
    left: Math.max(0, rect.left),
    top: Math.max(0, rect.top),
    right: Math.min(view.innerWidth, rect.right),
    bottom: Math.min(view.innerHeight, rect.bottom),
  };
}

const SCROLLABLE_OVERFLOW = /^(auto|scroll|overlay)$/;

/**
 * Where to aim a wheel to bring `point` into view: the visible center of the
 * innermost scroll container the point falls outside of (with the delta to
 * scroll), else the viewport; null when the point is in view.
 *
 * @returns {{x: number, y: number, deltaX: number, deltaY: number} | null}
 */
export function scrollRequestForPoint(target, point) {
  const view = target?.ownerDocument?.defaultView;
  if (!view) {
    return null;
  }
  const doc = target.ownerDocument;
  for (let ancestor = composedParent(target); ancestor; ancestor = composedParent(ancestor)) {
    if (ancestor === doc.body || ancestor === doc.documentElement) {
      continue;
    }
    const style = view.getComputedStyle(ancestor);
    const canScrollX = SCROLLABLE_OVERFLOW.test(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth + 1;
    const canScrollY = SCROLLABLE_OVERFLOW.test(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight + 1;
    if (!canScrollX && !canScrollY) {
      continue;
    }
    const area = visibleScrollArea(ancestor.getBoundingClientRect(), view);
    if (!(area.right > area.left && area.bottom > area.top)) {
      continue;
    }
    let deltaX = canScrollX && (point.x < area.left || point.x >= area.right) ? point.x - (area.left + area.right) / 2 : 0;
    let deltaY = canScrollY && (point.y < area.top || point.y >= area.bottom) ? point.y - (area.top + area.bottom) / 2 : 0;
    if ((deltaX < 0 && ancestor.scrollLeft <= 0) || (deltaX > 0 && ancestor.scrollLeft >= ancestor.scrollWidth - ancestor.clientWidth - 1)) {
      deltaX = 0;
    }
    if ((deltaY < 0 && ancestor.scrollTop <= 0) || (deltaY > 0 && ancestor.scrollTop >= ancestor.scrollHeight - ancestor.clientHeight - 1)) {
      deltaY = 0;
    }
    if (deltaX || deltaY) {
      return { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2, deltaX, deltaY };
    }
  }
  if (point.x >= 0 && point.y >= 0 && point.x < view.innerWidth && point.y < view.innerHeight) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(view.innerWidth - 1, point.x)),
    y: Math.max(0, Math.min(view.innerHeight - 1, point.y)),
    deltaX: point.x - view.innerWidth / 2,
    deltaY: point.y - view.innerHeight / 2,
  };
}

// ---------------------------------------------------------------- hit test

const INTERACTIVE_TAGS = ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "SUMMARY", "LABEL"];
const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "radio", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
]);

export function isExplicitInteractiveElement(element) {
  const tag = tagOf(element);
  if (INTERACTIVE_TAGS.includes(tag)) {
    return true;
  }
  if (tag === "A" && element.hasAttribute?.("href")) {
    return true;
  }
  if (element?.hasAttribute?.("contenteditable") && element.getAttribute("contenteditable") !== "false") {
    return true;
  }
  return INTERACTIVE_ROLES.has(roleAttr(element));
}

function isInteractiveElement(element) {
  return isExplicitInteractiveElement(element) || Boolean(element?.isContentEditable);
}

/**
 * The topmost element at `point`, descending into shadow roots only along the
 * target's own host chain.
 */
export function hitElementAtPoint(target, point) {
  const roots = [];
  for (let parent = target; parent; ) {
    const root = parent.getRootNode ? parent.getRootNode() : null;
    if (!root || typeof root.elementsFromPoint !== "function") {
      break;
    }
    roots.push(root);
    if (root.nodeType === 9) {
      break;
    }
    parent = root.host;
  }
  let hitElement;
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const root = roots[index];
    const elements = root.elementsFromPoint(point.x, point.y);
    const innerElement = elements[0] || root.elementFromPoint(point.x, point.y);
    if (!innerElement) {
      break;
    }
    hitElement = innerElement;
    if (index > 0 && innerElement !== roots[index - 1].host) {
      break;
    }
  }
  return hitElement;
}

/**
 * Null when input at `point` reaches `target`: the hit is the target, its
 * composed descendant, or an interactive composed ancestor. Otherwise the
 * element that would get the input.
 */
export function interceptingElementAtPoint(target, point) {
  const hitElement = hitElementAtPoint(target, point);
  let current = hitElement;
  while (current && current !== target) {
    current = composedParent(current);
  }
  if (current === target) {
    return null;
  }
  current = target;
  while (current && current !== hitElement) {
    current = composedParent(current);
  }
  if (current === hitElement && isInteractiveElement(hitElement)) {
    return null;
  }
  return hitElement || target.ownerDocument.documentElement;
}

// Ego's page copy of this function mangles `\s` (a template-literal escape),
// so its dialog names differ from these; nothing depends on them.
function dialogName(element) {
  const doc = element?.ownerDocument;
  const labelledBy = String(element?.getAttribute?.("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map(id => doc?.getElementById(id)?.textContent || "")
    .join(" ");
  const heading = element?.querySelector?.("h1,h2,h3,h4,h5,h6")?.textContent || "";
  return String(element?.getAttribute?.("aria-label") || labelledBy || heading || element?.getAttribute?.("title") || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** `dialog "<name>"` inside a modal, else `<tag id="…" role="…" href="…">`. */
export function describeHitTarget(element) {
  for (let modal = element; modal; modal = composedParent(modal)) {
    if (modal.getAttribute?.("role") === "dialog" || modal.getAttribute?.("aria-modal") === "true") {
      const name = dialogName(modal);
      return name ? `dialog "${name.replaceAll('"', '\\"')}"` : "dialog";
    }
  }
  const quote = (value, max) => String(value).slice(0, max).replaceAll('"', "&quot;");
  const tag = String(element.tagName || "unknown").toLowerCase();
  const id = element.id ? ` id="${quote(element.id, 80)}"` : "";
  const role = element.getAttribute?.("role") ? ` role="${quote(element.getAttribute("role"), 80)}"` : "";
  const href = tag === "a" && element.hasAttribute?.("href") ? ` href="${quote(element.getAttribute("href"), 120)}"` : "";
  return `<${tag}${id}${role}${href}>`;
}

// ---------------------------------------------------------------- resolver filter

/**
 * What covers `el` at `point` (its own viewport), for an error: the cover,
 * and the point as a `position` gives it, from the element's top left, with
 * the element's size. So the agent can act on the cover, pick a point of
 * the element it doesn't cover, or force this one, where the cover gets the
 * event as it would get a user's. `end`: a drag's "source" or "target".
 *
 * @returns {{text: string, data: {cover: string, position: {x: number, y: number}, end?: string}}}
 */
export function coveredAt(el, point, interceptor, end) {
  const rect = el.getBoundingClientRect();
  const position = { x: Math.round(point.x - rect.x), y: Math.round(point.y - rect.y) };
  const cover = describeHitTarget(interceptor);
  const which = end ? `the ${end}` : "the element";
  return {
    text:
      `${cover} intercepts pointer events at ${which}'s point (${position.x}, ${position.y}) from its top left;` +
      ` ${which} is ${Math.round(rect.width)} x ${Math.round(rect.height)}`,
    data: { cover, position, ...(end ? { end } : {}) },
  };
}

/**
 * Why the resolver filter rejects `el` for `level` ("visible" | "enabled" |
 * "pointer" | "pointer-enabled"), as Ego words it, or null when it passes.
 * A pointer level tests the action's own point: `spot.position`'s, else the
 * element's middle, so a position the cover leaves free passes. A covered
 * point's `data` names the cover and the point (coveredAt; `spot.end`: a
 * drag's end).
 *
 * @param {Element} el
 * @param {string} level
 * @param {{position?: {x: number, y: number}, end?: string}} [spot]
 * @returns {{text: string, data?: object} | null}
 */
export function actionabilityBlocker(el, level, spot) {
  if (!el.isConnected) {
    return { text: "element is detached from the DOM" };
  }
  if (el.closest?.("[hidden], [inert]")) {
    return { text: "element is hidden or inert" };
  }
  const view = el.ownerDocument?.defaultView;
  if (!view) {
    return { text: "element has no browsing context" };
  }
  const rect = el.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) {
    return { text: "element has a zero-sized bounding box" };
  }
  const style = view.getComputedStyle(el);
  if (style?.display === "none") {
    return { text: "element has display: none" };
  }
  if (style?.visibility === "hidden") {
    return { text: "element has visibility: hidden" };
  }
  if ((level === "enabled" || level === "pointer-enabled") && isActionTargetDisabled(el)) {
    return { text: "element is disabled" };
  }
  if (level === "pointer" || level === "pointer-enabled") {
    const point = spot?.position ? positionPoint(el, spot.position) : actionPointForElement(el);
    if (!point) {
      return { text: "element has no actionable point" };
    }
    if (!scrollRequestForPoint(el, point)) {
      const interceptor = interceptingElementAtPoint(el, point);
      if (interceptor) {
        return coveredAt(el, point, interceptor, spot?.end);
      }
    }
  }
  return null;
}

/** Visible for Ego's ambiguity counts: a box, displayed, visible, not transparent. */
export function isCountedVisible(el) {
  if (!el.isConnected) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) {
    return false;
  }
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return !!style && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

// ---------------------------------------------------------------- retargeting

export function isExplicitContentEditable(element) {
  return Boolean(element?.hasAttribute?.("contenteditable") && element.getAttribute("contenteditable") !== "false");
}

const FILLABLE_INPUT_TYPES = new Set([
  "", "color", "date", "datetime-local", "email", "month", "number",
  "password", "range", "search", "tel", "text", "time", "url", "week",
]);

export function isFillableInput(element) {
  const tag = tagOf(element);
  if (tag === "TEXTAREA") {
    return true;
  }
  if (tag !== "INPUT") {
    return false;
  }
  return FILLABLE_INPUT_TYPES.has(String(element.type || "").toLowerCase());
}

export function isFillableActionTarget(element) {
  return isExplicitContentEditable(element) || isFillableInput(element);
}

const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

export function isEditableFocusTarget(element) {
  const editable = isFillableActionTarget(element) || tagOf(element) === "SELECT" || EDITABLE_ROLES.has(roleAttr(element));
  return editable && !isActionTargetDisabled(element);
}

const STRONG_FOCUS_ROLES = new Set([
  "button", "checkbox", "link", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "radio", "slider", "switch", "tab", "treeitem",
]);

export function isStrongFocusTarget(element) {
  if (!element?.isConnected || isActionTargetDisabled(element) || element.closest?.("[inert]")) {
    return false;
  }
  if (isEditableFocusTarget(element)) {
    return true;
  }
  const tag = tagOf(element);
  if (["BUTTON", "SELECT", "TEXTAREA", "SUMMARY", "IFRAME"].includes(tag)) {
    return true;
  }
  if (tag === "INPUT") {
    return String(element.type || "").toLowerCase() !== "hidden";
  }
  if ((tag === "A" || tag === "AREA") && element.hasAttribute("href")) {
    return true;
  }
  if ((tag === "AUDIO" || tag === "VIDEO") && element.hasAttribute("controls")) {
    return true;
  }
  return STRONG_FOCUS_ROLES.has(roleAttr(element));
}

/**
 * fill's target: the field itself, its editing host, or its unique fillable
 * descendant. Throws the message Ego's page throws for several.
 */
export function fillTarget(el) {
  const tag = tagOf(el);
  if (tag === "INPUT" || tag === "TEXTAREA" || isExplicitContentEditable(el)) {
    return el;
  }
  const host = nearestComposedAncestor(el, isExplicitContentEditable);
  if (host) {
    return host;
  }
  const candidates = composedDescendantMatches(el, isFillableActionTarget, true);
  if (candidates.length > 1) {
    throw new TypeError("page.fill selected an element with multiple fillable targets");
  }
  return candidates[0] || el;
}

/** selectOption's target: the select, a label's select, or the unique select inside. */
export function selectTarget(el) {
  if (tagOf(el) === "SELECT") {
    return { select: el };
  }
  if (tagOf(el.control) === "SELECT") {
    return { select: el.control };
  }
  const selects = composedDescendantMatches(el, c => tagOf(c) === "SELECT", true);
  if (selects.length > 1) {
    return { error: "element contains multiple select controls" };
  }
  return selects.length ? { select: selects[0] } : { error: "element is not a select control" };
}

function isFileInput(el) {
  return tagOf(el) === "INPUT" && String(el.type || "").toLowerCase() === "file";
}

/** setInputFiles's target: the file input, its label, or the unique one inside. */
export function fileInputTarget(el) {
  if (isFileInput(el)) {
    return el;
  }
  if (tagOf(el) === "LABEL" && isFileInput(el.control)) {
    return el.control;
  }
  const label = nearestComposedAncestor(el, a => tagOf(a) === "LABEL" && isFileInput(a.control));
  if (label) {
    return label.control;
  }
  const inputs = composedDescendantMatches(el, isFileInput, true);
  if (inputs.length > 1) {
    throw new TypeError("page.setInputFiles selected a container with multiple file inputs");
  }
  if (!inputs.length) {
    throw new TypeError("page.setInputFiles requires a file input, its label, or a container with a file input");
  }
  return inputs[0];
}
