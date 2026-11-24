/* The address bar's '>' dispatch to the agent sidebar (zen-sidebar's,
 * until zen-ux builds the official one from it).
 *
 * Input that starts with '>' gets a first row "Ask agent: <text>", without
 * the '>'. Enter or a click on it starts a new work chat with <text>:
 * AgentSidebar.sys.mjs's startWorkChat, which opens the agent sidebar in
 * Work mode on a new task, bound to the task rather than the tab. The user
 * stays on their page. Other input gets the same row second, below the
 * address bar's own first row. Without that module (a sidebar from before
 * the two modes), the text goes to the tab's conversation, as before.
 *
 * Two providers in the address bar's providers manager:
 *  - ZeniusAskAgent, a heuristic provider. For '>' input its priority leaves
 *    the query to it alone. Its row carries no keyword, so a typed "> " stays
 *    text instead of entering Firefox's Actions search mode, whose token is
 *    '>'.
 *  - ZeniusAskAgentSuggest, the second row (suggestedIndex 1) for other input.
 * Both rows are .urlbarView-row[dynamicType="zeniusAskAgent"]; tests find
 * them by that and the providerName (docs/agent-sidebar.md), not the icon.
 * The module is shared by the process's windows, so they're registered once.
 */
import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { ProvidersManager } from "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs";
import { UrlbarResult } from "chrome://browser/content/urlbar/UrlbarResult.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const LOG = "[agent-urlbar]";
const DYNAMIC_TYPE = "zeniusAskAgent";
const SIDEBAR_MODULE = new URL("../agent-sidebar/AgentSidebar.sys.mjs", import.meta.url).href;
const PANEL = "viewAgentSidebar";

// The icon, the user's option A: the installed Zen's own search glass, gray,
// with a big star breaking its rim at the top left and a small star in the
// lens, both purple; one variant per color scheme. The glass is read from Zen
// at the first query, so the rim is that Zen's own (1.24.2b and 1.24.3b draw
// it differently), and nothing of it is copied. Firefox's own glass stands in
// for a Zen without one, and the stars alone for neither.
//
// The stars are zenius's own drawing, made below from two ratios. Zen's
// sparkles.svg, which option A's mockup took its star from, is a Nucleo icon
// (as is the glass), and Nucleo's license forbids passing its icons on, so no
// path data of theirs is in zenius (tests/ux/iconpaths.test.mjs).
const GLASS_URLS = ["chrome://browser/skin/zen-icons/search-glass.svg", "chrome://global/skin/icons/search-glass.svg"];

/**
 * A four-pointed star with concave sides, centred on 0,0, its points `r`
 * from the centre: each side a curve from one point to the next whose
 * handles run along the arms, at 12% and 30% of `r`, so the arms stay thin
 * near the points.
 *
 * @param {number} r
 */
function starPath(r) {
  const [n, a, b] = [r, 0.12 * r, 0.3 * r].map(v => +v.toFixed(3));
  return (
    `M0 ${-n}` +
    `C${a} ${-b} ${b} ${-a} ${n} 0` +
    `C${b} ${a} ${a} ${b} 0 ${n}` +
    `C${-a} ${b} ${-b} ${a} ${-n} 0` +
    `C${-b} ${-a} ${-a} ${-b} 0 ${-n}Z`
  );
}
// As big as option A's star in its 18x18 box, placed as the mockup placed it.
const STAR = starPath(5.54);
const BIG_STAR = "translate(3.92 3.85) scale(.66)";
const SMALL_STAR = "translate(7.4 7) scale(.3)";
const COLORS = { light: { rim: "#5f5f66", star: "#7c5cff" }, dark: { rim: "#b4b4ba", star: "#a48bff" } };

/** The glass's shapes, painted `rim`, scaled into the 18x18 box, with the
 * big star's cut; "" without a glass. */
function rimMarkup(glass, rim) {
  if (!glass) {
    return "";
  }
  const shapes = glass.markup
    .replace(/context-(fill|stroke)-opacity/g, "1")
    .replace(/context-(fill|stroke)/g, rim);
  return `<g fill="${rim}" mask="url(#zuaCut)"><g transform="scale(${18 / glass.size})">${shapes}</g></g>`;
}

