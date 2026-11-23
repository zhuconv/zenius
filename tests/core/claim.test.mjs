// The user's say over claims and takeovers (SPEC §3.4). A claim's ask waits for the
// user's answer in the browser (zen-ux's prompt), and takeOver waits until
// 10 s after the user's last real input in the task's tabs.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { connect } from "../../scripts/lib/rpc.mjs";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

const failure = promise => promise.then(() => null, e => e);
const asks = space => h.chrome(`return ctx.spaces.pendingClaims().filter(a => a.space === arg)`, space);

test("a claim's ask waits for the user: allow, deny, no answer, the client gone, one ask per space", async () => {
  const space = await h.userSpace("claim ask");
  const out = await h.chrome(
    `const S = ctx.spaces;
     const rec = S.get(arg);
     const events = [];
     const off = ctx.service.addEventListener((e, p) => e.startsWith("claim") && events.push([e, p]));
     const settle = p => p.then(() => "allowed", e => e.code + ":" + (e.data?.verdict ?? ""));
     try {
       // Allow; a second claim joins the first ask.
       const conn = { state: {} };
       const a = settle(S.askClaim(rec, { client: "Test agent", timeout: 60000, conn }));
       const b = settle(S.askClaim(rec, { client: "Another" }));
       const pending = S.pendingClaims();
       S.answerClaim(pending[0].id, true);
       const allowed = [await a, await b];
       const hooksAfterAllow = conn.state.onClose.length;
       const c = settle(S.askClaim(rec, {}));
       const unknown = S.answerClaim("claim-nobody", true);
       S.answerClaim(S.pendingClaims()[0].id, false);
       const denied = await c;
       const timedOut = await settle(S.askClaim(rec, { timeout: 200 }));
       const gone = { state: {} };
       const d = settle(S.askClaim(rec, { conn: gone }));
       const beforeClose = S.pendingClaims().length;
       gone.state.onClose.forEach(fn => fn());
       return { pending, allowed, hooksAfterAllow, unknown, denied, timedOut, beforeClose, gone: await d, left: S.pendingClaims(), events };
     } finally {
       off();
     }`,
    space
  );
  assert.equal(out.pending.length, 1, "one ask for both claims");
  const [ask] = out.pending;
  assert.deepEqual(Object.keys(ask).sort(), ["client", "id", "name", "space", "until"]);
  assert.equal(ask.space, space);
  assert.equal(ask.client, "Test agent");
  assert.match(ask.name, /^claim ask /);
  assert.ok(ask.until > Date.now() + 50000);
  assert.deepEqual(out.allowed, ["allowed", "allowed"]);
  assert.equal(out.hooksAfterAllow, 0, "a settled claim leaves no hook on its connection");
  assert.equal(out.unknown, false);
  assert.equal(out.denied, "ZEN_TASK_SPACE_CLAIM_DENIED:deny");
  assert.equal(out.timedOut, "ZEN_TASK_SPACE_CLAIM_DENIED:timeout");
  assert.equal(out.beforeClose, 1);
  assert.equal(out.gone, "ZEN_TASK_SPACE_CLAIM_DENIED:gone");
  assert.deepEqual(out.left, []);
  assert.deepEqual(
    out.events.map(([event, p]) => [event, p.verdict ?? null]),
    ["allow", "deny", "timeout", "gone"].flatMap(verdict => [
      ["claimAsked", null],
      ["claimSettled", verdict],
    ])
  );
  assert.deepEqual(out.events[0][1], ask, "claimAsked says what pendingClaims does");
  await h.remove(space);
});

test("a claim's ask ends when the space goes", async () => {
  const space = await h.userSpace("claim gone");
  const out = await h.chrome(
    `const rec = ctx.spaces.get(arg);
     const waiting = ctx.spaces.askClaim(rec, {}).then(() => "allowed", e => e.code);
     win.gZenWorkspaces.removeWorkspace(rec.uuid);
     ctx.spaces.refresh();
     return { result: await waiting, left: ctx.spaces.pendingClaims().length };`,
    space
  );
  assert.deepEqual(out, { result: "ZEN_TASK_SPACE_NOT_FOUND", left: 0 });
});

