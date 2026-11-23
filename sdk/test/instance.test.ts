// Instance names (src/instance.ts): only what the launcher takes, so no name
// leaves the folder it's joined to, and `--instance ../selfcheck/default`
// can't make the agents' socket the self-check's.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { instanceNameRule, listInstanceRecords, readInstanceRecord, selfcheckSocket, socketPath } from "../src/instance.ts";
import { runCli } from "./helpers.ts";

const BAD = ["../selfcheck/default", "a/b", "/abs", "", "a b", "default\u202E"];
const GOOD = ["default", "zen-sdk", "zen-sdk.2", "a_b", ".."];

let home: string;
before(() => {
  home = mkdtempSync(join(tmpdir(), "zin-"));
  mkdirSync(join(home, "instances"));
});
after(() => rmSync(home, { recursive: true, force: true }));

describe("instance names", () => {
  it("socketPath and selfcheckSocket refuse a name the launcher wouldn't take, with ZENIUS_SOCKET set or not", () => {
    const refused = { code: "ZEN_INVALID_ARGUMENT", message: /^an instance name has only letters, digits, '\.', '_' and '-': "/ };
    for (const name of BAD) {
      assert.throws(() => socketPath(name, { ZENIUS_HOME: home }), refused, JSON.stringify(name));
      assert.throws(() => socketPath(name, { ZENIUS_HOME: home, ZENIUS_SOCKET: join(home, "x.sock") }), refused, JSON.stringify(name));
      assert.throws(() => selfcheckSocket(name, { ZENIUS_HOME: home }), refused, JSON.stringify(name));
    }
    for (const name of GOOD) {
      assert.equal(socketPath(name, { ZENIUS_HOME: home }), join(home, "run", `${name}.sock`));
      assert.equal(selfcheckSocket(name, { ZENIUS_HOME: home }), join(home, "selfcheck", `${name}.sock`));
    }
    // The selfcheck socket is never the one ZENIUS_SOCKET names.
    assert.equal(selfcheckSocket("default", { ZENIUS_HOME: home, ZENIUS_SOCKET: join(home, "x.sock") }), join(home, "selfcheck", "default.sock"));
    // A refused name is shown with what could act on the terminal escaped.
    assert.equal(instanceNameRule("default\u202E"), `an instance name has only letters, digits, '.', '_' and '-': "default\\u202e"`);
  });

  it("the registry has no record for such a name, by its file's name or its own", () => {
    writeFileSync(join(home, "instances", "ok.json"), JSON.stringify({ instance: "ok", socket: join(home, "ok.sock") }));
    writeFileSync(join(home, "instances", "liar.json"), JSON.stringify({ instance: "../selfcheck/default" }));
    writeFileSync(join(home, "instances", "a b.json"), JSON.stringify({}));
    const env = { ZENIUS_HOME: home };
    assert.equal(readInstanceRecord("../instances/ok", env), undefined);
    assert.equal(readInstanceRecord("liar", env), undefined);
    assert.equal(readInstanceRecord("ok", env)?.socket, join(home, "ok.sock"));
    assert.deepEqual(
      listInstanceRecords(env).map((record) => record.instance),
      ["ok"],
    );
  });

  it("every command that reaches an instance refuses one before it connects", async () => {
    for (const args of [["nodejs", "-e", "1"], ["status"], ["doctor"], ["mcp"], ["sidebar", "list"], ["selfcheck"]]) {
      const result = await runCli([...args, "--instance", "../selfcheck/default"], { env: { ZENIUS_HOME: home }, timeoutMs: 30_000 });
      assert.equal(result.code, 2, `${args[0]}: ${result.stderr}`);
      assert.equal(result.stderr, `zenius ${args[0]}: an instance name has only letters, digits, '.', '_' and '-': "../selfcheck/default"\n`);
      assert.equal(result.stdout, "");
    }
    const fromEnv = await runCli(["status"], { env: { ZENIUS_HOME: home, ZENIUS_INSTANCE: "a/b" }, timeoutMs: 30_000 });
    assert.equal(fromEnv.code, 2);
    assert.equal(fromEnv.stderr, `zenius status: an instance name has only letters, digits, '.', '_' and '-': "a/b"\n`);
  });
});
