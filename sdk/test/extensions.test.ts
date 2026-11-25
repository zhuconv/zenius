// Commands a build adds through src/extensions/ (src/commands.ts). This repo
// ships no extension, so the cases build a copy of the SDK with a fixture
// extension of their own. A build without the folder, as this repo's, has no
// trace of one: no usage line, no command, no import.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { guardHome } from "../../tests/lib/scratch-home.mjs";

const SDK = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const REPO = join(SDK, "..");

const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});
// The copies here run from a new path each time, so Node's compile cache
// for them goes in a folder this file removes, not the CLI's own folder,
// where each run's entries would pile up.
const cacheRoot = mkdtempSync(join(tmpdir(), "zenius-extensions-"));
temporary.push(cacheRoot);
process.env.NODE_COMPILE_CACHE = join(cacheRoot, "compile-cache");

/** A copy of the SDK's sources without any src/extensions, and the skill's guide the build bundles. */
function copySdk(): { work: string; sdk: string } {
  const work = mkdtempSync(join(tmpdir(), "zenius-extensions-"));
  temporary.push(work);
  const sdk = join(work, "sdk");
  const extensions = `${sep}src${sep}extensions`;
  for (const part of ["src", "bin", "build.mjs", "package.json"]) {
    cpSync(join(SDK, part), join(sdk, part), { recursive: true, filter: (path) => !path.includes(extensions) });
  }
  symlinkSync(join(SDK, "node_modules"), join(sdk, "node_modules"));
  mkdirSync(join(work, "skill"));
  cpSync(join(REPO, "skill/guide.md"), join(work, "skill/guide.md"));
  return { work, sdk };
}

function build(sdk: string): string {
  const result = spawnSync(process.execPath, ["build.mjs"], { cwd: sdk, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return readFileSync(join(sdk, "dist/zenius.mjs"), "utf8");
}

function zenius(bin: string, args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: guardHome({ ...process.env, ZENIUS_INSTANCE: "extensions-test" }, "extensions.test") });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const FIXTURE = `import { registerCommand } from "../commands.ts";
import { writeStdout } from "../output.ts";

registerCommand("hello", {
  usage: "  zenius hello <words>           the extensions test's fixture command\\n",
  run: async (rest) => {
    writeStdout(\`hello \${rest.join(" ")}\\n\`);
    return 0;
  },
});
`;

describe("commands a build adds (src/extensions/)", () => {
  it("come from each module there: zenius --help lists the command, and it runs, from the bundle and from the sources", () => {
    const { work, sdk } = copySdk();
    mkdirSync(join(sdk, "src/extensions"));
    writeFileSync(join(sdk, "src/extensions/hello.ts"), FIXTURE);
    const bin = join(sdk, "bin/zenius");

    assert.match(build(sdk), /the extensions test's fixture command/);
    // A bundle missing makes bin/zenius run the sources, which load src/extensions/ themselves.
    for (const from of ["the bundle", "the sources"]) {
      if (from === "the sources") rmSync(join(sdk, "dist"), { recursive: true });
      const help = zenius(bin, ["--help"], work);
      assert.equal(help.code, 0, `${from}: ${help.stderr}`);
      assert.match(help.stdout, /\n {2}zenius hello <words> {11}the extensions test's fixture command\n {2}zenius --version\n/, from);
      const hello = zenius(bin, ["hello", "from", "a", "module"], work);
      assert.deepEqual([hello.code, hello.stdout], [0, "hello from a module\n"], `${from}: ${hello.stderr}`);
    }
  });

  it("leave no trace in a build without src/extensions, as this repo's", () => {
    const { work, sdk } = copySdk();
    assert.doesNotMatch(build(sdk), /zenius remote|remote-bridge/);

    const bin = join(sdk, "bin/zenius");
    const help = zenius(bin, ["--help"], work);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /\(zenius feedback --help\)\n {2}zenius --version\n/);
    assert.doesNotMatch(help.stdout, /zenius remote/);
    const remote = zenius(bin, ["remote", "bridge"], work);
    assert.equal(remote.code, 2);
    assert.match(remote.stderr, /^Unknown command: remote\n/);
  });
});