test("the name a client gives itself is cleaned for the claim prompt", async () => {
  const inputs = [
    "Claude Code",
    "  spaced\n\tname  ",
    "evil\u202Egnp.exe",
    "zero\u200Bwidth\u2066bidi\u2069",
    "line\u2028break",
    "a".repeat(50),
    "",
    "\u0000\u0007",
    42,
  ];
  const labels = await h.chrome(
    `const S = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/spaces.sys.mjs");
     return arg.map(t => S.clientLabel(t));`,
    inputs
  );
  assert.deepEqual(labels, [
    "Claude Code",
    "spaced name",
    "evilgnp.exe",
    "zerowidthbidi",
    "line break",
    "a".repeat(40),
    null,
    null,
    null,
  ]);
});

test("dev.answerClaim answers nothing when the claim needs no ask", async () => {
  const space = await h.space("claim none");
  const [claimed, answer] = await Promise.all([
    h.call("spaces.claim", { space }),
    h.call("dev.answerClaim", { space, timeout: 2000 }),
  ]);
  assert.equal(claimed.ownership, "agent");
  assert.deepEqual(answer, { verdict: null });
  await h.call("spaces.finish", { space, keep: [] });
});

test("takeOver, and a claim of a task handed to the user, wait 10 s after the user's last input there", async () => {
  const space = await h.space("claim quiet");
  await h.call("spaces.handOff", { space });
  await h.chrome(`ctx.spaces.noteUserInput(ctx.spaces.get(arg)); return true`, space);
  const refused = await failure(h.call("spaces.takeOver", { space }));
  assert.equal(refused?.code, "ZEN_TASK_SPACE_USER_IN_CONTROL");
  assert.ok(refused.data.retryAfterMs > 8000 && refused.data.retryAfterMs <= 10000, JSON.stringify(refused.data));
  assert.equal(refused.data.reason, "manual_takeover");
  assert.equal((await failure(h.call("spaces.claim", { space })))?.code, "ZEN_TASK_SPACE_USER_IN_CONTROL");
  assert.equal(await h.ownership(space), "agentDelegatedToUser", "nothing changed");
  // The user stopped 10 s ago.
  await h.chrome(`ctx.spaces.get(arg).lastUserInputAt -= 10000; return true`, space);
  assert.equal((await h.call("spaces.takeOver", { space })).ownership, "agent");
  await h.call("spaces.finish", { space, keep: [] });
});

test("claiming a user workspace waits for the user's Allow, with the client's name cleaned", async () => {
  const space = await h.userSpace("claim allow");
  const claim = h.call("spaces.claim", { space, client: "Test\u202Eagent\n" });
  await h.until(async () => (await asks(space)).length === 1);
  const [ask] = await asks(space);
  assert.equal(ask.client, "Testagent");
  assert.equal(await h.ownership(space), "user", "nothing changes before the answer");
  assert.deepEqual(await h.call("dev.answerClaim", { space }), { id: ask.id, space, verdict: "allow" });
  assert.equal((await claim).ownership, "agent");
  assert.deepEqual(await asks(space), []);
  await h.remove(space);
});

test("a claim of an ended task asks too: Deny or no answer fails it, and the task stays the user's", async () => {
  const space = await h.space("claim ended");
  await h.call("spaces.finish", { space, keep: ["p1"] });
  const [denied, answer] = await Promise.all([
    failure(h.call("spaces.claim", { space })),
    h.call("dev.answerClaim", { space, allow: false }),
  ]);
  assert.equal(answer.verdict, "deny");
  assert.equal(denied?.code, "ZEN_TASK_SPACE_CLAIM_DENIED");
  assert.deepEqual(denied.data, { space, verdict: "deny" });
  assert.equal(await h.ownership(space), "user");
  const unanswered = await failure(h.call("spaces.claim", { space, timeout: 300 }));
  assert.deepEqual(unanswered?.data, { space, verdict: "timeout" });
  assert.equal((await h.claim(space)).ownership, "agent", "a later claim the user allows works");
  await h.call("spaces.finish", { space, keep: [] });
});

test("a claim whose connection closes withdraws its ask", async () => {
  const space = await h.userSpace("claim conn");
  const other = await connect(process.env.ZENIUS_INSTANCE, { callTimeout: 30000 });
  const pending = other.call("spaces.claim", { space }).catch(() => {});
  await h.until(async () => (await asks(space)).length === 1);
  other.close();
  await h.until(async () => (await asks(space)).length === 0);
  await pending;
  assert.equal(await h.ownership(space), "user");
  await h.remove(space);
});
