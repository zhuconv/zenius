# Installing zenius into a daily Zen

Step by step, from a release's installer or a checkout of this repository:
zenius's runtime goes into the profile of the Zen someone uses every day, and
the `zenius` command and its Skill go where their agents find them. "The user" below is that person;
you run the steps, for them or for yourself. Run the steps in order. Each
gives the command, what you should see, and when to stop instead of going
on. The commands are for macOS, with Zen in `/Applications/Zen.app`.

Rules that hold throughout:

- Only the user quits and reopens Zen. Never restart or quit it from a
  script.
- Never change `/Applications/Zen.app`.
- Nothing here sends anything of the user's to GitHub or any other
  service. Step 1, or a release's installer, only fetches the code, and the
  packages npm's cache lacks.
- On any output these steps don't describe, stop.

## What changes for the user

Until an agent connects, nothing the user can see:

- **Same windows and session.** The same tabs, workspaces and session come
  back after the restart.
- **No other new controls.** Besides the agent's sidebar and a '>' row in
  the address bar (see "The agent's sidebar", below), zenius adds no
  buttons, panels, menus or toolbar changes.
- **At most one preference.** With `--disable-ipv6`, the install has Zen
  make no IPv6 lookups (`network.dns.disableIPv6`), which can end stalls on
  an IPv4-only network. The cost: a site reachable only over IPv6
  doesn't load in Zen. It's the only preference the install changes, and
  only with that flag. Undo restores its earlier value.
- **One new folder.** The install makes the working folder, `~/zenius-files`
  unless `--working-dir` names another ("The working folder", in step 2).
  Agents' downloads, and the files their scripts write, land there and stay
  until the user deletes them.
- **Hidden task strip.** The strip above the sidebar's foot buttons stays
  hidden while no agent task exists.
- **Prompts and dialogs as before.** Popups, permission prompts, dialogs and
  downloads in the user's own tabs behave as before. zenius handles them
  only in tabs an agent drives.
- **The user's other fx-autoconfig scripts** in `chrome/JS/` aren't
  touched.
- **Startup and memory.**
  - zenius loads only after Zen's first window has started, so that window
    is ready as fast as without it: within 1 ms, under the run-to-run noise.
  - It uses about 4.7 MiB more memory in Zen's main process (2.7 MiB once
    Zen frees memory), and about 0.15 MiB in each tab's process.
  - With no agent connected it runs nothing: no timers, no wakeups, no
    network.

  Measured with Zen 1.24.2b, headless on Linux.

Agents connect through the `zenius` command (step 2). The user's Claude Code
and Codex sessions also get a `zenius` Skill. Where Ego Lite is installed
too, its Skill stays beside zenius's. Step 8, optional, which the user runs
themselves, turns Ego Lite's Skill off for everyday agents, so that they use
zenius for browser work, and its undo turns it back on. Neither the install
nor step 8 changes Ego Lite's app or data.

Agent tabs never get the user's saved passwords:

- Zen fills no saved login into an agent's page, shows no login, address or
  card autofill there, and doesn't offer to save a password typed there.
  Cookies are shared, so sites where the user is logged in stay logged in for
  the agent.
- When an agent needs a login, it hands the tab to the user: "Agent needs
  you · <task>", with Resume agent, and the agent's own words under it:
  "The agent says: “Log in to continue”." The user logs in in that tab,
  where Zen's saved-login popup works as usual for their own click, and
  presses Resume agent.
- Before the agent continues, every password, card number or code typed or
  filled while the user had the tab is cleared from the page. Once the user
  types one, the card says so first: "Resume agent clears password, card
  and code fields, so submit what you type there first."
- The agent's code runs in a sandbox of its own, not in the page, so the
  page keeps none of it. A page its code wrote into loads afresh, quietly,
  at the user's first click or key there, with what the form held carried
  over. If that reload doesn't come, the tab says "This page couldn't
  reload", with Reload, and clicks and typing there stay off until it does.
- A page the agent made itself (not a website) says, when the user goes to
  type there: "The agent made this page", "It might contain malicious code.
  Keep sensitive information out."
- A password manager add-on is another matter: its "fill on page load"
  fills agent tabs too, and a filled field in an agent tab is readable by
  the agent's code. Keep that setting off.

When an agent works:

- **One Space for agents.** Its tabs open in a shared Space, "Agents", which
  appears in Zen's Space switcher with the first task. Every task's tabs are
  there, each task's together.
- **Agent tabs.** Each wears a tag with its task's name and a dot for its
  state, in place of the close button until the pointer is over it.
  - An agent tab the user can't see is muted. If its page plays sound, its
    icon shows a muted badge, and the sound comes back when they open it.
  - In an agent tab the user watches, the agent's cursor shows where it
    acts.
- **The user's view stays put.** Their current Space stays in front, and no
  agent selects a tab or switches a Space. In the Agents Space too, agent
  tabs come and go without moving what the user is looking at.
- **Stepping in.** A click in an agent's page pauses the agent: "Agent
  paused · it resumes in 10 s", with Take over and Resume agent. After
  typing it reads "You're taking over · in 10 s", with Take over now.
  - Take over gives the user the task: "You're in control · the agent
    waits until you resume it · <site>", with Resume agent.
  - An agent that needs the user hands them its tab: "Agent needs you ·
    <task> · <site>", with what it asks in the agent's words and Resume
    agent. The Agents Space's badge and the tasks strip say so too.
  - The site is the one the user is on in that tab, and changes when a
    sign-in moves the page to another site, since compact mode may hide
    the URL bar.
  - A card's small text shows one line; a '?' at its end opens the rest.
- **The tasks strip** above the sidebar's foot buttons counts the tasks. Its
  panel lists each one with its tabs: Open shows a task's tab, Pause or
  Resume holds it, Take over or Resume agent moves it between the user and
  the agent, and Stop stops it. Once the user types a password, card number
  or code in a task's page while it's held or paused, its row says that its
  Resume clears such fields.
- **When a task ends,** its tabs close, except pages the agent kept for the
  user. Those stay in the Agents Space as the user's ordinary tabs.
  - A tab the user is looking at when its task ends stays: "Task finished ·
    <task> · closes when you leave this tab", with Keep tab and Close now.
    Keep tab makes it theirs. A page an agent closes while the user looks at
    it says "Agent closed this page", with the same buttons.
  - Once the Agents Space has no tabs and no window shows it, it goes away.
    A name the user gave it comes back with it next time.
  - After a crash or a force-quit, an Agents Space that had just gone can
    come back. At the next start zenius removes it if it's empty, and uses
    it as the Agents Space again if it holds tabs. Another one that holds
    tabs stays, renamed "Agents (old)", and `zenius doctor` lists it with
    its place in Zen's Space switcher, for the user to look at and remove.
    zenius never touches a Space only because it's named Agents.
  - Sync: if the user signs in to Firefox Sync and turns on Zen's Spaces
    sync (`services.sync.engine.spaces`, off by default), the Agents Space
    reaches their other devices as a plain Space.
- **Pages the task leaves open** (kept at the finish, left by the panel's
  Stop, or given back by the agent) hold none of the agent's code: it ran
  in its sandbox, which ends with the task, so they show nothing.
  - A page the agent's code wrote into keeps an agent tab's limits until
    its document is replaced: no camera, microphone, location,
    notifications, local network, new windows or new site storage (service
    workers, Cache Storage). When the user's own click or key there runs
    into one of them, the page loads afresh, quietly, and their next try
    works. It loads afresh before they type there too.
  - A page the agent made itself can't be cleaned by a reload. When the
    user goes to type there, or something they do there is refused, it says
    "The agent made this page" and why.
- **Back reloads.** In a tab an agent worked in, Back and Forward load
  pages afresh instead of restoring them, both for the pages the tab had
  before the agent took it and for the agent's pages after the task.
- **Closing a task's last tab** stops that task, as Stop in the panel does.
- **After a restart,** tasks come back with their tabs, as the user's own
  tabs do. The tabs stay unloaded until the agent uses them.

What agents can't do:

- **No browser pages, files or add-ons.** Agents can't open the browser's
  own pages (`about:`, `chrome:`), local files or add-on pages, and can't
  read or write files through the browser.
- **No titles of the user's tabs.** Listing Spaces shows an agent no tab
  titles of the user's own Spaces.
