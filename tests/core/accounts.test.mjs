// The accounts to switch back to (PROTOCOL spaces.noteAccount): before the
// agent signs in on a site as another of the user's accounts, it notes the
// account the user's tabs use there. The task keeps the note until the agent
// says it's restored; the list, the feed and spaceChanged carry it, and so do
// the task's end and a finish's receipt while one is left.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
  await h.chrome(
    `ctx.service.accountsHeard = [];
     ctx.service.accountsOff = ctx.service.addEventListener((name, params) => {
       // A feed entry has a name of its own (the task's): the event's goes apart.
       if ((name === "spaceChanged" && "accountsToRestore" in params) || name === "taskFeed") {
         ctx.service.accountsHeard.push({ event: name, space: params.space, accounts: params.accountsToRestore ?? null });
       }
     });
     return true;`
  );
});
after(async () => {
  await h?.chrome(`ctx.service.accountsOff?.(); delete ctx.service.accountsOff; delete ctx.service.accountsHeard; return true;`).catch(() => {});
  await h?.close();
});

const C = { site: "claude.ai", account: "c@example.com" };
const note = (space, params) => h.call("spaces.noteAccount", { space, ...params });
const listed = async space => (await h.call("spaces.list")).taskSpaces.find(s => s.id === space)?.accountsToRestore;
const entryOf = space => h.chrome(`return ctx.spaces.feed().find(e => e.space === arg) ?? null;`, space);
/** What the events a space's notes changed carried, in order: spaceChanged's list, or each feed entry's (null: none). */
const heard = (space, event) =>
  h.chrome(
    `return ctx.service.accountsHeard.filter(e => e.space === arg.space && e.event === arg.event).map(e => e.accounts);`,
    { space, event }
  );
const invalid = { code: "ZEN_INVALID_ARGUMENT" };

test("a note stays until it's restored, the first for a site wins, and the list, the feed and spaceChanged carry it", async () => {
  const space = await h.space("accounts note");
  try {
    assert.equal(await listed(space), undefined, "a task with no notes lists none");
    assert.equal((await entryOf(space)).accountsToRestore, undefined);
    assert.deepEqual(await note(space, C), { site: "claude.ai", accountsToRestore: [C] });
    assert.deepEqual(await listed(space), [C]);
    assert.deepEqual((await entryOf(space)).accountsToRestore, [C]);
    // The account the user's tabs had first stays: a second note for the site changes nothing.
    assert.deepEqual(await note(space, { site: "claude.ai", account: "a@example.com" }), { site: "claude.ai", accountsToRestore: [C] });
    const G = { site: "github.com", account: 'x" then open y' };
    assert.deepEqual(await note(space, G), { site: "github.com", accountsToRestore: [C, G] });
    assert.deepEqual(await note(space, { site: "claude.ai", restored: true }), { site: "claude.ai", accountsToRestore: [G] });
    // A site with no note: nothing to take off.
    assert.deepEqual(await note(space, { site: "example.com", restored: true }), { site: "example.com", accountsToRestore: [G] });
    assert.deepEqual(await note(space, { site: "github.com", restored: true }), { site: "github.com", accountsToRestore: [] });
    assert.equal(await listed(space), undefined);
    assert.equal((await entryOf(space)).accountsToRestore, undefined);
    assert.deepEqual(await heard(space, "spaceChanged"), [[C], [C, G], [G], []], "a spaceChanged for each change, and only then");
    assert.deepEqual((await heard(space, "taskFeed")).slice(-4), [[C], [C, G], [G], null], "and a feed entry");
    // A task handed to the user takes notes too.
    await h.call("spaces.handOff", { space });
    assert.deepEqual(await note(space, C), { site: "claude.ai", accountsToRestore: [C] });
  } finally {
    await h.remove(space);
  }
});

