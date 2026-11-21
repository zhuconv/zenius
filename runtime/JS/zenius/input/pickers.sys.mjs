// Picker panels in agent tabs (zen-input). A click on <input type=date>, a
// <select> or <input type=color> opens browser UI over the page: the date
// and time panel takes keyboard focus, the dropdown covers the page, and on
// the Mac the color picker is the OS's own panel. While the agent drives a
// tab, none of them opens. page.fill and page.selectOption set the values,
// and the agent hears of each refusal: a Zenius.refused event, and the
// receipt of the action that caused it. While the user holds control
// (handOff, takeover), their own clicks get the pickers.
//
// The panels open from parent actors, so one wrapper on each class covers
// every frame and process: InputPickerParentCommon (date, time, and the HTML
// color picker behind dom.forms.html_color_picker.enabled) and SelectParent.
// The native color picker is an XPCOM component, wrapped like the file
// picker.

import { refuseDeadContext } from "chrome://userscripts/content/zenius/input/filechooser.sys.mjs";
import { reportRefused } from "chrome://userscripts/content/zenius/observe/refusals.sys.mjs";

const PATCHED = Symbol("zenius.pickers");
const COLOR_CONTRACT = "@mozilla.org/colorpicker;1";
const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);

/** @type {{isAgentDriven: (browser: Element) => boolean} | null} */
let host = null;
let colorFactory = null;
/** Native color pickers opened, and refused in agent tabs (tests). */
const stats = { colorNative: 0, colorRefused: 0 };

function agentDriven(browser) {
  try {
    return !!browser && !!host?.isAgentDriven(browser);
  } catch {
    return false;
  }
}

function browserOf(bc) {
  try {
    return bc?.top?.embedderElement ?? null;
  } catch {
    return null;
  }
}

function urlOf(bc) {
  try {
    return bc?.currentURI?.spec ?? "";
  } catch {
    return "";
  }
}

const DATE_TYPES = new Set(["date", "time", "datetime-local", "month", "week"]);

function refuseInputPicker(actor, type) {
  const browser = browserOf(actor.browsingContext);
  // The child waits for its picker to close, as after Escape.
  actor.sendAsyncMessage("InputPicker:Closed", {});
  if (type === "color") {
    stats.colorRefused++;
    reportRefused(browser, "colorPicker", "zenius opens no color picker in agent tabs; set the value with page.fill instead", urlOf(actor.browsingContext));
    return;
  }
  const what = DATE_TYPES.has(type) ? type : "date";
  reportRefused(browser, "datePicker", `zenius opens no ${what} picker in agent tabs; set the value with page.fill instead`, urlOf(actor.browsingContext));
}

function patchInputPickers() {
  const { InputPickerParentCommon } = ChromeUtils.importESModule("moz-src:///toolkit/actors/InputPickerParentCommon.sys.mjs");
  const proto = InputPickerParentCommon.prototype;
  if (proto[PATCHED]) {
    return;
  }
  const receiveMessage = proto.receiveMessage;
  proto.receiveMessage = function (msg) {
    if (msg.name === "InputPicker:Open" && agentDriven(browserOf(this.browsingContext))) {
      refuseInputPicker(this, msg.data?.type);
      return undefined;
    }
    return receiveMessage.call(this, msg);
  };
  proto[PATCHED] = true;
}

function patchSelect() {
  const { SelectParent } = ChromeUtils.importESModule("moz-src:///toolkit/actors/SelectParent.sys.mjs");
  const proto = SelectParent.prototype;
  if (proto[PATCHED]) {
    return;
  }
  const receiveMessage = proto.receiveMessage;
  proto.receiveMessage = function (msg) {
    if (msg.name === "Forms:ShowDropDown") {
      const browser = browserOf(this.browsingContext);
      if (agentDriven(browser)) {
        // As when the user closes it without choosing: the select is unchanged.
        this.sendAsyncMessage("Forms:DismissedDropDown", {});
        reportRefused(browser, "selectDropdown", "zenius opens no dropdown for a <select> in agent tabs; choose with page.selectOption instead", urlOf(this.browsingContext));
        return undefined;
      }
    }
    return receiveMessage.call(this, msg);
  };
  proto[PATCHED] = true;
}

/**
 * nsIColorPicker for agent tabs: answers with the input's own color, as when
 * the user closes the panel without choosing. Any other tab gets the
 * platform's picker.
 */
/**
 * Gecko's own color picker, for a tab the agent doesn't drive. Gecko 160 has
 * no Components.classesByID, nor any other way to make a component by its
 * CID, so the contract names Gecko's picker for this one synchronous call,
 * then zenius's again.
 */
function platformColorPicker() {
  if (!colorFactory) {
    return Cc[COLOR_CONTRACT].createInstance(Ci.nsIColorPicker);
  }
  registrar.registerFactory(colorFactory.origCID, "", COLOR_CONTRACT, null);
  try {
    return Cc[COLOR_CONTRACT].createInstance(Ci.nsIColorPicker);
  } finally {
    registrar.registerFactory(colorFactory.cid, "", COLOR_CONTRACT, null);
  }
}

class ColorPicker {
  constructor(origCID) {
    this.origCID = origCID;
    this.real = null;
    // Tests reach the picker behind XPConnect.
    this.wrappedJSObject = this;
  }

  init(context, title, initialColor, ...rest) {
    // A BrowsingContext since Gecko 121; a window before.
    const bc = context?.browsingContext ?? context;
    refuseDeadContext(bc);
    const browser = browserOf(bc);
    if (agentDriven(browser)) {
      this.browser = browser;
      this.url = urlOf(bc);
      this.initialColor = initialColor;
      return;
    }
    const real = platformColorPicker();
    real.init(context, title, initialColor, ...rest);
    this.real = real;
  }

  open(callback) {
    if (this.real) {
      stats.colorNative++;
      this.real.open(callback);
      return;
    }
    if (!this.browser) {
      throw Components.Exception("the color picker isn't initialized", Cr.NS_ERROR_NOT_INITIALIZED);
    }
    stats.colorRefused++;
    reportRefused(this.browser, "colorPicker", "zenius opens no color picker in agent tabs; set the value with page.fill instead", this.url);
    // Later, as a platform picker answers: the caller may not expect its
    // callback inside open().
    const color = this.initialColor;
    Services.tm.dispatchToMainThread(() => callback.done(color));
  }
}
Object.defineProperty(ColorPicker.prototype, "QueryInterface", {
  value: ChromeUtils.generateQI(["nsIColorPicker"]),
});

function wrapColorPicker() {
  if (colorFactory) {
    return;
  }
  const origCID = registrar.contractIDToCID(COLOR_CONTRACT);
  const cid = Services.uuid.generateUUID();
  const factory = {
    createInstance(iid) {
      return new ColorPicker(origCID).QueryInterface(iid);
    },
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
  };
  registrar.registerFactory(cid, "zenius agent color picker", COLOR_CONTRACT, factory);
  colorFactory = { cid, factory, origCID };
}

/**
 * Install once per parent process.
 *
 * @param {{isAgentDriven: (browser: Element) => boolean}} h
 */
export function installPickerGuards(h) {
  host = h;
  patchInputPickers();
  patchSelect();
  wrapColorPicker();
}

/** How many native color pickers opened, and how many agent tabs were refused one. */
export function pickerStats() {
  return { ...stats };
}