- **No notifications or silent permissions.** Notifications from agent pages
  never show. A passkey request, or a prompt for storage access (an embedded
  sign-in frame's) or the local network, hands the task to the user, at most
  once per site unless answered: the tab says "Agent paused · page asks …"
  and what for. Every other permission request (the location, camera,
  microphone, notifications, MIDI, persistent storage and the rest) is
  refused at once, with no prompt, even while the user holds the task.
- **Capped downloads.** A task's downloads are capped at 50 files and 1 GiB.
  Each finished one moves into the working folder, under a name no file
  there has yet, and stays there after the task ends.
- **No hidden video.** Video in an agent tab the user can't see pauses until
  they look.
- **No code planted for later.** Agent tabs can't register service workers
  or write to Cache Storage, so an agent can't leave code that later runs in
  the user's own tabs.
  - Data is another matter: code an agent runs on a site can leave data
    there, and a site that later runs stored data as code would run it in
    the user's tabs.
- **No local network.** Agent pages can't reach private addresses (10.x,
  172.16–31.x, 192.168.x, link-local) or `.local` names, and can't use
  WebRTC. On macOS 15 the first reach into the local network asks the user,
  for all of Zen. Loopback (`localhost`, `127.0.0.1`) stays open, for dev
  servers.
  - A load the user starts there themselves, in an agent's tab, isn't
    opened either. The tab says "Network access denied · <host>", and "The
    current network policy doesn't allow agents to access <host>." Its '?'
    says the address is on the local network, and what the buttons do:
    - **Open it yourself**, the main button, opens it in a new tab of the
      user's own Space, where no agent is: the address they typed, or that
      site's home page if the page chose the address.
    - **Add to allowlist**, only for an address the user typed, adds that
      exact host to the allowlist (see "Later, if needed") and loads it in
      the agent's tab, which every agent tab may then reach. zenius writes
      the allowlist only on the user's own click of this button. Removing
      an entry stays in about:config. An address a page chose gets no such
      button, so a page can't steer the user into listing its target.
  - In a page the agent's code wrote into, after the task, such a load
    makes the page load afresh, quietly, as other refusals there do.
  - The allowlist starts empty, so agent tabs refuse every private address
    until the user adds one. For web pages on a private network, see "Later,
    if needed".
- **On Linux only:** an agent's text selection reaches the selection
  clipboard (PRIMARY), as any selection in Firefox does. The user can turn
  `clipboard.autocopy` off in `about:config`. The Mac has no PRIMARY.
- **The user's say.** An agent that asks to work in one of the user's
  Spaces, or in a task that ended, waits for their answer to a prompt in
  their window: "Agent request · denied in <time>", "An agent asks to work
  in your Space “<name>”. It calls itself “<client>”.", with Allow and Deny.
  No answer denies it. It can't take back a task the user clicked or typed
  in during the last 10 s.

### The agent's sidebar

zenius puts its agent sidebar in place of the profile's own, if it has one,
and adds a '>' row to the address bar. `docs/agent-sidebar.md` has the
details.

- **A sidebar the profile had is kept.** The install backs up the
  profile's `agent-sidebar.uc.js` and `agent-sidebar/`, if it has them, and
  Undo puts them back exactly. The sidebar's settings (`uc.agent-sidebar.*`)
  and the user's other scripts stay as they are. zenius writes nothing into
  `~/.claude` or `~/.codex`.
- **Its agents** are the user's own Claude Code and Codex. A `config.json`
  in `~/Library/Application Support/zenius-agent-sidebar/` names them, and
  wins; the sidebar only reads it. Without one, the sidebar uses adapters in
  `~/.zenius/agents`, which only the one-command installer in the README
  puts there: this guide installs none.
- **Chat and Work.** Chat is one conversation per tab, about its page. Work
  binds a chat to a zenius task instead of a tab. The agent works in a task
  of its own in the Agents Space, and the chat follows that task's tabs and
  hand-offs. The address bar's '>' row and `+ New task` start one. The
  directory beside the sidebar lists the tasks: Needs you, Working, Done.
- **The sidebar's agents get the browser and nothing else.** A Chat session
  answers from the page's text, and from zenius's own docs, such as what an
  error means. A Work session's tools are zenius's browser
  tools and Claude Code's ToolSearch. Both can search the web and fetch
  pages without a tab. No shell, no files. Codex runs within these limits:
  read-only, no shell, no writes, no network outside zenius and its hosted
  web search, sub-agents off, and every approval it asks for refused. One
  read path is left: apply_patch's check can tell Codex whether a file
  exists, or whether it holds a given line, though not what the file says.
  Setting `zenius.agentSidebar.allowCodex` to false in `about:config` turns
  Codex off, with no restart.
- **Live card, Watch and Take over.** At the end of a Work chat, a picture
  of the page its agent is on, drawn only while the user can see it. Watch,
  like every way to a task, shows the task's tab, and ⌃Tab returns to where
  the user was. Take over gives the user the task, as the tasks panel does.
- **Agents' page code is the user's setting.** By default it runs as
  before. With `zenius.agentTabs.pageCode` set to `ask`, an agent's code
  waits on each site the user hasn't allowed, and the agent's tab asks
  "Allow the agent's code on <site>?", with Allow on this site and Not
  now. `never` refuses it everywhere. See "Later, if needed".

## Before you start

These checks change nothing:

```bash
node --version                                  # v22.3 or later
/opt/homebrew/opt/node@24/bin/node --version    # v24.x
ls /Applications/Zen.app/Contents/Resources/config.js
P=~/Library/"Application Support"/zen/Profiles/"<profile>"
ls "$P"/chrome/utils/boot.sys.mjs
grep -n "inSafeMode" "$P"/chrome/utils/boot.sys.mjs
```

`<profile>` is the folder of the profile Zen opens, which `about:support`
shows as its Profile Folder.

Two Nodes:

- **The PATH's Node** is the one the user's agents run `zenius` with. The
  installed CLI needs 22.3 or later (checked on 22.3.0 and 23.5).
- **Homebrew's Node 24** builds the CLI in steps 1 and 2.

The `grep` should print a line with `!Services.appinfo.inSafeMode`, as in
the copy zenius tests with
(`runtime/vendor/fx-autoconfig/profile/chrome/utils/boot.sys.mjs`, line
671): `const _ucjs = !Services.appinfo.inSafeMode && new UserChrome_js();`.
fx-autoconfig then loads no scripts in Troubleshoot Mode, which "If Zen
won't start" relies on.

Stop if:

- the PATH's Node is older than v22.3, or Homebrew's Node 24 is missing;
- either file is missing. Without `config.js` in Zen.app or the profile's
  `chrome/utils/boot.sys.mjs`, fx-autoconfig isn't there, and zenius can't
  load. Restoring them changes Zen.app or the profile's loader, so it's the
  user's call: fx-autoconfig's files are in `runtime/vendor/fx-autoconfig/`;
- the `grep` prints nothing. Then Troubleshoot Mode may still load zenius,
  and "If Zen won't start" can't count on it.

Pick the commit to install, written `<commit>` below: a release's tag, such
as `v0.1.0`, or a newer commit of `main`.

## From a release, in place of steps 1 to 4

Each zenius release on GitHub has its own installer, its `install.sh` asset.
It does steps 1, 2 and 4 in one command, from the release's package instead
of a checkout: nothing to clone or build. Take this path or steps 1 to 4, not
both. Steps 5 to 7 are the same either way.

What the installer does, in order:

1. It checks what it needs: `curl`, `tar`, Node 22.3 or later on the PATH,
   and Zen's app.
2. It downloads the release's package, and stops unless the package's
   SHA-256 is the one the installer carries.
3. It runs the package's `install-cli.sh --dry-run`, then its `install.sh
   --dry-run --loader`, with the choices below. A choice that can't work (the
   sandbox without Node 24, a folder it won't take, a file in the way) stops
   it there, with the reason and `nothing has changed`.
4. It unpacks the package into `~/.zenius/release`, which Undo and doctor's
   fixes run from.
5. `scripts/install.sh --loader` puts the runtime into the profile Zen opens,
   as step 4 does. `--loader` adds fx-autoconfig's loader to a profile that
   lacks it, and leaves one that's there as it is. `--profile <folder>`, given
   to the installer, picks another profile.
6. `scripts/install-cli.sh --skill` installs the `zenius` command and its
   Skill, as step 2 does.
7. npm adds the sidebar's built-in agents to `~/.zenius/agents`: the ACP
   adapters for Claude Code and Codex, at the versions in the release's lock,
   with no install scripts. A first install skips them when a `config.json`
   in `~/Library/Application Support/zenius-agent-sidebar/` names the
   sidebar's agents, since those win. Adapters already there are kept up to
   date.

It never quits, starts or restarts Zen, and never changes Zen's app.

The choices are made at the first install, and an update keeps them:

- `--sandbox`: the sandboxed CLI ("The sandboxed CLI", in step 2). It runs on
  Node 24, so the line below puts Homebrew's first on the PATH.
- `--read-dir <folder>`, with `--sandbox`: one more folder scripts may read,
  such as `~/Downloads` for uploads.
- `--working-dir <folder>`: the working folder, where agents' downloads and
  their scripts' files land; `~/zenius-files` by default ("The working
  folder", in step 2).
- `--disable-ipv6`: Zen makes no IPv6 lookups ("The one pref", in step 4).

A first install, with three of the choices. `<install.sh URL>` is the
address of the release's `install.sh` asset, on the release's page; the
README's install line has the latest release's.

```bash
curl -fsSL <install.sh URL> | PATH=/opt/homebrew/opt/node@24/bin:$PATH bash -s -- --sandbox --read-dir ~/Downloads --disable-ipv6
```

Expect, with `<version>` the release's version and `<commit>` its commit:

```
zen(ius): downloading zen(ius) <version>
zen(ius): SHA-256 matches: <the release's SHA-256>
zen(ius): unpacked into /Users/<user>/.zenius/release
Installing zenius <version> (protocol 1, commit <commit>) into /Users/<user>/Library/Application Support/zen/Profiles/<profile>
  profile chosen by: /Users/<user>/Library/Application Support/zen/profiles.ini, the Default= of its [Install…] section (the profile Zen opens)
  no running Zen has this profile open
  no zenius files to back up: the profile has none yet
  the profile has fx-autoconfig's loader already: --loader leaves it as it is
  wrote <n> files in the profile (listed in /Users/<user>/.zenius/install.json)
  set the working folder: /Users/<user>/zenius-files, in /Users/<user>/.zenius/config.json
  made /Users/<user>/zenius-files, readable only by you
  set network.dns.disableIPv6 to true in user.js (no IPv6 lookups in Zen); uninstall restores its previous value
