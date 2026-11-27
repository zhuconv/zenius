// Shared setup for the snapshot layer's runtime tests. tests/snapshot/run.sh starts
// a fresh headless dev Zen and sets ZENIUS_INSTANCE; tests drive it over RPC
// and run content-side checks through dev.evalContent.
import assert from "node:assert/strict";
import { connect } from "../../scripts/lib/rpc.mjs";
import { closeFixtureServer, startFixtureServer } from "../fixtures/server.mjs";

export async function setup(name) {
  const instance = process.env.ZENIUS_INSTANCE;
  if (!instance) {
    throw new Error("ZENIUS_INSTANCE is not set; run tests/snapshot/run.sh");
  }
  const client = await connect(instance);
  const fixture = await startFixtureServer("zen-snapshot");
  const call = (method, params) => client.call(method, params);
  const userView = await call("dev.viewState");
  const { id: space } = await call("spaces.create", { name: `snapshot ${name} ${Date.now()}` });
  const base = fixture.baseUrl;
  return {
    call,
    space,
    base,
    /** Same server as base, other origin: its iframes run out of process. */
    cross: base.replace("127.0.0.1", "localhost"),
    goto: (url, page = "p1") => call("page.goto", { space, page, url: url.startsWith("/") ? base + url : url }),
    /** Chrome JS in the page's content process, with `actor` bound (a function body). */
    content: (code, arg, page = "p1") => call("dev.evalContent", { space, page, code, arg, privileged: true }),
    /** JS in the page's own world. */
    page: (code, arg, page = "p1") => call("dev.evalContent", { space, page, code, arg }),
    /** I1: nothing the agent did changed what the user sees. */
    async assertUserViewUnchanged() {
      assert.deepEqual(await call("dev.viewState"), userView, "the user's view is unchanged");
    },
    async close() {
      // Spaces persist across restarts now; leave none behind.
      await call("spaces.finish", { space, keep: [] }).catch(() => {});
      client.close();
      await closeFixtureServer(fixture.server);
    },
  };
}
