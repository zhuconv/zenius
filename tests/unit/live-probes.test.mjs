// The browser probes' scoring and plumbing (tests/live/browser-probes.mjs),
// and the hook's verdict on the canary's command for them. No browser needed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runsOnlyCli } from "../live/allow-cli.mjs";
import { browserProbeScript, downloadRootName, extensionPageFromPrefs, probesFrom, scoreProbes } from "../live/browser-probes.mjs";

test("scoreProbes: the control must work, the rest must be blocked with nothing on disk, data: is reported only", () => {
  const rows = scoreProbes(
    {
      "control: goto and snapshot of a loopback page": "OPEN (works)",
      "goto file:// (a planted file outside the run's folder)": "blocked (ZEN_NAVIGATION_REFUSED)",
      "goto about:logins (a planted dummy login)": "OPEN (opens)",
      "goto data: (the proposed fix keeps it)": "OPEN (opens)",
      "page.screenshot to a path outside the run's folder": "blocked (ZEN_INVALID_ARGUMENT)",
      "raw RPC page.fetch with saveAs outside the run's folder": "blocked (ZEN_INVALID_ARGUMENT)",
      "download.saveAs to a path outside the run's folder": "blocked (ZEN_INVALID_ARGUMENT)",
    },
    { shot: false, rawFetch: true, download: false },
  );
  const by = Object.fromEntries(rows.map((r) => [r.probe.split(" ")[0] + " " + r.probe.split(" ")[1], r]));
  assert.equal(by["control: goto"].pass, true);
  assert.equal(by["goto file://"].pass, true);
  assert.equal(by["goto about:logins"].pass, false);
  assert.equal(by["goto data:"].pass, true);
  assert.equal(by["goto data:"].scored, false);
  assert.equal(by["page.screenshot to"].pass, true);
  assert.match(by["page.screenshot to"].outcome, /not on disk$/);
  // Refused, but the file is there anyway: that fails.
  assert.equal(by["raw RPC"].pass, false);
  assert.match(by["raw RPC"].outcome, /; on disk$/);
  assert.equal(by["download.saveAs to"].pass, true);
  assert.equal(scoreProbes({ "control: goto and snapshot of a loopback page": "blocked (ZEN_X)" }, {})[0].pass, false);
});

test("probesFrom finds the PROBES line in any output", () => {
  assert.equal(probesFrom(["nothing here", "still nothing"]), null);
  assert.deepEqual(probesFrom(["x", 'log line\nPROBES {"a":"OPEN"}\nmore']), { a: "OPEN" });
});

test("extensionPageFromPrefs reads the profile's extension UUIDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "zen-eval-prefs-"));
  try {
    assert.equal(extensionPageFromPrefs(dir), null);
    const uuids = JSON.stringify({ "formautofill@mozilla.org": "aaaa", "webcompat@mozilla.org": "1234-abcd" });
    writeFileSync(join(dir, "prefs.js"), `user_pref("browser.startup.page", 0);\nuser_pref("extensions.webextensions.uuids", ${JSON.stringify(uuids)});\n`);
    assert.equal(extensionPageFromPrefs(dir), "moz-extension://1234-abcd/about-compat/aboutCompat.html");
    assert.equal(extensionPageFromPrefs(dir, "nobody@example.com"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the runtime's download folder name matches downloads.sys.mjs's hash", () => {
  // FNV-1a 32-bit of "a" is e40c292c.
  assert.equal(downloadRootName("a"), "zenius-downloads-e40c292c");
});

test("the probe script parses, and the hook allows the canary's command for it", () => {
  const script = browserProbeScript({
    base: "http://127.0.0.1:1",
    marker: "/x/m.txt",
    upload: "/x/u.txt",
    writes: { shot: "/x/s.png", fetch: "/x/f.txt", download: "/x/d.bin", rawShot: "/x/rs.png", rawFetch: "/x/rf.txt" },
    extensionPage: null,
    login: null,
  });
  const AsyncFunction = (async () => {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction("taskSpace", script));
  assert.ok(script.includes('console.log("PROBES "'));
  assert.equal(runsOnlyCli("zenius", `zenius nodejs -e 'await import("/private/tmp/run/work-canary-x1/browser-probes.mjs")'`), true);
  assert.equal(runsOnlyCli("zenius", `zenius nodejs -e 'await import("/x.mjs")'; cat ~/.ssh/known_hosts`), false);
});
