// The tests' user and Gecko's input delay after a load.
//
// The suites play the user's mouse as OS input comes: mouse events with
// isDOMEventSynthesized false, which nothing flags as synthesized for tests.
// Gecko ignores such input aimed at a document until the document has had
// dom.input_events.security.minNumTicks refresh ticks and
// minTimeElapsedInMS since it began loading, against clickjacking (3 ticks
// and 100 ms by default). zenius's own events, and keys typed through a test
// transaction, carry the flag, so the delay never applies to them
// (content/input.sys.mjs). A user's click sent sooner is lost, as a
// person's would be, and load on the machine widens the window. A person
// would click again; a test waits instead, so that every click it sends
// must take:
// - a plain user helper waits before each click;
// - a flow whose user races zenius's input waits once after its page's
//   load, before the race, so that the race keeps its timing.
// Widening the window through ZENIUS_DEV_PREFS (minTimeElapsedInMS 1500,
// minNumTicks 30) finds the tests at risk.

/**
 * Privileged content code for dev.evalContent, where `actor` is the page's
 * actor: it waits until the page's top document takes a person's input, and
 * returns how long that took in ms. It waits for Gecko's tick count plus one
 * refresh tick, then until Gecko's time plus a margin has passed since the
 * document began loading (performance.timing.domLoading, where Gecko starts
 * that clock). A page shown again from the bfcache restarts Gecko's clock,
 * which domLoading doesn't show. Its callbacks are privileged, so it leaves
 * no code in the page.
 */
export const UNTIL_TAKES_INPUT = `const win = actor.contentWindow;
  const started = win.performance.now();
  const ticks = Services.prefs.getIntPref("dom.input_events.security.minNumTicks", 0);
  const ms = Services.prefs.getIntPref("dom.input_events.security.minTimeElapsedInMS", 0);
  const t = win.performance.timing;
  // When the document began loading, on the clock performance.now() reads.
  const loading = t.domLoading ? t.domLoading - t.navigationStart : 0;
  for (let i = 0; i <= ticks; i++) {
    await new Promise(resolve => win.requestAnimationFrame(() => resolve()));
  }
  for (let left; (left = loading + ms + 20 - win.performance.now()) > 0; ) {
    await new Promise(resolve => win.setTimeout(resolve, Math.ceil(left)));
  }
  return Math.round(win.performance.now() - started);`;

/**
 * The same as a statement for dev.evalChrome code: it waits in the page of
 * the browsing context that `bc`, an expression there, names.
 *
 * @param {string} bc
 */
export function untilTakesInput(bc) {
  return `await ctx.content(${bc}, "dev#evalContent", { privileged: true, code: ${JSON.stringify(UNTIL_TAKES_INPUT)} });`;
}