Done. The next time Zen starts, it will load zenius <version>.
installed /Users/<user>/.zenius/cli: zenius <version>, commit <commit>
ok       the working folder: /Users/<user>/zenius-files
wrote    /Users/<user>/.local/bin/zenius: the sandboxed launcher
linked   /Users/<user>/.claude/skills/zenius -> /Users/<user>/.zenius/cli/skill/zenius
linked   /Users/<user>/.agents/skills/zenius -> /Users/<user>/.zenius/cli/skill/zenius
check    zenius <version> (protocol 1, sandboxed)
zen(ius): installing the sidebar's agents (the ACP adapters for Claude Code and Codex) into /Users/<user>/.zenius/agents

added <n> packages in <n>s

zen(ius): zen(ius) <version> is installed. Open Zen (quit and reopen it if it's running), then run: zenius doctor
```

Step 4 explains the profile's lines, and step 2 the CLI's. With Zen open,
the profile's `Done.` line says so: a first install goes ahead, and Zen
loads zenius when it next starts (step 5).

How it ends:

- **Exit 0:** installed.
- **Exit 1:** stopped, with the reason. After `nothing has changed`, fix the
  reason and run it again. A later stop says what's left, and running it
  again is safe.
- **Exit 2:** a wrong argument. Nothing has changed.
- **Exit 3:** installed, but Zen's app lacks fx-autoconfig's two files, as
  after a Zen update. It prints the commands that copy them. They change
  Zen's app, so only the user runs them, before step 5.

No output at all means the download failed.

With `--sandbox`, also write the Codex rule ("Codex: a rule for the sandboxed
CLI", in step 2) if the user's agents include Codex. Then go on with step 5.

**Updating** to a newer release: stop every other Zen and ask the user to
quit Zen, as in "Updating later" step 3. With zenius installed,
`install.sh` won't run while Zen has the profile open. Then run the newer
release's line without the choices:

```bash
curl -fsSL <the newer release's install.sh URL> | PATH=/opt/homebrew/opt/node@24/bin:$PATH bash -s
```

Expect the lines above, with these changes:

- `backed up the zenius files it replaces to …` replaces `no zenius files to
  back up`.
- The IPv6 line reads `network.dns.disableIPv6 stays true in user.js, from an
  earlier install with --disable-ipv6; …`.
- `  the working folder stays /Users/<user>/zenius-files (…)` replaces the
  `set the working folder` and `made` lines.
- With the sandboxed CLI, `note     … is the sandboxed launcher, and this
  install keeps it …` comes first, and `ok` replaces `wrote` and `linked`.
- From a release before the working folder, the profile's part sets it as a
  first install does. With the sandboxed CLI, `note     scripts now write in
  the working folder, …, not in runs' output folders: …/.zenius/out keeps
  earlier runs' files, which zenius no longer uses` follows the first
  `note`, once. The user can delete that folder when they don't need those
  files.

Then steps 5 and 6.

**Undo**, with the user's Zen closed:

```bash
curl -fsSL <install.sh URL> | bash -s -- --uninstall
```

It runs "Undo"'s steps 2 and 3 from `~/.zenius/release`, then removes
`~/.zenius/agents` and `~/.zenius/release`. The rest of "Undo" holds as it
is: the Codex rule, Ego Lite's Skill, and what stays behind.

## 1. Get the code

Use a checkout that only the daily install uses, so nothing in progress
elsewhere ends up in the user's Zen.

```bash
[[ -d ~/zenius-daily ]] || git clone <zenius's git URL> ~/zenius-daily
cd ~/zenius-daily
git fetch -q origin
git checkout -q --detach <commit>
git log --oneline -1               # shows <commit>
git status --short                 # prints nothing
(cd sdk && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci --prefer-offline --no-audit --no-fund)
```

`npm ci` installs the SDK's build tools (about 36 MB), which
`install-cli.sh` needs to build the CLI bundle. The bundle isn't in git.
Both run with Homebrew's Node 24 in front of the PATH, for these commands
only.

npm 11 may end with an `npm warn install-scripts` block saying that
esbuild's postinstall, `esbuild@<version> (postinstall: node install.js)`,
isn't covered by allowScripts. That's fine: step 2's build works without that
script. Leave allowScripts as it is: don't run the `npm install-scripts
approve` the block suggests, which would write to `sdk/package.json`.

Stop if `git status` prints anything, or `npm ci` fails.

## 2. Install the CLI and its Skill

There are two ways: the plain CLI, next, or the sandboxed one, under "The
sandboxed CLI" below, which runs every agent's `zenius` command in a
sandbox. Pick one, and run its dry run and install. The Codex rule at the
end of this step goes only with the sandboxed CLI. The notes on the Skill
links and the PATH apply to both.

First the dry run, again with Node 24 in front:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH scripts/install-cli.sh --skill --dry-run
```

Expect these lines, and no others (with `/Users/<user>` for `~`):

```
would build sdk/dist/zenius.mjs
would install ~/.zenius/cli: zenius <version>, commit <commit>
would set the working folder: ~/zenius-files (~/.zenius/config.json)
would make ~/zenius-files, the working folder, readable only by you
would link ~/.local/bin/zenius -> ~/.zenius/cli/sdk/bin/zenius
would link ~/.claude/skills/zenius -> ~/.zenius/cli/skill/zenius
would link ~/.agents/skills/zenius -> ~/.zenius/cli/skill/zenius
```

Three other lines are fine:

- `ok …`: a link already points at the copy, or the working folder is set
  already.
- `note … is not on PATH`: agents won't find `zenius` by name (see below).
- `note a running Zen keeps the working folder it started with, …`:
  `--working-dir` changes the folder ("The working folder", below).

Stop if it names anything else, or prints a `skip … left alone` line. That
means a file, folder or link there isn't zenius's. The script won't touch
it, and the user decides what to do with it.

Then install, and check the CLI with the PATH's Node, as agents will run
it:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH scripts/install-cli.sh --skill
command -v zenius                  # ~/.local/bin/zenius
zenius --version                   # zenius <version> (protocol 1)
for s in ~/.claude/skills/zenius/SKILL.md ~/.agents/skills/zenius/SKILL.md; do
  echo "$(head -1 "$s") $(sed -n '2,/^---$/p' "$s" | grep -cE '^(name: zenius|description: .+)$') $s"
done
```

The install prints the dry run's lines as done (`built`, `installed`,
`set`, `made`, `linked`), and its last line is `check    zenius <version>
(protocol 1)`.
The loop should print `--- 2` and the path for each link. Claude Code reads
`~/.claude/skills/<name>/SKILL.md` and Codex reads `~/.agents/skills`, both
through links (checked with Claude Code 2.1.329 and Codex 0.169.0;
`references/install.md`). Codex skips a Skill whose `SKILL.md` lacks the
frontmatter or its `description` without saying so. Stop if either line
differs.

Codex runs each command in a sandbox of its own, which blocks Zen's socket
by default: a zenius command there fails as `blocked`, and the agent asks to
run it outside Codex's sandbox. With the sandboxed CLI, a Codex rule sets
that up: see "Codex: a rule for the sandboxed CLI", below.

If `command -v zenius` prints nothing (or the dry run printed the `not on
PATH` note), `~/.local/bin` isn't on the PATH. Use `~/.local/bin/zenius` in
the steps below, and add `~/.local/bin` to the PATH: the user's agents
need it there.

### The working folder

Each install sets the working folder: where an agent's finished downloads
land, and where a script's file goes when it names a relative path. It's
`~/zenius-files` unless `--working-dir <absolute folder>` names another, with
either CLI, `install.sh` and the release's installer alike. The install
writes it in `~/.zenius/config.json`, which Zen reads at each start and the
`zenius` command at each run, and makes the folder, readable only by the
user, if it's missing. Later installs keep it: pass `--working-dir` again
only to change it.

- The installers store the folder resolved, as the `zenius` command spells
  the paths it returns: one slash between parts, no `.` part, and no slash
  at the end, so `--working-dir ~/work//files/` stores `~/work/files`. A
  folder an earlier install stored another way is stored again so, at the
  next install. It's the same folder.
- Name the folder without a `..` part. After a link, `..` leads to the
  link's target's parent, not back where the name seems to go, so the
  installers refuse one, given or in `config.json`, and so do Zen and the
  `zenius` command.
- Changing it moves no files: the earlier folder keeps its own. A Zen
  that's running keeps the folder it started with, so its downloads land
  there until you quit and reopen it, while the `zenius` command takes the
  new one at its next run. `install-cli.sh` says so when it changes the
  folder.
- Undo leaves the folder, its files and `config.json` as they are.
- The installers refuse a folder an agent's scripts mustn't write, with the
  reason, and change nothing: the home folder, a temporary folder or a
  folder above one; one that holds or is inside `~/.zenius`, Zen's profiles
  or app, `~/.config`, `~/.local`, `~/Library`, the CLI's copy, Node's
  folder, or `~/.ssh` or another credentials folder; and a project's folder,
  one that holds `.git` or `.envrc` or sits in a git work tree.
- A folder inside a temporary folder, such as `/tmp/zenius-files`, is
  allowed, but the system may empty it: keep files that matter elsewhere.
- A `config.json` edited by hand must name the folder as the installer
  writes it, on a line of its own, with no `..` part. Otherwise Zen, the
  `zenius` command and the installers stop with the reason, and never fall
  back to `~/zenius-files`. `--working-dir` writes it again.
- zenius's own folder is `~/.zenius`. When `ZENIUS_HOME` moves it elsewhere,
  there's no default working folder: pass `--working-dir` too, or each
  installer stops with `there's no default working folder: …` and makes
  nothing.
- Not checked on the Mac yet: a working folder inside `~/Documents` or
  `~/Downloads`, or on another volume. macOS guards those places, and may
  ask whether Zen, and the app your agent runs in, can use the folder. The
  default, `~/zenius-files`, is in none of them.

### The sandboxed CLI

Run this install instead of the plain one above.

`--sandbox` makes `~/.local/bin/zenius` a launcher, a file instead of a link,
so every `zenius` command an agent runs is sandboxed: `sandbox-exec` with the
profile in `~/.zenius/cli/sdk/sandbox/zenius.sb`, and Node's permission model
inside it. Agents then run Homebrew's Node 24,
`/opt/homebrew/opt/node@24/bin/node`, not the PATH's Node.

A script that `zenius nodejs` runs can then:

- read, write and delete files in the working folder ("The working
  folder", above). A relative path given to `screenshot()` or `saveAs()`
  lands there, and the script's output lists each such file under
  `[zenius:files]`;
- read the folder it starts in, but write nowhere in it. git, direnv, npm,
  pytest, make and agents run what a project holds (hooks, `.envrc`,
  `.venv/bin`, `conftest.py`), outside the sandbox;
- read the folder `--read-dir` names, such as `~/Downloads` for uploads,
  but write nothing there. An upload of a link in it to a file outside it
  is refused, as in the other folders;
- read and write a temporary folder of its own run;
- read the CLI copy and the instance registry, and connect to the
  instance's socket.

It can't:

- read any other file, or write anywhere else;
- start programs or signal other processes;
- reach the network or any other socket, such as ssh-agent's or Docker's;
- see environment variables beyond a short list (no `NODE_OPTIONS`, no
  tokens).

The folder a script starts in isn't granted when it is `$HOME`, a temp
folder or above one, or when it holds or sits inside `~/.zenius`, Zen's
profiles, `~/.config`, `~/.local`, `~/Library`, Node 24's folder or a
credentials folder such as `~/.ssh`. The script then starts in the working
folder. A working folder that breaks the same rules, as after a hand edit
of `config.json`, stops every `zenius` command with the reason. The browser
adds nothing to what a script can reach (I5).

Checked on the Mac:

- The canary, `tests/security/run.sh sandbox`, passes on Homebrew's
  node@24, with ssh-agent and other sockets probed. Every reach it probes
  fails for a script: planted `.git/hooks`, `core.fsmonitor` and
  `.venv/bin/git` all fail to write. A pilot's work still works: goto, a
  snapshot, an upload from the folder it starts in, a screenshot to the
  working folder. Each run also gets a temporary folder of its own.
- In Claude Code 2.1.329, nothing gets past an allow rule `Bash(zenius:*)`:
  variables in front, chaining and heredoc tails were all denied. Still,
  never approve by hand a `zenius` command that starts with a variable: the
  variable acts before the sandbox does.
- Each command takes about 20 ms more: from about 35 to 55 ms on the Mac,
  and 40 ms more on Linux.

First the dry run, with Node 24 in front:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH scripts/install-cli.sh --skill --sandbox --read-dir ~/Downloads --dry-run
```

`--read-dir ~/Downloads` lets scripts read the Downloads folder, for
uploads: leave it out of both commands if they needn't, or name another
folder. An older commit's `install-cli.sh` may not know it, and stops with
`unknown argument`. macOS may ask once whether your terminal app can read
Downloads. That's macOS's own guard on the folder: allowing it lets uploads
from there work.

Expect these lines (with `/Users/<user>` for `~`). The dry run changes
nothing.

```
would build sdk/dist/zenius.mjs
would install ~/.zenius/cli: zenius <version>, commit <commit>
would set the working folder: ~/zenius-files (~/.zenius/config.json)
would make ~/zenius-files, the working folder, readable only by you
would write ~/.local/bin/zenius: the sandboxed launcher
    #!/bin/sh -p
    # zenius, sandboxed (zenius-sandbox-launcher 1). scripts/install-cli.sh
    … the rest of the launcher, indented
would install ~/.zenius/cli/sdk/sandbox/zenius.sb, the launcher's sandbox-exec profile:
    (version 1)
    … the rest of the profile, indented
would link ~/.claude/skills/zenius -> ~/.zenius/cli/skill/zenius
would link ~/.agents/skills/zenius -> ~/.zenius/cli/skill/zenius
```

The printed launcher names this Mac's paths in these lines:

```
    CLI='/Users/<user>/.zenius/cli'
    ZHOME='/Users/<user>/.zenius'
    NODE='/opt/homebrew/opt/node@24/bin/node'
    NODE_MAJOR=24
    BIN_DIR='/Users/<user>/.local/bin'
    READ_DIR='/Users/<user>/Downloads'
    case macos in
```

These lines are fine too:

- `ok …`: a Skill link already points at the copy, or the working folder is
  set already.
- `would write ~/.local/bin/zenius: the sandboxed launcher (was a link to
  ~/.zenius/cli/sdk/bin/zenius)`: a plain install was there before.
- `note … is not on PATH`, as above.

Stop on any other line. After an `error    --sandbox: …` line, the install
has changed nothing, and the line says what's missing.

For a working folder other than `~/zenius-files`, add `--working-dir
<absolute folder>` to both commands ("The working folder", above).

Then install and check:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH scripts/install-cli.sh --skill --sandbox --read-dir ~/Downloads
command -v zenius                  # ~/.local/bin/zenius
zenius --version                   # zenius <version> (protocol 1, sandboxed)
```

The install's last line is `check    zenius <version> (protocol 1,
sandboxed)`. Check the two Skill links with the loop above. Stop if
`zenius --version` doesn't end in `sandboxed`.

With the sandbox, later steps change:

- **Step 6.** In the sandbox, `zenius doctor` can't read Zen's files. It
  checks the CLI, the instance, and the I4 items the runtime reports (no
  `dev.*` methods, `navigator.webdriver` false). Its `DNS` line reads
  `network.dns.disableIPv6: true (no IPv6 lookups in Zen)`: it can't read
  `user.js` to say who set it. It marks the five other
  checks `--`, ends with `zenius works from the sandbox. The checks marked
  -- need doctor outside it.`, and exits 0. Expect that. Then run the
  command it prints, which works outside the sandbox, with Node 24 in front
  as above, for the full check step 6 describes:

  ```bash
  PATH=/opt/homebrew/opt/node@24/bin:$PATH node ~/.zenius/cli/sdk/bin/zenius doctor
  ```

- **Step 7** runs as written.
- **Updating later.** `scripts/install-cli.sh --skill` keeps the sandbox,
  with its `--read-dir`, and the working folder. Its first line is
  `note     ~/.local/bin/zenius is the sandboxed launcher, and this install
  keeps it (--no-sandbox makes it a link again)`.
- **Homebrew upgrades.** `brew upgrade node@24` leaves zenius working: the
  launcher follows `/opt/homebrew/opt/node@24` at each start. If that path
  goes away, or stops being Node 24, every `zenius` command fails with
  `zenius (sandboxed): … reinstall with scripts/install-cli.sh --sandbox`.
  Then rerun this install.

To undo the sandbox:

- **Back to the plain CLI:** `PATH=/opt/homebrew/opt/node@24/bin:$PATH
  scripts/install-cli.sh --skill --no-sandbox`. It prints
  `updated  ~/.local/bin/zenius -> ~/.zenius/cli/sdk/bin/zenius (was the
  sandboxed launcher)`.
- **Everything:** "Undo" step 3, `scripts/install-cli.sh --uninstall`, also
  removes the launcher. It prints `removed  ~/.local/bin/zenius (the
  sandboxed launcher)`.

Either way, `$TMPDIR/zenius-sandbox-<uid>/` stays behind. It holds each
run's temporary folder, with screenshots taken without a path. Delete it by
hand. The working folder stays, with its files.

### Codex: a rule for the sandboxed CLI

Codex runs each command in a sandbox of its own. Its default,
`workspace-write` with network access off, blocks Zen's socket. On the Mac
no sandbox can start inside Codex's, so the sandboxed launcher stops there
and says so, whatever Codex's network setting (checked with Codex 0.169.0's
`codex sandbox` on Linux and the Mac, `tests/security/codex-sandbox.sh`).
Without a setup, an agent asks to run the
zenius command outside Codex's sandbox (`require_escalated`), as
`references/install.md` tells it.

A Codex rule sets that up: each `zenius` command then runs outside Codex's
sandbox without asking, and zenius's own sandbox applies to it. The rule is
a file in `~/.codex`: give the user the lines below, and let them make the
change. Nothing is applied without them. `command codex` below skips any
shell function or alias named `codex`. `/Users/<user>` stands for their
home folder, since Codex wants absolute paths.

Write the rule only once `zenius --version` ends in `sandboxed`. With the
plain CLI, it would give every agent script the user's own access. The user
writes `~/.codex/rules/zenius.rules`:

```
# zenius commands run outside Codex's sandbox without asking. Only the
# sandboxed launcher counts, so zenius's own sandbox applies to them.
host_executable(name = "zenius", paths = ["/Users/<user>/.local/bin/zenius"])
prefix_rule(pattern = ["zenius"], decision = "allow")
```

Check it:

```bash
command codex execpolicy check --resolve-host-executables \
  --rules ~/.codex/rules/zenius.rules -- zenius doctor
```

It prints `"decision":"allow"`.

- Checked with `codex execpolicy check` (Codex
  0.169.0). `zenius --version`, `zenius doctor`, `zenius nodejs -e '…'` and
  `/Users/<user>/.local/bin/zenius …` match it. `./zenius` and any other path
  don't.
- Codex keeps an approved escalation's prefix as a rule like this one. Its
  tool text reads "Reusable approval prefix for `cmd`, only with
  `sandbox_permissions: "require_escalated"`". So what the rule matches runs
  outside Codex's sandbox.
- Not checked, since it takes a model run: whether Codex also matches a
  heredoc (`zenius nodejs <<'JS'`), or a zenius command inside a longer
  shell line. If Codex asks about those, the user approves them; they run in
  zenius's own sandbox too.

If the user's Codex config turns network access on already
(`[sandbox_workspace_write] network_access = true`), that's their setting:
leave it. zenius doesn't need it.

Other setups: the plain CLI with Codex's experimental network
proxy open only to Zen's socket, which then carries every Codex command's
network; or no change, with the user approving each zenius command when
Codex asks.

## 3. See what the runtime install would do

```bash
scripts/install.sh --dry-run --disable-ipv6
```

`--disable-ipv6` is optional (see "The one pref" in step 4): to leave IPv6
as it is, leave it out of every install command below, and line 7 then has
no `would set` part.

Expect, in this order:

1. `Installing zenius <version> (protocol <n>, commit <commit>) into
   /Users/<user>/Library/Application Support/zen/Profiles/<profile>`
2. `profile chosen by: …/zen/profiles.ini, the Default= of its [Install…]
   section (the profile Zen opens)`
3. `Zen (pid …) has this profile open: the change takes effect when the user
   quits and reopens it`. If Zen isn't running: `no running Zen has this
   profile open`.
4. `would write these <n> files in the profile, and change nothing else
   there but one pref (below):`, then the list. Each path starts with `chrome/JS/zenius.uc.js` or
   `chrome/JS/zenius/`.
5. `would record the install in /Users/<user>/.zenius/install.json`
6. `no zenius files to back up: the profile has none yet`; then, if the
   profile has a `user.js`, `would run: …` lines and `would back up user.js
   to /Users/<user>/.zenius/backups/<UTC time>`
7. `would run: …` lines, then `would set network.dns.disableIPv6 to true in
   user.js (no IPv6 lookups in Zen, the user's choice); uninstall restores
   its current value`, then `(dry run: nothing changed)`.

Stop if:

- the profile isn't `<profile>`, the one the user's Zen opens;
- any listed path lies outside `chrome/JS/zenius.uc.js` and
  `chrome/JS/zenius/`;
- a line starts with `Warning:` or `install.sh:`.

## 4. Install the runtime

```bash
scripts/install.sh --disable-ipv6
```

Expect step 3's lines 1, 2, 3 and 6, with `backed up user.js to
/Users/<user>/.zenius/backups/<UTC time>` for 6's second part; the others
come only with `--dry-run`. Then `wrote <n> files in the profile (listed in
/Users/<user>/.zenius/install.json)`, `set network.dns.disableIPv6 to true
in user.js (no IPv6 lookups in Zen); uninstall restores its previous
value`, and, with Zen running: `Done. Zen is running: quit it and reopen it
to load zenius <version>.` If another Zen from the app is running, a dev
Zen for example, `Warning: another Zen from the same app is running. …`
follows, with each one's pid and profile. A dev Zen's line says how to stop
it (`scripts/zen-dev.sh <name> stop`): stop those before step 5. Any other
is the user's own Zen, which only the user quits.

The running Zen doesn't change. Zen reads its scripts only when it starts.

**The one pref.** With `--disable-ipv6`, the install sets
`network.dns.disableIPv6` to true in the profile's `user.js`: Zen then
makes no IPv6 lookups, which can end stalls on an IPv4-only network.
The cost: sites reachable only over IPv6 don't load in Zen. It takes effect
when Zen restarts (step 5). The install records the pref's value before it,
and Undo puts that back. Without the flag, the install leaves `user.js` as
it is; some older commits set the pref without being asked.

## 5. The user quits and reopens Zen

First stop every dev Zen that runs from `/Applications/Zen.app`
(`scripts/zen-dev.sh <name> stop`). While one runs, even a headless one,
opening Zen from the Dock only brings that one forward, and the daily Zen
doesn't open. Any other Zen from the app is the user's own, and only the
user quits it. Then check that only the daily Zen is left; the others are
the ones started with `-profile`:

```bash
pgrep -lf '/Applications/Zen.app/Contents/MacOS/zen .*-profile' || echo "no dev Zen"
```

Expect `no dev Zen`.

Ask the user first: it interrupts their work. Don't go on until they say
it's done.
The user quits Zen (⌘Q) and opens it again from the Dock or Applications.
Zen restores the session as usual.

## 6. Check the install

```bash
zenius doctor
```

Expect every check to pass and exit status 0:

- the instance is `default`;
- the runtime's version and commit match step 4;
- the I4 checks pass: `daily-driver (I4)` reads `no zenius.dev pref, no
  links into a checkout, no dev.* methods, navigator.webdriver false`;
- the I5 check passes, without opening a tab: `agent boundary (I5)` reads
  `agents load only http:, https:, data:, blob: and about:blank; page gate
  on; self-tests refused about:config, file:/// and a browser document`. A
  runtime from an older commit doesn't report this, and fails;
- with `--disable-ipv6`, `DNS` reads `network.dns.disableIPv6: true, set
  by install.sh at the user's request (no IPv6 lookups in Zen)`.

On a failure, stop: the failing line says what's wrong, and `zenius doctor
--json` has the details.

A `warn` isn't a failure. On the `instance` line, `An earlier Agents Space,
"Agents (old)", the <k>th Space in Zen's switcher, is still in Zen with <n>
tabs: …` means a crash or a force-quit left a Space zenius once used (see
"What changes for the user"). Doctor still exits 0, and ends with
`1 warning.` instead of its usual last line, in the sandbox too. Tell the
user which Space it is: its name and its place in the Space switcher. It's
theirs to look at and remove in Zen, and zenius never removes it. The
warning goes once it's removed.

On the `DNS` line, `network.dns.disableIPv6: false, so Zen looks up IPv6
addresses` means someone turned it off in `about:config` since the restart.
Ask the user whether they did; it's their choice. Zen's next start turns it
back on, from `user.js`, as the warning's last line says.

On the `daily-driver (I4)` line, `zenius.handoff.quietReload false`,
`zenius.test.pageWorldEvaluate true` or `zenius.test.loopCounterOff true` at
its end means a preference only tests set is in the profile: zenius's quiet
reloads are off, agents' page code runs in the page's own JavaScript instead
of its sandbox, or a loop in it that calls no built-in isn't stopped. zenius
never writes them outside tests. Ask the user whether they did, then reset it
in `about:config`, and remove it from `user.js` if it's there.

### The self-check

Once doctor passes, run the self-check. It goes through the runtime's own
checks of what an update brings, in a window of its own with a mock agent,
and keeps a shot of each step. On a Mac, the window opens see-through, in
a corner of the screen, and clicks pass through it, so the user sees
nothing of it; elsewhere, it opens offscreen. If making it see-through
fails, it shows in that corner for the run instead: the run's
`summary.json` then says `"window": "corner"`, and Zen's log line
`self-check: the invisible window: …` says why. If the window ever gets
the focus, it hands it back to the user's most recent window. Its tasks
and chats are synthetic: none shows in the user's lists, and it writes
nothing of theirs, preferences included.

It runs only outside zenius's sandbox, and outside any other sandbox
around the shell: a sandbox can't reach its socket. With the sandboxed
CLI, `zenius selfcheck` exits 2 with `zenius selfcheck: this process can't
reach the self-check (EPERM). …`. So run the installed CLI directly, with
Node 24 in front, as for doctor's full check:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH node ~/.zenius/cli/sdk/bin/zenius selfcheck
```

First ask the user to switch to another app, the terminal for example,
and to stay out of Zen until the command ends. Brought to the front
mid-run, Zen can still make the see-through window its key window for
about 250 ms, and keys typed then would go to it, unseen. The window opens
only while Zen isn't the app in front: while Zen is in front, the run
waits, up to 60 s, and stderr shows `zenius selfcheck: waiting for Zen to
be in the background (up to 60 s)`. Once it starts, it takes about 10 s.

An agent that runs the command needs a command timeout over 240 s, such as
300 s: the CLI waits up to 90 s for a held run to start, then up to 150 s
for the run. A command cut off earlier stops the run, and the runtime
cleans up after it.

Expect exit status 0 and these lines, with the version and commit doctor
shows. The `ok` lines name the runtime's checks, so another version may
list others:

```
zenius selfcheck, instance "default": runtime <version> at <commit>, Zen <Zen's version>

ok    The ⋯ menu
ok    Archive, Archived and Unarchive
ok    Sending follows the answer

All 3 checks passed in <n> s.
The shots and summary.json are in ~/.zenius/selfcheck/default/<UTC time>
```

After a wait, one more line comes before `All 3 checks passed`: `It
waited <n> s for Zen to be in the background.` Otherwise:

- **Exit 1:** a `FAIL` line names its check, the step it stopped at and
  the error, or the summary says what failed. Stop, and keep the run's
  folder: its shots show where it stopped.
- **Exit 2** with `The self-check ran no check: the run failed (Zen stayed
  in front for 60 s, …)`: ask the user to switch to another app, and run
  it again.
- **Exit 2** with `zenius selfcheck: nothing answers on …`: Zen isn't
  running, has only just started, or runs a runtime without the
  self-check. Doctor's `zenius runtime` line shows which commit it runs.
  Once Zen runs the one step 4 installed, run it again.
- **Any other exit 2** says why it couldn't run. Stop there.

A CLI from before the self-check, such as one that "Going back to the
previous version" puts back, has no `zenius selfcheck`: skip it then.

The last line names the run's folder. It holds `summary.json`, the run's
result with each check's shots by name, and a PNG per step,
`<NN>-<check>-<step>.png`, numbered in order. Look at the shots yourself,
in their order: each is the self-check's window at the step its name says.
Tell the user the result in one line, and show them a shot only when its
check failed or it looks wrong. Then delete the folder by the path the
line printed:

```bash
rm -r ~/.zenius/selfcheck/default/<UTC time>
```

Never remove `~/.zenius/selfcheck` itself: it holds the self-check's
socket. As each run starts, it removes earlier runs' folders over 7 days
old, and all but the 10 newest.

## 7. A first task, in the Agents Space

The agent builds its page in the task's blank tab, so nothing loads from
the network. Then it tries two things the runtime and the sandbox must
refuse (I5): loading `about:config`, and, with the sandboxed CLI, writing a
screenshot outside the working folder and the run's temporary folder.

```bash
zenius nodejs <<'JS'
const task = await taskSpace("zenius first check");
const page = (await task.pages())[0];
await page.evaluate(() => {
  document.title = "zenius works";
  document.body.innerHTML = "<h1>zenius works</h1><p>A first task in the Agents Space.</p>";
});
console.log("title:", await page.title());
console.log(await page.snapshot());
console.log("about:config:", await page.goto("about:config").then(() => "opened", (error) => error.code));
if (process.permission) console.log("screenshot to the home folder:", await page.screenshot({ path: `${process.env.HOME}/zenius-check.png` }).then(() => "written", (error) => error.code));
await task.finish({ keep: [] });
const left = (await listTaskSpaces()).filter(s => s.name === "zenius first check");
console.log(left.length === 0 ? "finished: the task is closed" : `still listed: ${JSON.stringify(left)}`);
JS
```

Expect:

```
title: zenius works
[p1 "zenius works" | space "zenius first check"(<id>): 1 managed, 0 untracked — p1* "zenius works"]
root
  container
    heading
      text "zenius works"
    paragraph
      text "A first task in the Agents Space."

about:config: ZEN_URL_NOT_ALLOWED
screenshot to the home folder: ZEN_PATH_NOT_ALLOWED
finished: the task is closed
```

The screenshot line shows only with the sandboxed CLI.
With the plain CLI a script has the user's own access, so there is nothing
to refuse, and the script skips it. Either way, `~/zenius-check.png` must not
exist afterwards.

What the user sees, all within a few seconds:

1. A Space named "Agents" appears in Zen's Space switcher, unless a task
   already has it there.
2. The strip above the sidebar's foot buttons shows one agent working.
3. The user's current Space stays in front throughout.
4. The task finishes: its tab closes and the strip hides. The Agents Space
   goes away again, unless it holds other tabs.

Stop if the output differs, or the user saw their view change.

## 8. Optional: turn off Ego Lite's Skill for everyday agents

Only where Ego Lite is installed too, and the user wants their everyday
agents to use zenius for browser work. The user runs this step themselves,
after the install. Ego Lite stays installed. Only the two links that offer
its Skill to the user's agents move, into a backup. Ego Lite's setup makes
both, pointing to `~/.local/share/ego/ego-skills`, which leads into Ego
Lite's app:

- `~/.claude/skills/ego-browser`, for Claude Code;
- `~/.agents/skills/ego-browser`, for Codex.

Nothing else changes: not `~/.local/share/ego`, not Ego Lite's app, and none
of the user's other skills. The block checks both links first, and moves
nothing unless both are the links Ego Lite made. `mv` keeps them links, and
`targets.txt` records where each pointed:

```bash
(
  set -e
  target="$HOME/.local/share/ego/ego-skills"
  for link in "$HOME/.claude/skills/ego-browser" "$HOME/.agents/skills/ego-browser"; do
    if [ ! -L "$link" ] || [ "$(readlink "$link")" != "$target" ]; then
      echo "stop: $link isn't Ego Lite's link to $target; nothing moved"
      ls -ld "$link" || true
      exit 1
    fi
  done
  backup="$HOME/.zenius/backups/$(date -u +%Y%m%dT%H%M%SZ)/ego-skill"
  mkdir -p "$backup"
  for link in "$HOME/.claude/skills/ego-browser" "$HOME/.agents/skills/ego-browser"; do
    printf '%s -> %s\n' "$link" "$(readlink "$link")" >> "$backup/targets.txt"
  done
  mv "$HOME/.claude/skills/ego-browser" "$backup/claude-skills-ego-browser"
  mv "$HOME/.agents/skills/ego-browser" "$backup/agents-skills-ego-browser"
  echo "moved to $backup:"
  ls -l "$backup"
)
```

Expect `moved to …/.zenius/backups/<UTC time>/ego-skill:`, then two links,
`agents-skills-ego-browser` and `claude-skills-ego-browser`, each
`-> …/.local/share/ego/ego-skills`, and `targets.txt`. After `stop:`, nothing
moved: the `ls -ld` line shows what's there. Run the block once. A second run
stops, since the links have gone.

Then check what fresh agents see, in a new terminal:

- **Claude Code:** start `claude` in a folder the user works in, type
  `/skills`, and look at the browser skills. `zenius` must be listed, and
  `ego-browser` must not. Claude Code's own skills for Chrome and the desktop
  app's browser may be listed too; they come with Claude Code, not Ego Lite.
  `/skills` sends nothing to the model. Quit with `/exit`.
- **Codex,** without signing in or starting a session:

  ```bash
  command codex debug prompt-input hi | grep -o -E -- '- (zenius|ego-browser): [^\]*'
  ```

  Expect one line, `- zenius: …`. If a `- ego-browser: …` line shows too,
  Codex still finds Ego's Skill somewhere: stop, and find where.

### After an Ego Lite update

Ego Lite's Skill sits inside its app, in a folder per version, and its
updater may make the two links again. After each Ego Lite update, check that
they're still gone:

```bash
ls -ld ~/.claude/skills/ego-browser ~/.agents/skills/ego-browser
```

Two "No such file or directory" lines mean the Skill is still off. If either
link is back, run this step's block again (it makes a new backup), then the
fresh-agent check.

### Undo: turn Ego Lite's Skill back on

This moves the links from the newest backup back to where they were. It
moves nothing if either is missing from that backup, or if anything sits at
either path already:

```bash
(
  set -e
  backup=$(ls -d "$HOME"/.zenius/backups/*/ego-skill | tail -n 1)
  for name in claude agents; do
    if [ ! -L "$backup/$name-skills-ego-browser" ]; then
      echo "stop: no $name-skills-ego-browser in $backup; nothing moved"
      exit 1
    fi
    if [ -e "$HOME/.$name/skills/ego-browser" ] || [ -L "$HOME/.$name/skills/ego-browser" ]; then
      echo "stop: $HOME/.$name/skills/ego-browser exists already; nothing moved"
      ls -ld "$HOME/.$name/skills/ego-browser"
      exit 1
    fi
  done
  mv "$backup/claude-skills-ego-browser" "$HOME/.claude/skills/ego-browser"
  mv "$backup/agents-skills-ego-browser" "$HOME/.agents/skills/ego-browser"
  ls -l "$HOME/.claude/skills/ego-browser" "$HOME/.agents/skills/ego-browser"
)
```

Expect both links back, each `-> …/.local/share/ego/ego-skills`. To restore
an older backup, set `backup` to its `ego-skill` folder instead. If the
backups are gone, the same two links can be made again by hand:
`ln -s "$HOME/.local/share/ego/ego-skills" ~/.claude/skills/ego-browser`, and
likewise for `~/.agents/skills/ego-browser`.

## Later, if needed

Not install steps.

**Private-network pages in agent tabs.** With the allowlist empty, agent tabs refuse
private, link-local and `.local` hosts, and `page.goto()` there fails with
`net::ERR_ACCESS_DENIED`. The agent's own load just fails. When the user
types such an address in an agent's tab (an agent can hand off asking for
that), the card there ("Network access denied · <host>") has
**Add to allowlist**: it adds exactly that host to the String preference
`zenius.agentTabs.allowPrivateNetworks`, then loads the address in that tab.
For an address a page chose, the card offers only **Open it yourself**. For
web pages on a private network (TensorBoard, Jupyter, a dev server), the
user can also list them by hand: in `about:config`, in one of their own
Spaces, they set that preference to hosts, addresses or CIDR ranges
separated by commas, such as `<a private range, e.g. 10.x.0.0/16>` (this file
names no real address). Either applies at once, without a restart. Agents
can't change it.

Before they set it, tell the user what it opens:

- Whatever is listed is open to every agent page, and to code an injected
  agent runs there: a Jupyter without a token, say, is then its to use.
  Single hosts are safer than a whole range where the user knows them.
- Firefox's own Local Network Access check still asks before a public
  site's page reaches a listed host, and zenius hands the task to the user
  for it.

Removing an entry stays in `about:config`: the card only adds. The user edits
the preference's value and deletes that host, address or range; resetting the
preference empties the list.

**Agents' page code: ask per site, or never.** By default an agent's code
runs in its page's sandbox (`always`). In `about:config`, in one of their
own Spaces, the user can set the String preference
`zenius.agentTabs.pageCode`:

- `ask`: an agent's code waits on each site the user hasn't allowed, and
  the agent's tab asks "Allow the agent's code on <site>?". **Allow on this
  site** adds exactly that site to `zenius.agentTabs.pageCodeSites`.
  zenius writes that list only on the user's own click of this button.
  **Not now** refuses it on that site for the rest of that task, and
  writes nothing.
- `never`: no agent's page code runs. Agents still click, fill, press keys
  and read the page.
- Any other value acts as `ask`.

It applies at once. Removing a site stays in `about:config`, as for the
allowlist above. `zenius doctor` shows the setting and how many sites are
listed.

## Undo

1. The user quits Zen.
2. Remove the runtime from the profile:

   ```bash
   cd ~/zenius-daily
   scripts/install.sh --uninstall --dry-run   # lists what it would remove
   scripts/install.sh --uninstall
   ```

   It backs up what it removes to `~/.zenius/backups/<UTC time>/`, under
   the files' paths in the profile, and removes `~/.zenius/install.json`.
   It also takes zenius's lines out of `user.js` (or removes `user.js` if
   the install made it) and restores `network.dns.disableIPv6` in
   `prefs.js` as it was before the install: `restored
   network.dns.disableIPv6 in prefs.js to no value of its own (Zen's
   default)`, or to the earlier line. That part needs Zen quit (step 1),
   since Zen writes `prefs.js` when it quits. Run with Zen still open, it
   says so; run it again once Zen has quit.

   It also takes zenius's own preferences out of `prefs.js` and `user.js`:
   the private-network allowlist (`zenius.agentTabs.allowPrivateNetworks`)
   and any test's leftover. It keeps them in the backup as
   `zenius-prefs.js`, so the user can put the allowlist back after a
   reinstall. And it removes `zenius-uploads/` and `zenius-downloads/` in
   the profile folder, which hold copies of the files an agent gave a file
   chooser and its downloads, and the `zenius-upload-<hash>/` and
   `zenius-downloads-<hash>/` folders that earlier versions kept in the
   temporary folder (`$TMPDIR`), with their `-1`, `-2`, … siblings. It
   removes them only while Zen is closed, and only real folders the user
   owns, never a link. Its dry run lists each one it finds: `would remove
   <profile>/zenius-downloads`.

   With the agent's sidebar installed, it also prints `  put back the
   profile's own agent-sidebar from <that backup>` and `  removed
   agent-urlbar (the profile had none before zenius)`. If the sidebar made
   its workspace, it adds `  removed the sidebar's agent workspace,
   <profile>/agent-sidebar-workspace (kept in <backup>)`. A sidebar the
   profile had comes back exactly as it was before zenius's replaced it: from
   the backup made by the first update that brought the sidebar or, after a
   reinstall over a copy another installer put back, from that reinstall's
   backup. If another installer put a sidebar back after zenius's last
   install, Undo leaves it as it is and says `  left agent-sidebar in place:
   it changed since zenius installed it, so it's the user's own`. The user's
   other scripts, the sidebar's settings (`uc.agent-sidebar.*`) and
   `~/Library/Application Support/zenius-agent-sidebar/` stay as they are.
3. Remove the CLI and the Skill links, and the sandboxed launcher if step 2
   installed it:

   ```bash
   scripts/install-cli.sh --uninstall
   ```

   The user deletes their Codex rule, `~/.codex/rules/zenius.rules`, too.
   It's theirs, and the uninstall leaves `~/.codex` alone.

4. If step 8 turned Ego Lite's Skill off, turn it back on with step 8's undo,
   so the user's agents keep a browser Skill. Do it before deleting
   `~/.zenius/`, which holds its backup.
5. The user reopens Zen. It runs as before the install.

These stay behind:

- `~/.zenius/`: backups, zenius's task records (`state/default/`), the
  instance registry, the working folder's setting (`config.json`), and,
  from a sandboxed CLI before the working folder, runs' output folders
  (`out/`). Delete it by hand once nobody needs the backups.
- The working folder, `~/zenius-files` unless the install set another, with
  agents' downloads and the files their scripts wrote. The user keeps or
  deletes it.
- `<profile>/agent-sidebar-tasks.json` and
  `<profile>/agent-sidebar-chats.json`: the chats from zenius's sidebar,
  with their messages: its Work tasks in the first, each tab's Chat in the
  second. Delete them by hand if the user doesn't want those chats kept.
  Undo's `left in place:` line names those it finds: `~/.zenius
  (backups, zenius's task records, the CLI if installed, the working
  folder's setting), the working folder and its files (<folder>), the
  sidebar's chats (<profile>/agent-sidebar-tasks.json,
  <profile>/agent-sidebar-chats.json), and the Agents Space …`.
- In the temporary folder (`$TMPDIR`): the CLI's compile cache,
  `zenius-compile-cache-<uid>/` (from a CLI before 0.1.4, Node's
  `node-compile-cache/`), and, with the sandboxed CLI,
  `zenius-sandbox-<uid>/`, which holds each run's temporary folder. All
  can go.
- The Agents Space, if tabs are still in it: pages agents kept, or tasks
  that weren't finished. Without zenius it's an ordinary workspace, so the
  user can delete it in Zen or keep its tabs. Each tab that was a task's
  still has a small `zenius` value in Zen's session data, which nothing
  reads without zenius.

The first install has no zenius files to back up. If the profile has a
`user.js`, it backs that up to `~/.zenius/backups/<UTC time>/user.js`
before adding its pref line, and `install.json`'s `backup` names that
folder; otherwise `backup` is null. Undo takes zenius's lines back out of
`user.js`; the backup is only a safety net.
A later install backs up the version it replaces under
`~/.zenius/backups/<UTC time>/`. "Going back to the previous version", under
"Updating later", reads that version's commit from it.

## If Zen won't start, or misbehaves

- **Zen starts, but agents can't reach it.** The browser itself is fine.
  Run `zenius doctor`: its failing lines say what's wrong.
- **Zen doesn't open, crashes at startup or hangs.**
  1. If it hangs: force-quit it (⌥⌘⎋, then Zen).
  2. Remove zenius:

     ```bash
     cd ~/zenius-daily && scripts/install.sh --uninstall
     ```

     If it says Zen has the profile open, a Zen process is still running.
     Wait for it to exit, or force-quit it, then run it again.
  3. The user opens Zen. It's as it was before the install.
- **The user needs their browser right now.** They hold ⌥ (Option) while
  opening Zen and choose to open it in Troubleshoot Mode. fx-autoconfig
  loads no scripts there (the `inSafeMode` line checked in "Before you
  start"), so zenius is off. So are the user's other scripts, and their
  extensions, until the next normal start. Then quit and remove zenius as
  above.
- **Turn zenius off without removing it.** In `about:config`, add
  `zenius.uc.js` to `userChromeJS.scriptsDisabled`, a comma-separated list
  of script file names with no spaces, such as `other.uc.js,zenius.uc.js`.
  fx-autoconfig doesn't trim the names, so `other.uc.js, zenius.uc.js`
  leaves zenius on. Then the user restarts
  Zen. To turn zenius back on, take it out of the list and restart.
- **To report a problem,** include `zenius doctor --json` and the Browser
  Console's `[zenius]` lines (⌘⇧J in Zen).

## Updating later

The install's steps, with the new commit as `<commit>`. An update replaces
zenius's runtime in the profile and the CLI's copy. It keeps what the user
set up: the CLI's sandbox and its folders, the working folder, the Skill
links, zenius's
preferences (the allowlist, the page-code setting and its sites), the
backups, and the Agents Space's tasks, which come back after the restart.

1. Rerun the block in "1. Get the code". It checks out `<commit>` and
   reruns `npm ci`, with Node 24 in front.
2. Reinstall the CLI, with Node 24 in front. `--sandbox`, `--read-dir` and
   `--working-dir` aren't needed again: a later install keeps them, from
   the launcher and `~/.zenius/config.json`.

   ```bash
   PATH=/opt/homebrew/opt/node@24/bin:$PATH scripts/install-cli.sh --skill
   ```

   With the sandboxed CLI, expect:

   ```
   note     ~/.local/bin/zenius is the sandboxed launcher, and this install keeps it (--no-sandbox makes it a link again)
   built    sdk/dist/zenius.mjs
   installed ~/.zenius/cli: zenius <version>, commit <commit>
   ok       the working folder: ~/zenius-files
   ok       ~/.local/bin/zenius: the sandboxed launcher
   ok       ~/.claude/skills/zenius -> ~/.zenius/cli/skill/zenius
   ok       ~/.agents/skills/zenius -> ~/.zenius/cli/skill/zenius
   check    zenius <version> (protocol 1, sandboxed)
   ```

   With the plain CLI, there's no `note` line, the launcher's line is
   `ok       ~/.local/bin/zenius -> ~/.zenius/cli/sdk/bin/zenius`, and the
   last line ends `(protocol 1)`. The `ok` lines mean the launcher and the
   Skill links stay as they were; the copy they lead to now holds the new
   version. Stop on a `skip … left alone` line.

   An update from a version before the working folder sets it, as a first
   install does: `set      the working folder: ~/zenius-files
   (~/.zenius/config.json)` and `made     ~/zenius-files, the working
   folder, readable only by you` take the `ok` line's place. With the
   sandboxed CLI, `note     scripts now write in the working folder,
   ~/zenius-files, not in runs' output folders: ~/.zenius/out keeps earlier
   runs' files, which zenius no longer uses` follows the first `note`,
   once. The user can delete that folder when they don't need those files.

   When a version changes the launcher's text, as when it passes one more
   variable in, the launcher's line reads `updated  ~/.local/bin/zenius: the
   sandboxed launcher`: install-cli.sh rewrites the launcher whenever its
   text changes. It stays sandboxed.

   Until step 5, agents run the new CLI against the old runtime. That works
   while both speak the same protocol, and doctor's full check (outside the
   sandbox) adds `Installed from commit <old>; this CLI is from <commit>.`
3. Stop every other Zen and check that none is left, as in the install's
   step 5: one that runs makes the reopen in step 5 fail. Then the user
   quits Zen. As in the install's step 5, ask the user first, and don't go
   on until they say it's done.
4. Install the runtime:

   ```bash
   scripts/install.sh --disable-ipv6
   ```

   Pass `--disable-ipv6` only if the install did. Expect lines 1 and 2 of
   the install's step 3, then (with the flag):

   ```
     no running Zen has this profile open
     backed up the zenius files it replaces to /Users/<user>/.zenius/backups/<UTC time>
     wrote <n> files in the profile (listed in /Users/<user>/.zenius/install.json)
     the working folder stays /Users/<user>/zenius-files (/Users/<user>/.zenius/config.json)
     network.dns.disableIPv6 is already true in user.js
   Done. The next time Zen starts, it will load zenius <version>.
   ```

   Run without `--disable-ipv6`, the install leaves `user.js` as it is, and
   that line reads `network.dns.disableIPv6 stays true in user.js, from an
   earlier install with --disable-ipv6; uninstall restores its previous
   value`: nothing changes for the user. An older commit's `install.sh` may
   not know the flag: then it prints only `install.sh: unknown argument:
   --disable-ipv6 (see --help)` and changes nothing. Run it without the
   flag; such a commit sets the pref unasked.

   When the profile has a sidebar of its own that zenius's hasn't replaced
   yet, one more line follows the backup's:

   ```
     backed up the profile's own agent-sidebar to /Users/<user>/.zenius/backups/<UTC time>; zenius's takes its place, and uninstall puts it back
   ```

   The count in `wrote <n> files` includes the agent's scripts: the sidebar
   and the address bar's '>' dispatch. If another installer put a sidebar
   back over zenius's since the last install, the line reads `backed
   up the profile's own agent-sidebar (changed since zenius installed it) to
   …`: that copy is now the one Undo puts back.

   A `Warning: another Zen from the same app is running. …` line after
   `Done.` means another Zen from the app started since step 3. Stop a dev
   Zen before step 5, as its line says; any other is the user's to quit.

   With zenius installed, it refuses while a Zen has the profile open, so a
   running Zen never mixes two versions. Then it prints only `install.sh:
   Zen (pid …) has this profile open, and zenius is installed in it. Quit
   Zen first, or pass --while-running …` and changes nothing; its
   `--dry-run` refuses the same way. Zen is still running: on the Mac,
   closing its windows doesn't quit it. Wait until the user has quit it
   (⌘Q), and run `scripts/install.sh --disable-ipv6` again. Never pass
   `--while-running` for the daily Zen.
5. The user reopens Zen, which restores the session as usual, the Agents
   Space's tabs included. Then check as in the install's step 6: with the
   sandboxed CLI, run both doctor commands. The `zenius runtime` line must
   show `commit <commit>`. With the agent's sidebar installed, the `zenius
   sidebar` line must start `zenius's on disk`, and the `sidebar's zenius
   mcp` line must read `~/.local/bin/zenius mcp answers: <n> tools (open,
   goto, read_page, click, …)`. The sidebar's agents get their browser tools
   from that command, which step 2's CLI brings. If a Work chat ever says
   zenius's MCP server failed to start, run doctor: this line then warns
   `doesn't answer` and says to rerun step 2. The `zenius sidebar` line
   ends `Codex can run, within the limits below`, and three lines follow:
   Codex's limits, apply_patch's read path, and how to turn Codex off. With
   `zenius.agentSidebar.allowCodex` set to false, it ends `Codex is off
   (zenius.agentSidebar.allowCodex = false)` instead. Either way, it's the
   user's choice, not a fault. A
   `zenius.agentSidebar.allowUnknownAgents` warning on the I4 line is a
   test's pref: ask the user before resetting it, as for the other
   test-only prefs. The `agents' page code` line is information, not a
   check: `always (the default); no allowed sites listed` until the user
   chooses `ask` or `never` (see "Later, if needed").

   Then run the self-check, as in the install's step 6.

