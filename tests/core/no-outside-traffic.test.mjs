// Every dev Zen gets the prefs that keep it off outside services
// (scripts/dev/no-outside-traffic.js, which zen-dev.sh appends to each dev
// profile's user.js), and Zen takes each of them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const FRAGMENT = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/dev/no-outside-traffic.js");
const PREF_LINE = /^user_pref\("([^"]+)", (.+)\);$/;

/** The fragment's prefs, name to value. */
function fragmentPrefs() {
  const prefs = {};
  for (const line of readFileSync(FRAGMENT, "utf8").split("\n")) {
    const m = line.match(PREF_LINE);
    if (m) {
      prefs[m[1]] = JSON.parse(m[2]);
    }
  }
  return prefs;
}

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h?.close();
});

test("each line of the fragment is a comment or a user_pref that Gecko reads", () => {
  const bad = readFileSync(FRAGMENT, "utf8")
    .split("\n")
    .filter(line => line.trim() && !line.startsWith("//") && !PREF_LINE.test(line));
  assert.deepEqual(bad, []);
});

test("it covers each kind of outside service the rule names", () => {
  const names = Object.keys(fragmentPrefs());
  for (const pref of [
    "datareporting.healthreport.uploadEnabled",
    "datareporting.usage.uploadEnabled",
    "telemetry.fog.test.localhost_port",
    "app.normandy.enabled",
    "network.captive-portal-service.enabled",
    "network.connectivity-service.enabled",
    "dom.push.connection.enabled",
    "network.dns.localDomains",
    "network.http.speculative-parallel-limit",
    "browser.safebrowsing.provider.google4.updateURL",
    "network.trr.mode",
    "browser.search.suggest.enabled",
    "browser.urlbar.quicksuggest.enabled",
    "extensions.update.enabled",
  ]) {
    assert.ok(names.includes(pref), pref);
  }
});

test("a dev Zen has each of the fragment's prefs as its user value", async () => {
  const want = fragmentPrefs();
  const got = await h.chrome(
    `const P = Services.prefs;
     const out = {};
     for (const name of arg) {
       const type = P.getPrefType(name);
       out[name] = !P.prefHasUserValue(name)
         ? "no user value"
         : type === P.PREF_BOOL
           ? P.getBoolPref(name)
           : type === P.PREF_INT
             ? P.getIntPref(name)
             : P.getStringPref(name);
     }
     return out;`,
    Object.keys(want)
  );
  assert.deepEqual(got, want);
});