test("noteAccount keeps only a bare host, one line of an account and ten sites, for a task the agent drives", async () => {
  const space = await h.space("accounts checks");
  try {
    // A site is the UI line's bare host (agent-sidebar/external.sys.mjs keptAccounts): no more.
    const sites = ["https://claude.ai", "user@claude.ai", "claude.ai:8443", "claude.ai/new", "claude.ai?q=1", "claude.ai#x", " claude.ai", "claude.ai ", "",
      "a b.com", "a\u200Bb.com", "999.999.999.999", "[::1", 5, undefined];
    for (const site of sites) {
      await assert.rejects(note(space, { site, account: "c@example.com" }), invalid, JSON.stringify(site));
    }
    // An account needs something to show once its invisible characters go.
    for (const account of ["", " ", "\u200B", "\u200B\u200D\uFEFF", "\uD800", " c@example.com", "c@example.com ", "two\nlines", "tab\there", "a\u202Eb", "a\u2066b", "a\u200Fb", "a\u2028b", "a\u0085b", "x".repeat(255), 7, null]) {
      await assert.rejects(note(space, { site: "claude.ai", account }), invalid, JSON.stringify(account));
    }
    await assert.rejects(note(space, { site: "claude.ai" }), invalid, "neither account nor restored");
    await assert.rejects(note(space, { site: "claude.ai", restored: false }), invalid, "restored: false is no account");
    await assert.rejects(note(space, { site: "claude.ai", account: "c@example.com", restored: true }), invalid, "both");
    await assert.rejects(note(space, { site: "claude.ai", restored: "yes" }), invalid);
    assert.equal(await listed(space), undefined, "nothing was kept");
    // Normalized as the UI would show it: the host in lower case and ASCII, a slash or https's port dropped.
    // The result names the site as kept.
    for (const [site, kept] of [["Claude.AI", "claude.ai"], ["claude.ai/", "claude.ai"], ["claude.ai:443", "claude.ai"], ["b\u00FCcher.de", "xn--bcher-kva.de"]]) {
      const noted = await note(space, { site, account: "c@example.com" });
      assert.equal(noted.site, kept, site);
      assert.equal(noted.accountsToRestore.at(-1).site, kept, site);
      assert.deepEqual(await note(space, { site, restored: true }), { site: kept, accountsToRestore: noted.accountsToRestore.slice(0, -1) }, `${site}: restored by the same name`);
    }
    // Something invisible inside an account that shows: kept as given.
    const inside = { site: "inside.example", account: "c\u200B@example.com" };
    assert.deepEqual((await note(space, inside)).accountsToRestore.at(-1), inside);
    await note(space, { site: "inside.example", restored: true });
    // At the edges: 254 characters, letters of any script, punycode.
    const long = { site: "claude.ai", account: "x".repeat(254) };
    assert.deepEqual(await note(space, long), { site: "claude.ai", accountsToRestore: [long] });
    const named = { site: "xn--pple-43d.com", account: "Jos\u00E9 \u00C1lvarez" };
    assert.deepEqual((await note(space, named)).accountsToRestore.at(-1), named);
    for (let i = 3; i <= 10; i++) {
      await note(space, { site: `site${i}.example`, account: `user${i}` });
    }
    assert.equal((await listed(space)).length, 10);
    await assert.rejects(note(space, { site: "site11.example", account: "user11" }), e => e.code === "ZEN_INVALID_ARGUMENT" && /at most 10/.test(e.message));
    // At the cap, a site already noted still answers, and nothing changes.
    assert.equal((await note(space, { site: "site3.example", account: "other" })).accountsToRestore.length, 10);
  } finally {
    await h.remove(space);
  }
});

test("only a task the agent drives takes notes: not a claimed Space of the user's, nor a task that ended", async () => {
  const user = await h.userSpace("accounts user space");
  await h.claim(user);
  await assert.rejects(note(user, C), invalid);
  await h.call("spaces.finish", { space: user, keep: "all" }).catch(() => {});
  const space = await h.space("accounts ended");
  await h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" }); return true;`, space);
  await assert.rejects(note(space, C), { code: "ZEN_TASK_SPACE_INACTIVE" });
  await h.remove(space);
});

test("a task that ends with notes left says so: its ending spaceChanged, the finish's receipt and the feed's ended entry", async () => {
  // The user's Stop.
  const stopped = await h.space("accounts stop");
  await note(stopped, C);
  const events = await h.chrome(
    `const seen = [];
     const off = ctx.service.addEventListener((name, params) => {
       if (name === "spaceChanged" && params.space === arg && params.ownership) seen.push(params);
     });
     ctx.spaces.setOwnership(ctx.spaces.get(arg), "user", { source: "user" });
     off();
     return seen;`,
    stopped
  );
  assert.deepEqual(events.map(e => [e.ownership, e.accountsToRestore ?? null]), [["user", [C]]]);
  assert.deepEqual((await entryOf(stopped)).accountsToRestore, [C]);
  assert.equal((await entryOf(stopped)).ended, "stopped");
  // The agent can't take it off any more, and the entry keeps it once the task goes.
  await assert.rejects(note(stopped, { site: "claude.ai", restored: true }), { code: "ZEN_TASK_SPACE_INACTIVE" });
  await h.remove(stopped);
  assert.deepEqual((await entryOf(stopped)).accountsToRestore, [C]);

  // finish() with nothing kept, and with a page kept.
  for (const keep of [[], ["p1"]]) {
    const space = await h.space("accounts finish");
    try {
      await note(space, C);
      const receipt = await h.call("spaces.finish", { space, keep });
      assert.equal(receipt.closedSpace, keep.length === 0);
      assert.deepEqual(receipt.accountsToRestore, [C], JSON.stringify(keep));
      const entry = await entryOf(space);
      assert.equal(entry.ended, "finished");
      assert.deepEqual(entry.accountsToRestore, [C]);
    } finally {
      await h.remove(space);
    }
  }

  // Notes all restored: the end says nothing of accounts.
  const clean = await h.space("accounts clean");
  await note(clean, C);
  await note(clean, { site: "claude.ai", restored: true });
  const receipt = await h.call("spaces.finish", { space: clean, keep: [] });
  assert.equal("accountsToRestore" in receipt, false);
  assert.equal("accountsToRestore" in (await entryOf(clean)), false);
});