### Going back to the previous version

`scripts/install.sh --uninstall` removes zenius; it doesn't bring back the
version an update replaced. To go back to that version, read its commit
from the backup the update made:

```bash
cd ~/zenius-daily
backup=$(sed -n 's/^  "backup": "\(.*\)",$/\1/p' ~/.zenius/install.json)
echo "backup: ${backup:-none}"
if [ -f "$backup/chrome/JS/zenius/install.json" ]; then sed -n 's/^  "commit": "\(.*\)",$/\1/p' "$backup/chrome/JS/zenius/install.json"; fi
```

Expect `backup: /Users/<user>/.zenius/backups/<UTC time>`, then a commit:
the version the last install replaced. Run "Updating later" with that
commit as `<commit>`, and its step 4 without `--disable-ipv6` if that
commit's `install.sh` doesn't know the flag; after the reopen, doctor's
`zenius runtime` line
shows it. `backup: none`, or a backup with no commit after it (it holds only the
first install's `user.js`), means the last install replaced no version,
since it was the first: going back then means "Undo".

Don't copy the backup into the profile by hand. `install.sh` at that commit
writes the same files the backup holds (identical but for `installedAt`
in `install.json`). It also checks that Zen is closed,
backs up the version it replaces, and keeps `~/.zenius/install.json` right,
which a copy doesn't. Going back to a commit whose `install-cli.sh` has no
`--read-dir` rewrites the launcher without that folder, so the next update
takes `--read-dir` again. The CLI has no
backup, so only the checkout can put back its earlier version.

Going back to a version from before the working folder: its runtime
deletes a task's downloads when the task ends again, and its sandboxed
launcher writes runs' output folders in `~/.zenius/out`. The working folder,
its files and `~/.zenius/config.json` stay as they are, unused until an
update brings the working folder back.

To go back to a version from before zenius's sidebar, run "Undo" with the
current checkout first, which takes zenius's sidebar out and puts back the
one the profile had, if any. Then run
"Updating later" with that commit. Its step 2 may say `updated` on the
launcher's line, since an older launcher's text differs. That commit's
`install.sh` alone would leave
zenius's sidebar and '>' dispatch in place, since it doesn't know them.
While zenius is installed, keep `~/.zenius/components.prior` and the backup
folder it names: Undo puts the profile's earlier sidebar back from them,
even after later updates.