function iconURL(glass, { rim, star }) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="16" height="16">` +
    `<defs><path id="zuaStar" d="${STAR}"/>` +
    `<mask id="zuaCut" maskUnits="userSpaceOnUse" x="-1" y="-1" width="20" height="20">` +
    `<rect x="-1" y="-1" width="20" height="20" fill="#fff"/>` +
    `<use href="#zuaStar" transform="${BIG_STAR}" fill="#000" stroke="#000" stroke-width="3.2" stroke-linejoin="round"/>` +
    `</mask></defs>` +
    rimMarkup(glass, rim) +
    `<use href="#zuaStar" transform="${BIG_STAR}" fill="${star}"/>` +
    `<use href="#zuaStar" transform="${SMALL_STAR}" fill="${star}"/>` +
    `</svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

/** The installed glass: its shapes' markup and its box's width, or null. */
async function readGlass(win) {
  for (const url of GLASS_URLS) {
    try {
      const text = await (await win.fetch(url)).text();
      const root = new win.DOMParser().parseFromString(text, "image/svg+xml").documentElement;
      if (root?.localName !== "svg") {
        continue;
      }
      const box = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
      const size = box.length === 4 && box[2] > 0 ? box[2] : Number.parseFloat(root.getAttribute("width")) || 18;
      const serializer = new win.XMLSerializer();
      const markup = [...root.children]
        .filter(el => !["title", "desc", "metadata"].includes(el.localName))
        .map(el => serializer.serializeToString(el))
        .join("");
      if (markup) {
        return { markup, size };
      }
    } catch (e) {
      console.debug(LOG, "no search glass at", url, e?.message);
    }
  }
  return null;
}

// Until the glass is read, and if it can't be: the stars alone.
const STARS_ONLY = { light: iconURL(null, COLORS.light), dark: iconURL(null, COLORS.dark) };
let icons = null;
let iconsRead = null;

/** The icon in both color schemes, the installed glass read once. */
function loadIcons() {
  iconsRead ??= (async () => {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const glass = win ? await readGlass(win) : null;
    icons = glass ? { light: iconURL(glass, COLORS.light), dark: iconURL(glass, COLORS.dark) } : STARS_ONLY;
    return icons;
  })().catch(e => {
    console.error(LOG, "the icon's glass", e);
    icons = STARS_ONLY;
    return icons;
  });
  return iconsRead;
}

const VIEW_TEMPLATE = {
  attributes: { selectable: true },
  children: [
    {
      name: "content",
      tag: "span",
      attributes: { class: "urlbarView-no-wrap" },
      children: [
        { name: "icon", tag: "img", attributes: { class: "urlbarView-favicon" } },
        { name: "title", tag: "span", attributes: { class: "urlbarView-title" } },
      ],
    },
  ],
};

/** The browser window behind a query, when it has the agent sidebar. */
/** The query's window, when its sidebar has an agent to ask: with no agent
 * configured (a profile without the sidebar's config) there is no row. */
function sidebarWindow(controller) {
  const win = controller?.browserWindow;
  return win?.ucAgentSidebar?.AgentService?.harnessList().length ? win : null;
}

/** Start a work chat with the text, in the window's agent sidebar. */
async function dispatch(win, text) {
  const sidebar = win?.ucAgentSidebar;
  if (!sidebar) {
    console.error(LOG, "this window has no agent sidebar");
    return;
  }
  let startWorkChat = null;
  try {
    ({ startWorkChat } = ChromeUtils.importESModule(SIDEBAR_MODULE));
  } catch {}
  if (startWorkChat) {
    await startWorkChat(win, { text, source: "urlbar" });
    return;
  }
  await dispatchToTab(win, sidebar, text);
}

/** The sidebar before the two modes: the tab's conversation gets the text. */
async function dispatchToTab(win, sidebar, text) {
  const { AgentService } = sidebar;
  const conv = sidebar.conversationFor(win.gBrowser.selectedTab);
  // A new conversation goes to the agent the sidebar would pick for one.
  // That's zenius's choice, not the user's, so it isn't kept as their pick.
  const preferred = AgentService.preferredHarness();
  if (!conv.messages.length && !conv.busy && conv.harness !== preferred) {
    AgentService.setHarness(conv, preferred, { pick: false });
  }
  const controller = win.SidebarController;
  if (!(controller.isOpen && controller.currentID === PANEL)) {
    await controller.show(PANEL);
  }
  for (let i = 0; i < 100 && !sidebar.panel; i++) {
    await new Promise(resolve => win.setTimeout(resolve, 50));
  }
  const panel = sidebar.panel;
  if (!panel) {
    console.error(LOG, "the agent sidebar's panel didn't open");
    return;
  }
  if (text && conv.busy) {
    // The agent is still answering in this tab: leave the text to send, in
    // the draft as AgentService keeps it (setDraft, the one way a draft is written).
    AgentService.setDraft(conv, { ...conv.draft, text });
  }
  panel.show(conv);
  if (text && !conv.busy) {
    sidebar.submit(conv, { question: text, selection: "", attachments: [] }).catch(e => console.error(LOG, e));
  }
  panel.compose(conv, { selection: "" });
}

