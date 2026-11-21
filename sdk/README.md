# zenius SDK and CLI

The `zenius` command and the Node SDK agents script Zen with. Agents pipe a
script to `zenius nodejs`; it runs with Ego Lite's globals (`taskSpace`,
`listTaskSpaces`, `claimTaskSpace`, `takeOverTaskSpace`, `profiles`, `help`)
and talks to the browser runtime over its Unix socket
(`docs/PROTOCOL.md`). The SDK validates arguments, maps each call to one
runtime request, and prints output the way Ego does; the runtime does the
browser work.

```bash
export PATH=$HOME/opt/node-v24.22.2-linux-x64/bin:$PATH   # Linux
npm install          # esbuild, typescript (dev only)
npm run build        # dist/zenius.mjs + dist/guide.md
bin/zenius nodejs --instance zen-sdk <<'JS'
const task = await taskSpace("demo");
await task.page("p1").goto("https://example.com");
console.log(await task.page("p1").snapshot());
JS
```

In a checkout, `bin/zenius` runs `dist/zenius.mjs` when it is at least as
new as the sources, and the TypeScript sources otherwise (about 10 ms
slower to start). So a fresh checkout works without a build, and a
`git pull` never runs an old bundle: git replaces the files it updates,
which changes their directories' mtimes. An editor that saves in place may
not, so rebuild after editing (`npm test` builds first). Running the sources
needs a Node that strips types (22.18+ or 23.6+, hence `engines`); on an
older one, `bin/zenius` says to build instead. `npm run build` runs on any
Node the CLI supports (22.3 and later): esbuild compiles the TypeScript it
needs, so it imports none.

Agents call the installed copy. `scripts/install-cli.sh` builds the bundle
and copies it, with `bin/zenius`, the Skill and fx-autoconfig's files, to
`~/.zenius/cli`, without the sources. It then links `~/.local/bin/zenius` to
that copy, and with `--skill`, links `~/.claude/skills/zenius` and
`~/.agents/skills/zenius` to the copy's Skill. Since the copy has no sources,
it always runs its bundle: it needs only Node 22.3 or later, and a pull or
an edit in the checkout doesn't change it. Rerun the script to update the
copy. `--uninstall` removes the copy and the links. On the user's Mac the
script runs only when the manager says so.

`zenius doctor` checks a setup against the layout `scripts/install.sh`
writes (SPI.md "Install layout"):

- Zen and its version.
- fx-autoconfig's files beside the app, and its loader in the profile.
- The runtime and its `install.json` against this CLI's version and protocol.
- The instance's registry, socket and hello.
- On the daily profile (instance `default`), I4: no `zenius.dev` pref, no
  `dev.*` methods, no `navigator.webdriver`, no links into a checkout.

It only reads. For anything that needs the user (putting back `config.js`
after a Zen update, installing, restarting Zen), it prints the steps.
`--json` gives the same report for scripts; the exit status is 1 when a check
fails.

| Command | What |
|---|---|
| `npm test` | build, then unit and CLI tests against `test/mock-runtime.ts` (no Zen needed) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:integration` | the same CLI against a fresh headless dev Zen (`sdk-it-<checkout suffix>`); cases whose runtime methods have not landed are skipped |
| `npm run coverage:protocol -- --instance <name>` | which runtime methods the SDK needs that an instance lacks |

## Ego's configuration knobs

The SDK reads Ego's knobs under Ego's names, so that Ego's cases and runners
configure zenius the same way. Agents don't need them, and the usage guide
leaves them out. Each is read at every call, as Ego reads them, so a script
may set them before its first call.

| Knob | Effect |
|---|---|
| `EGO_BROWSER_RESPONSE_TIMEOUT_MS` | Every Page request's `responseTimeout` (ms). |
| `EGO_BROWSER_PAGE_BUDGET` | How many managed Pages a task space may hold, for this process: the top-level `pageBudget` of every request. The runtime applies it in `newPage()` and `adopt()` and shows it in the snapshot header. Ego's default is 8. |
| `globalThis.EGO_BROWSER_OUTPUT_DIR` | An absolute directory for `screenshot()`'s default path, instead of the OS temp directory. |

A value that isn't a positive integer counts as unset, as in Ego.

## Layout

| Path | What |
|---|---|
| `src/cli.ts` | the `zenius` command: `nodejs`, `skill`, `help`, `status` |
| `src/run.ts` | runs a script: async function body, globals in scope, ESM fallback for static imports |
| `src/output.ts` | buffered script output, hard-stop handling, notices |
| `src/rpc.ts` | NDJSON socket client |
| `src/globals.ts`, `src/task-space.ts`, `src/page.ts` | the agent API |
| `src/api-schema.ts` | names, signatures and options: validation, `help()`, alignment tests |
| `src/node.ts` | built-ins loaded with `require()`: ESM facades cost ~15 ms per start |
| `src/protocol-methods.ts` | every runtime method the SDK calls |

Environment: `ZENIUS_INSTANCE` picks the instance, `ZENIUS_SOCKET` overrides
the socket path, `ZENIUS_HOME` overrides `~/.zenius`, `ZENIUS_TIMING=1` (or
`--timing`) prints request timings on stderr.