class AgentAskBase extends UrlbarProvider {
  getViewTemplate() {
    return VIEW_TEMPLATE;
  }

  getViewUpdate(result, controller) {
    const win = controller?.browserWindow ?? Services.wm.getMostRecentWindow("navigator:browser");
    const dark = !!win?.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const text = result.payload.query;
    const set = icons ?? STARS_ONLY;
    return {
      icon: { attributes: { src: dark ? set.dark : set.light } },
      title: { textContent: text ? `Ask agent: ${text}` : "Ask agent" },
    };
  }

  onEngagement(queryContext, controller, details) {
    const result = details?.result;
    if (!result || result.providerName !== this.name) {
      return;
    }
    // By now the box has reverted to the page's URL: the address bar reverts
    // before it tells the row's provider. It would stay open, the URL selected
    // in it, until the sidebar took focus a few frames on. Closed in this same
    // task, no frame shows that; Zen's floating box closes with the view and
    // gives the page focus. The sidebar's releaseAddressBar does it: the rule
    // for every focus our code moves out of the address bar, which an IME
    // needs.
    try {
      const sidebar = controller?.browserWindow?.ucAgentSidebar;
      if (sidebar?.releaseAddressBar) {
        sidebar.releaseAddressBar();
      } else {
        (controller?.input ?? controller?.browserWindow?.gURLBar)?.view?.close();
      }
    } catch (e) {
      console.error(LOG, "closing the address bar", e);
    }
    dispatch(controller?.browserWindow, result.payload.query).catch(e => console.error(LOG, e));
  }

  result(queryContext, text, extra) {
    return new UrlbarResult({
      type: UrlbarShared.RESULT_TYPE.DYNAMIC,
      source: UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
      ...extra,
      // `input` keeps the address bar's text as typed while the row is selected.
      payload: { dynamicType: DYNAMIC_TYPE, query: text, input: queryContext.searchString },
    });
  }
}

class AgentAskProvider extends AgentAskBase {
  get name() {
    return "ZeniusAskAgent";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.HEURISTIC;
  }

  async isActive(queryContext, controller) {
    return (
      queryContext.sapName == "urlbar" &&
      !queryContext.searchMode &&
      queryContext.searchString.trimStart().startsWith(">") &&
      !!sidebarWindow(controller)
    );
  }

  // Only for '>' input (isActive): the query is this provider's alone.
  getPriority() {
    return 99;
  }

  async startQuery(queryContext, addCallback) {
    await loadIcons();
    const text = queryContext.searchString.trimStart().slice(1).trim();
    addCallback(this, this.result(queryContext, text, { heuristic: true }));
  }
}

class AgentAskSuggestProvider extends AgentAskBase {
  get name() {
    return "ZeniusAskAgentSuggest";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  async isActive(queryContext, controller) {
    const text = queryContext.trimmedSearchString;
    return (
      queryContext.sapName == "urlbar" &&
      !queryContext.searchMode &&
      !queryContext.restrictToken &&
      !!text &&
      !text.startsWith(">") &&
      !!sidebarWindow(controller)
    );
  }

  async startQuery(queryContext, addCallback) {
    await loadIcons();
    addCallback(this, this.result(queryContext, queryContext.trimmedSearchString, { suggestedIndex: 1 }));
  }
}

const manager = ProvidersManager.getInstanceForSap("urlbar");
for (const provider of [new AgentAskProvider(), new AgentAskSuggestProvider()]) {
  if (!manager.getProvider(provider.name)) {
    manager.registerProvider(provider);
  }
}

export const AgentUrlbar = { dispatch, loadIcons };
