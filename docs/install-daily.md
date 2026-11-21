# Installing zenius into the user's daily Zen

A runbook for the relay on the user's Mac. Run the steps in order. Each step
gives the command, what you should see, and when to stop and report instead
of going on.

It describes zenius with every task in one shared Agents Space (SPEC §3.4,
approved 2026-11-20). The install waits for that build and for I5 (SPEC
§3.9). The manager reviews this file and says go before step 1. The manager
also asks the user right before step 5, the restart.

Rules that hold throughout:

- Only the user quits and reopens Zen. Never restart or quit it from a
  script.
- Never change `/Applications/Zen.app`.
- Nothing here sends anything to GitHub or any other service. `npm ci` in
  step 1 only downloads packages, and only if npm's cache lacks them.
- On any output these steps don't describe, stop and send it to the manager.

## What changes for the user

Until an agent connects, nothing the user can see:

- **Same windows and session.** The same tabs, workspaces and session come
  back after the restart.
- **No new controls.** zenius adds no buttons, panels, menus or toolbar
  changes. The update that brings the agent's sidebar is the exception: it
  puts zenius's sidebar in place of the user's own, and adds a '>' row to
  the address bar (see "The update that brings the agent's sidebar",
  below).
- **One preference, the user's choice.** Zen makes no IPv6 lookups
  (`network.dns.disableIPv6`), which ends the GitHub stall on the user's
  IPv4-only network. The cost: a site reachable only over IPv6 doesn't load in
  Zen. It's the only preference the install changes, and only with
  `--disable-ipv6`, which this runbook's install commands pass. Undo
  restores its earlier value.
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

  Measured on the Linux server; see I4 in `docs/reports/zen-core.md`.

Agents connect through the `zenius` command (step 2). The user's Claude Code
and Codex sessions also get a `zenius` Skill, beside Ego Lite's. The user
chose to turn Ego Lite's Skill off for everyday agents, so that they use
zenius for browser work. Step 8, which the user runs themselves, moves the
two links that offer it into a backup, and its undo moves them back. Neither
the install nor step 8 changes Ego Lite's app or data: Ego Lite stays
installed and works as before.

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
    reaches their other devices as a plain Space. The daily Zen isn't signed
    in to Sync (checked 2026-11-20).
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
- **Capped downloads.** A task's downloads are capped at 50 files and 1 GiB,
  and deleted when it ends.
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
  - The user chose (2026-11-20) public internet pages only for agents: the
    allowlist starts empty, so agent tabs refuse every private address until
    the user adds one. If agents need pages on a private network later, see "Later,
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

### The update that brings the agent's sidebar

This update, the first after `cbac1ef`, puts zenius's agent sidebar in
place of the user's own. `docs/agent-sidebar.md` has the details.

- **The user's own sidebar is kept.** The install backs up their
  `agent-sidebar.uc.js` and `agent-sidebar/`, and Undo puts them back
  exactly. Their sidebar settings (`uc.agent-sidebar.*`), their agents'
  config in `~/Library/Application Support/zenius-agent-sidebar/` (only read)
  and their other scripts stay as they are. zenius writes nothing into
  `~/.claude` or `~/.codex`.
- **Chat and Work.** Chat is the sidebar as it was: one conversation per
  tab, about its page. Work binds a chat to a zenius task instead of a tab.
  The agent works in a task of its own in the Agents Space, and the chat
  follows that task's tabs and hand-offs. The address bar's '>' row and
  `+ New task` start one. The directory beside the sidebar lists the
  tasks: Needs you, Working, Done.
- **The sidebar's agents get the browser and nothing else.** A Chat
  session has no tools: it answers from the page's text. A Work session's
  tools are zenius's 12 browser tools and Claude Code's ToolSearch, and
  nothing else (zen-eval's session check): no shell, no files, no web
  fetch. Codex runs once `zenius.agentSidebar.allowCodex` is true.
  Through `99cdc39` the pref is false by default, and the user sets it
  after installing `99cdc39`; from the update after `99cdc39` on, it's true
  by default. While it's false, the sidebar starts Claude Code, though the
  user's config names Codex as its default agent.
- **Live card, Watch and Take over.** At the end of a Work chat, a picture
  of the page its agent is on, drawn only while the user can see it.
  Watch switches to the task's tab and shows a small "Watching <task>"
  chip in the page area's top left corner. Its Back, or ⌃Tab, returns to
  the tab the user came from. Take over gives the user the task, as the
  tasks panel does.
- **Agents' page code is the user's setting.** By default it runs as
  before. With `zenius.agentTabs.pageCode` set to `ask`, an agent's code
  waits on each site the user hasn't allowed, and the agent's tab asks
  "Allow the agent's code on <site>?", with Allow on this site and Not
  now. `never` refuses it everywhere. See "Later, if needed".
- **Known for now** (zen-sidebar's list for the user):
  - The live card shows an iframe from another site as blank. On a page
    that takes over a second to paint, or doesn't answer within 5 s, it
    keeps its last picture until it appears again. The agent never sees
    these pictures.
  - The Agents strip's "N agents working" (agents that acted in the last
    15 s) can differ from the sidebar's Working tasks (turns that run), and
    the Watch chip's Back button covers a small strip of the page's top
    left. The update after `107f93c` settles both (below).

### The update after `107f93c`

This update, the first after `107f93c`, changes how the user goes to an
agent's task and back, and what a Take over that can't begin does.

- **Every way to a task is a watch, and ⌃Tab is the way back.** The tasks
  panel's Open, its tab names and Take over, a notification's click, and
  the sidebar's live card and directory all show the task's tab and
  remember where the user was. While the window watches, the strip reads
  "Watching <task> · ⌃Tab". Where the strip can't be read (a collapsed
  sidebar, compact mode), a chip in the page area's top left corner says
  the same. It's only a hint, with no Back button: clicks go through it to
  the page.
  - ⌃Tab returns to where the user was: their tab, or, from an agent's
    page or the Agents Space, their own Space, on the tab Zen remembers
    there. Picking a tab outside the task, or another Space, ends the watch
    where the user went. Outside a watch, ⌃Tab does what it always did in
    Zen.
  - When a watched task ends, the window stays on its page, and the strip
    (or the chip) says "Task done · ⌃Tab back to your tabs". ⌃Tab still
    goes back until the user presses it or picks another tab or Space
    themselves; closing the page (Close now, or ⌘W) keeps the way back. The
    page still closes once they leave it, unless the agent kept it or they
    chose Keep tab.
  - While the user watches a Work chat's task, its live card shows "⌃Tab
    back to your tabs" in place of Watch. Take over stays, except after a
    refused Take over (below).
- **The strip agrees with the sidebar.** A Work chat's task counts as
  working in the Agents strip while its turn runs, and as needing the user
  while the chat waits for them, as in the sidebar's directory. The strip
  still counts any task whose agent acted in the last 15 s too, so for a
  moment after a turn ends, or with agents outside the sidebar, it can
  count more than the sidebar's Working.
- **A Take over that can't begin says why.** Before, the Take over prompt
  came back with no reason, and only the panel's Stop got the user out. Now
  the page shows "Can't take over this page", the reason in a line (such
  as "The page didn't load afresh in time."), and Try again, Stop task and
  Resume agent. When loading the page afresh would take the user to
  another site, there's no Try again: zenius stopped that load, and Stop
  task ends the task and leaves the page theirs. The agent stays paused
  until the user picks. Meanwhile the task needs the user in its badge and
  the strip. A Work chat's task is under Needs you in the sidebar's
  directory, as "Can't take over this page", and its live card hides Take
  over until Resume agent brings it back: the page's card offers Try again
  where trying again can work.
- **Codex comes back once the user sets its pref.** In this install the
  pref is still false by default, so afterwards the user sets
  `zenius.agentSidebar.allowCodex` to true in `about:config`, once: type
  its name, choose Boolean, and press +. From the update after `99cdc39`
  on, it's true by default. Then the sidebar offers Codex, with these
  limits: read-only, no shell, no writes, and no network outside zenius;
  its sub-agents and hosted web search are off, which newer versions of
  Codex had left on; and the sidebar refuses every approval it asks for.
  One read path is left, which the user accepted: apply_patch's check can
  tell Codex whether a file exists, or whether it holds a given line,
  though not what the file says.
- **Smaller changes.** In an agent tab the user watches, the agent's cursor
  now flies along a drag, to where it presses and on to where it drops, and
  a click or double-click with no label of its own reads "Clicking
  element", as in Ego. A question's Edit button in the sidebar is now a
  pencil.
- **No translucent look.** `99cdc39` still has a
  `zenius.agentSidebar.translucent` pref for a translucent sidebar, which
  the user tried in the try Zen and decided against. Leave it unset: the
  sidebar stays solid, and the update after `99cdc39` removes the pref.
- **Under the hood.** A site's service worker, which runs for the user's
  own tabs, can't reach an agent's pages, the agent's code or their
  workers, even by messaging them first. A task's shared worker stays out
  of its reach even after the site's worker claims it, and can't reach the
  local network either. The files an agent gives a file chooser, and its
  downloads, are kept in Zen's profile folder (`zenius-uploads/`,
  `zenius-downloads/`), out of a sandboxed CLI's reach, instead of the
  temporary folder. A download whose folder something else changed is
  refused, and a download's bytes are never read through a link. Nothing
  changes on screen, except in a page the agent's code wrote into, kept
  after the task: a notice the site's worker would raise by messaging the
  page, such as an "update ready" banner, waits until the page is reloaded
  or left.
- **Known for now** (zen-observe's): while an agent's task shows a page of
  a site, or a kept page the agent's code wrote into does (until a load
  replaces that page), that site's `blob:` shared workers can't reach the
  local network (private addresses and `.local` names), including those
  the user's own tabs start. They can again once no such page shows the
  site. A task page's `data:` shared worker is refused (SecurityError).

### The update after `99cdc39`

This update, the first after `99cdc39`, is still taking shape: its lines
land here as its changes reach `main`.

- **Under the hood.** In an agent's tab, a page that goes to another site
  and then starts a download by itself (an interstitial, a meta refresh)
  no longer leaves a temporary file in the user's Downloads folder, and an
  agent's download that the browser begins outside zenius's folder is
  refused before anything is saved. Versions before `99cdc39` kept the
  files an agent gave a file chooser, and its downloads, in
  `zenius-upload-<hash>/` and `zenius-downloads-<hash>/` in the temporary
  folder (`$TMPDIR`). `99cdc39`'s start removed those, except any on
  another volume than the profile. From this update on, zenius leaves them
  alone: a process still inside one could have turned their removal
  against other files. Only Undo or the system's temp cleanup removes them
  now. With the sandboxed CLI, an upload through a link in the working
  folder to a file outside the folders a script may read fails with
  `ZEN_PATH_NOT_ALLOWED`, as the file itself would.
- **The IPv6 preference is the install's option.** `install.sh` sets
  `network.dns.disableIPv6` only with `--disable-ipv6` (`77d83f5`), so an
  install turns IPv6 off only when asked; without the flag it leaves
  `user.js` as it is. This runbook's install commands pass the flag, so the
  user's Zen still makes no IPv6 lookups. Doctor's `DNS` line warns only
  when zenius's line is in `user.js` and the running Zen has the pref off;
  without that line, false or unset passes.
- **Agents can upload a folder.** Where a page asks for a folder (an input
  with `webkitdirectory`), an agent can now give it one. zenius's CLI reads
  the folder without following links, at most 1000 files and 50 MiB, and
  the page gets the files as from the user's own pick, though without the
  user activation a pick gives. Firefox asks before any folder reaches a
  page; for the agent's own folder, zenius answers yes itself, once, for
  that folder only.
- **Codex runs by default.** `zenius.agentSidebar.allowCodex` is now true
  by default, and Codex runs within the limits in the `99cdc39` section
  above. A new chat starts with the agent the user last picked in the
  sidebar, else `config.json`'s default, which for the user is Codex, else
  Claude Code. An automatic fallback is no longer stored as a pick.
  Setting the pref to false in `about:config` turns Codex off with no
  restart: new sessions and questions are refused at once, and the menu
  greys Codex out the next time it's drawn. Doctor's `zenius sidebar` line
  says Codex can run, and the lines under it list its limits (read-only,
  no shell, no writes, no network outside zenius, sub-agents and web
  search off, every approval refused), the one read path (apply_patch's
  check), and how to turn it off.
- **No translucent look.** The `zenius.agentSidebar.translucent` pref is
  gone, and the sidebar's panel and drawer stay solid, as the user chose
  (`d990e0d`). A value set for it does nothing now; the user can delete
  it in `about:config`.

## Before you start

These checks change nothing:

```bash
node --version                                  # v22.3 or later
/opt/homebrew/opt/node@24/bin/node --version    # v24.x
ls /Applications/Zen.app/Contents/Resources/config.js
P=~/Library/"Application Support"/zen/Profiles/"<id>.Default (release)"
ls "$P"/chrome/utils/boot.sys.mjs
grep -n "inSafeMode" "$P"/chrome/utils/boot.sys.mjs
```

Two Nodes:

- **The PATH's Node** is the one the user's agents run `zenius` with. The
  installed CLI needs 22.3 or later (checked on 23.5).
- **Homebrew's Node 24** builds the CLI in steps 1 and 2. The SDK's
  `package.json` declares Node `^22.18 || >=23.6`, so with 23.5 `npm ci`
  would print an `EBADENGINE` warning.

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
  user's call: send the manager the output;
- the `grep` prints nothing. Then Troubleshoot Mode may still load zenius,
  and the manager decides how to go on.

You also need the commit the manager approved for this install, written
`<commit>` below.

## 1. Get the code

Use a checkout that only the daily install uses, so nothing in progress
elsewhere ends up in the user's Zen.

```bash
[[ -d ~/zenius ]] || git clone <zenius's git URL> ~/zenius
cd ~/zenius
git fetch -q origin
git checkout -q --detach <commit>
git log --oneline -1               # shows <commit>
git status --short                 # prints nothing
(cd sdk && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci --prefer-offline --no-audit --no-fund)
```

On the Mac, `git fetch` may also print the git server's login banner and ssh warnings
about port forwards, which come from the forwards in the Mac's ssh config
(zen-eval saw them when installing `107f93c`). They're harmless: go on if
`git log` shows `<commit>`.

`npm ci` installs the SDK's build tools (about 36 MB), which
`install-cli.sh` needs to build the CLI bundle. The bundle isn't in git.
Both run with Homebrew's Node 24 in front of the PATH, for these commands
only.

npm 11 may end with an `npm warn install-scripts` block saying that
esbuild's postinstall, `esbuild@<version> (postinstall: node install.js)`,
isn't covered by allowScripts. That's fine: step 2's build works without that
script. zen-sdk saw the block with npm 11.19.1 on the Linux server, and zen-eval on the Mac
when installing `107f93c`; both builds worked. Leave allowScripts as it is:
don't run the `npm install-scripts approve` the block suggests, which would
write to `sdk/package.json`.

Stop if `git status` prints anything, or `npm ci` fails.

## 2. Install the CLI and its Skill

The user chose the sandboxed CLI (2026-11-20), for the Codex rule at the end
of this step. Run the dry run and the install under "The sandboxed CLI, the
user's choice" below, in place of the plain ones next. The notes on the
Skill links and the PATH apply to both.

First the dry run, again with Node 24 in front:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH scripts/install-cli.sh --skill --dry-run
```

Expect these lines, and no others (with `/Users/<user>` for `~`):

```
would build sdk/dist/zenius.mjs
would install ~/.zenius/cli: zenius <version>, commit <commit>
would link ~/.local/bin/zenius -> ~/.zenius/cli/sdk/bin/zenius
would link ~/.claude/skills/zenius -> ~/.zenius/cli/skill/zenius
would link ~/.agents/skills/zenius -> ~/.zenius/cli/skill/zenius
```

Two other lines are fine:

- `ok …`: a link already points at the copy.
- `note … is not on PATH`: agents won't find `zenius` by name (see below).

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
`linked`), and its last line is `check    zenius <version> (protocol 1)`.
The loop should print `--- 2` and the path for each link. Claude Code reads
`~/.claude/skills/<name>/SKILL.md` and Codex reads `~/.agents/skills`, both
through links (zen-sdk checked Claude Code 2.1.329 and Codex 0.169.0;
`references/install.md`). Codex skips a Skill whose `SKILL.md` lacks the
frontmatter or its `description` without saying so. Stop if either line
differs.

Codex runs each command in a sandbox of its own, which blocks Zen's socket
by default: a zenius command there fails as `blocked`, and the agent asks to
run it outside Codex's sandbox. The user's setup for that is a Codex rule:
see "Codex: a rule for the sandboxed CLI", after the sandboxed CLI below.

If `command -v zenius` prints nothing (or the dry run printed the `not on
PATH` note), `~/.local/bin` isn't on the PATH. Use `~/.local/bin/zenius` in
the steps below, and tell the manager: the user's agents need it on their
PATH.

### The sandboxed CLI, the user's choice

The user chose to sandbox the CLI (2026-11-20). Run this install instead of
the plain one above.

`--sandbox` makes `~/.local/bin/zenius` a launcher, a file instead of a link,
so every `zenius` command an agent runs is sandboxed: `sandbox-exec` with the
profile in `~/.zenius/cli/sdk/sandbox/zenius.sb`, and Node's permission model
inside it. Agents then run Homebrew's Node 24,
`/opt/homebrew/opt/node@24/bin/node`, not the PATH's Node.

A script that `zenius nodejs` runs can then:

- read the folder it starts in, but write nowhere in it. git, direnv, npm,
  pytest, make and agents run what a project holds (hooks, `.envrc`,
  `.venv/bin`, `conftest.py`), outside the sandbox;
- write an output folder of its own run,
  `~/.zenius/out/<folder name>-<checksum>/run.XXXXXX`. A relative path given
  to `screenshot()` or `saveAs()` lands there, and the script's output lists
  each such file under `[zenius:files]`. A run can also read the same
  folder's earlier runs. Runs over 7 days old, and empty ones over a day
  old, are removed;
- read and write a temporary folder of its own run;
- read the CLI copy and the instance registry, and connect to the
  instance's socket.

It can't:

- read any other file, or write anywhere else;
- start programs or signal other processes;
- reach the network or any other socket, such as ssh-agent's, Docker's or
  hc's;
- see environment variables beyond a short list (no `NODE_OPTIONS`, no
  tokens).

The working folder isn't granted when it is `$HOME`, a temp folder or above
one, or when it holds or sits inside `~/.zenius`, Zen's profiles,
`~/.config`, `~/.local`, `~/Library`, Node 24's folder or a credentials
folder such as `~/.ssh`. The script then starts in its temporary folder. The
browser adds nothing to what a script can reach (I5).

zen-eval checked this on the Mac:

- The canary, `tests/security/run.sh sandbox`, passed 6/6 at 24a1343 (with
  aa0b007), on Homebrew's node@24, with hc and ssh-agent probed. Every reach
  it probes failed for a script: planted `.git/hooks`, `core.fsmonitor` and
  `.venv/bin/git` all failed to write. A pilot's work still worked: goto, a
  snapshot, an upload from the working folder, a screenshot to its run's
  folder. Each run also got output and temporary folders of its own.
- In Claude Code 2.1.329, nothing gets past an allow rule `Bash(zenius:*)`:
  variables in front, chaining and heredoc tails were all denied. Still,
  never approve by hand a `zenius` command that starts with a variable: the
  variable acts before the sandbox does.
- Each command takes about 20 ms more: from about 35 to 55 ms on the Mac,
  and 40 ms more on the Linux server.

First the dry run, with Node 24 in front:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH scripts/install-cli.sh --skill --sandbox --dry-run
```

Expect these lines (with `/Users/<user>` for `~`). zen-eval checked that
the dry run changes nothing.

```
would build sdk/dist/zenius.mjs
would install ~/.zenius/cli: zenius <version>, commit <commit>
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
    OUT_ROOT='/Users/<user>/.zenius/out'
    OUT_KEEP_DAYS=7
    case macos in
```

These lines are fine too:

- `ok …`: a Skill link already points at the copy.
- `would write ~/.local/bin/zenius: the sandboxed launcher (was a link to
  ~/.zenius/cli/sdk/bin/zenius)`: a plain install was there before.
- `note … is not on PATH`, as above.

Stop on any other line. After an `error    --sandbox: …` line, the install
has changed nothing: send the line to the manager.

To keep runs' output somewhere else, the user can name a folder outside
every project. Add `--output-dir <absolute folder>` to both commands; later
installs keep it. `OUT_ROOT` in the printed launcher then names it.

Then install and check:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH scripts/install-cli.sh --skill --sandbox
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
- **Updating later.** `scripts/install-cli.sh --skill` keeps the sandbox. Its
  first line is `note     ~/.local/bin/zenius is the sandboxed launcher, and
  this install keeps it (--no-sandbox makes it a link again)`.
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
hand. Runs' output folders stay in `~/.zenius/out/` (or the
`--output-dir`), with the rest of `~/.zenius/`.

### Codex: a rule for the sandboxed CLI

Codex runs each command in a sandbox of its own. Its default,
`workspace-write` with network access off, blocks Zen's socket. On the Mac
no sandbox can start inside Codex's, so the sandboxed launcher stops there
and says so, whatever Codex's network setting. zen-sdk checked Codex
0.169.0's `codex sandbox` on Linux, and zen-eval on the Mac, with
`tests/security/codex-sandbox.sh`. Without a setup, an agent asks to run the
zenius command outside Codex's sandbox (`require_escalated`), as
`references/install.md` tells it.

The user chose a Codex rule (2026-11-20): each `zenius` command then runs
outside Codex's sandbox without asking, and zenius's own sandbox applies to
it. The rule is a file in `~/.codex`: give the user the lines below, and let
them make the change. Nothing is applied without them. On the Mac, call
Codex as `command codex`: the bare `codex` is the user's shell function.
`/Users/<user>` stands for their home folder, since Codex wants absolute
paths.

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

- zen-sdk checked the rule with `codex execpolicy check` on the Linux server (Codex
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

Other setups, not chosen: the plain CLI with Codex's experimental network
proxy open only to Zen's socket, which then carries every Codex command's
network; or no change, with the user approving each zenius command when
Codex asks. Their steps are in `git show ce24f90:docs/install-daily.md`.

## 3. See what the runtime install would do

```bash
scripts/install.sh --dry-run --disable-ipv6
```

`--disable-ipv6` is the user's choice (see "The one pref" in step 4). Each
install command in this runbook passes it, except one that goes back to a
commit before `77d83f5` (see "Updating later", step 4).

Expect, in this order:

1. `Installing zenius <version> (protocol <n>, commit <commit>) into
   /Users/<user>/Library/Application Support/zen/Profiles/<id>.Default (release)`
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

- the profile isn't `<id>.Default (release)`;
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
follows, with each one's pid and profile. Stop them before step 5.

The running Zen doesn't change. Zen reads its scripts only when it starts.

**The one pref.** With `--disable-ipv6`, the install sets
`network.dns.disableIPv6` to true in the profile's `user.js`, which the
user chose: Zen then makes no IPv6 lookups, which ends the GitHub stall on
their IPv4-only network. The cost: sites reachable only over IPv6 don't load in
Zen. It takes effect when Zen restarts (step 5). The install records the
pref's value before it, and Undo puts that back. Without the flag, from
`77d83f5` on, the install leaves `user.js` as it is; earlier commits set
the pref without being asked.

## 5. The user quits and reopens Zen

First stop every dev Zen on the Mac, the try Zen included. While any Zen
from `/Applications/Zen.app` runs, even a headless one, opening Zen from the
Dock only brings that one forward, and the daily Zen doesn't open. That's
what happened at the first install (2026-11-21). Each Zen's owner stops it
with `scripts/zen-dev.sh <name> stop`. Then check that only the daily Zen is
left; the dev Zens are the ones started with `-profile`:

```bash
pgrep -lf '/Applications/Zen.app/Contents/MacOS/zen .*-profile' || echo "no dev Zen"
```

Expect `no dev Zen`.

The manager asks the user first; don't go on until the user says it's done.
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
- the user's DNS choice is in place: `DNS` reads `network.dns.disableIPv6:
  true, set by install.sh at the user's request (no IPv6 lookups in Zen)`.

On a failure, stop and send the manager `zenius doctor --json`.

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
`zenius.handoff.groupSwitch true`, `zenius.test.pageWorldEvaluate true` or
`zenius.test.loopCounterOff true` at its end means a preference only tests
set is in the profile: zenius's quiet reloads are off, a hand-off moves the
user's page into a window group of its own (which the user decided against),
agents' page code runs in the page's own JavaScript instead of its sandbox,
or a loop in it that calls no built-in isn't stopped. zenius never writes
them outside tests. Ask the user whether they did, then reset it in
`about:config`, and remove it from `user.js` if it's there.

## 7. A first task, in the Agents Space

The agent builds its page in the task's blank tab, so nothing loads from
the network. Then it tries two things the runtime and the sandbox must
refuse (I5): loading `about:config`, and, with the sandboxed CLI, writing a
screenshot outside the run's own folders.

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

Expect (from a dev Zen on the Linux server):

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

The screenshot line shows only with the sandboxed CLI, the user's choice.
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

## 8. Turn off Ego Lite's Skill for everyday agents

The user runs this step themselves, after the install. Ego Lite stays
installed. Only the two links that offer its Skill to the user's agents move,
into a backup. Ego Lite made both when it was set up (2026-11-19), and both
point to `~/.local/share/ego/ego-skills`, which leads into Ego Lite's app:

- `~/.claude/skills/ego-browser`, for Claude Code;
- `~/.agents/skills/ego-browser`, for Codex. (`~/.codex/skills` is empty.)

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
moved: show the manager the `ls -ld` line. Run the block once. A second run
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
  Codex still finds Ego's Skill somewhere: stop and tell the manager.

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

Not an install step: the user chose (2026-11-20) public internet pages only.

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
   cd ~/zenius
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
   <profile>/agent-sidebar-workspace (kept in <backup>)`. The user's own
   sidebar comes back exactly as it was before zenius's replaced it: from
   the backup made by the first update that brought the sidebar or, after a
   reinstall over a copy their installer put back, from that reinstall's
   backup. If their installer put their sidebar back after zenius's last
   install, Undo leaves it as it is and says `  left agent-sidebar in place:
   it changed since zenius installed it, so it's the user's own`. Their
   other scripts (`my-script.uc.js`), the sidebar's settings
   (`uc.agent-sidebar.*`) and `~/Library/Application Support/zenius-agent-sidebar/`
   stay as they are.
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
  instance registry, and, with the sandboxed CLI, runs' output folders
  (`out/`). Delete it by hand once nobody needs the backups.
- `<profile>/agent-sidebar-tasks.json`: the list of Work chats from
  zenius's sidebar, with their messages. The user's own sidebar has no
  Work mode and doesn't use the file. Delete it by hand if the user
  doesn't want those chats kept. From `52de584` on, Undo's `left in place:`
  line names it: `~/.zenius (backups, zenius's task records, the CLI if
  installed), the sidebar's chats (<profile>/agent-sidebar-tasks.json), and
  the Agents Space …`. Earlier commits, `107f93c` included, don't mention it.
- In the temporary folder (`$TMPDIR`): Node's `node-compile-cache/`, which
  the CLI turns on, and, with the sandboxed CLI, `zenius-sandbox-<uid>/`,
  which holds each run's temporary folder. Both can go.
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
  Run `zenius doctor` and send the manager its output.
- **Zen doesn't open, crashes at startup or hangs.**
  1. If it hangs: force-quit it (⌥⌘⎋, then Zen).
  2. Remove zenius:

     ```bash
     cd ~/zenius && scripts/install.sh --uninstall
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
  leaves zenius on (zen-sdk checked both on the Linux server). Then the user restarts
  Zen. To turn zenius back on, take it out of the list and restart.
- **For the manager.** Send `zenius doctor --json` and the Browser Console's
  `[zenius]` lines (⌘⇧J in Zen).

## Updating later

The install's steps, with the newly approved commit as `<commit>`. zen-sdk
rehearsed them on the Linux server (2026-11-20), from main `aa7d027` to
`zen-core/lazy-methods` `040a271` and back, with the sandboxed CLI, step 8
done, and an agent's task left open across the update. And again
(2026-11-21) for the update that brings the agent's sidebar, from
`cbac1ef` to `fe3bce9`, then Undo and back to `cbac1ef`, with the user's
own sidebar and a Work chat that resumed in its own task. And for the
update after `107f93c`, from `107f93c` to `99cdc39` and back, with Work
chats before and after it.

1. Rerun the block in "1. Get the code". It checks out `<commit>` and
   reruns `npm ci`, with Node 24 in front.
2. Reinstall the CLI, with Node 24 in front. `--sandbox` and `--output-dir`
   aren't needed again: a later install keeps both.

   ```bash
   PATH=/opt/homebrew/opt/node@24/bin:$PATH scripts/install-cli.sh --skill
   ```

   With the sandboxed CLI, expect:

   ```
   note     ~/.local/bin/zenius is the sandboxed launcher, and this install keeps it (--no-sandbox makes it a link again)
   built    sdk/dist/zenius.mjs
   installed ~/.zenius/cli: zenius <version>, commit <commit>
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

   On the update that first passes the sidebar's task id through the
   launcher (`ZENIUS_TASK_SPACE`, for a resumed chat's `zenius mcp`), the
   launcher's line reads `updated  ~/.local/bin/zenius: the sandboxed
   launcher`: install-cli.sh rewrites the launcher whenever its text
   changes. The launcher stays sandboxed, with one more variable passed in.

   Until step 5, agents run the new CLI against the old runtime. That works
   while both speak the same protocol, and doctor's full check (outside the
   sandbox) adds `Installed from commit <old>; this CLI is from <commit>.`
3. Stop every dev Zen on the Mac and check that none is left, as in the
   install's step 5: one that runs makes the reopen in step 5 fail. Then
   the user quits Zen. As in the install's step 5, the manager asks the
   user first, and you don't go on until the user says it's done.
4. Install the runtime:

   ```bash
   scripts/install.sh --disable-ipv6
   ```

   Expect lines 1 and 2 of the install's step 3, then:

   ```
     no running Zen has this profile open
     backed up the zenius files it replaces to /Users/<user>/.zenius/backups/<UTC time>
     wrote <n> files in the profile (listed in /Users/<user>/.zenius/install.json)
     network.dns.disableIPv6 is already true in user.js
   Done. The next time Zen starts, it will load zenius <version>.
   ```

   Run without `--disable-ipv6`, the install leaves `user.js` as it is, and
   that line reads `network.dns.disableIPv6 stays true in user.js, from an
   earlier install with --disable-ipv6; uninstall restores its previous
   value`: nothing changes for the user. A commit before `77d83f5` doesn't
   know the flag: its `install.sh` prints only `install.sh: unknown
   argument: --disable-ipv6 (see --help)` and changes nothing. Run it
   without the flag; it sets the pref unasked.

   On the update that first brings the agent's sidebar, one more line
   follows the backup's:

   ```
     backed up the profile's own agent-sidebar to /Users/<user>/.zenius/backups/<UTC time>; zenius's takes its place, and uninstall puts it back
   ```

   The count in `wrote <n> files` includes the agent's scripts: the sidebar
   and the address bar's '>' dispatch. If the user's own installer put their
   sidebar back over zenius's since the last install, the line reads `backed
   up the profile's own agent-sidebar (changed since zenius installed it) to
   …`: that copy is now the one Undo puts back.

   A `Warning: another Zen from the same app is running. …` line after
   `Done.` means a dev Zen started since step 3: stop it before step 5.

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
   (zenius.agentSidebar.allowCodex = false)` instead. `99cdc39`'s doctor
   speaks of Codex only once the pref is true: `Codex is allowed
   (zenius.agentSidebar.allowCodex = true): it can read local files, so it
   isn't browser-only`. Either way, it's the user's choice, not a fault. A
   `zenius.agentSidebar.allowUnknownAgents` warning on the I4 line is a
   test's pref: ask the user before resetting it, as for the other
   test-only prefs. The `agents' page code` line is information, not a
   check: `always (the default); no allowed sites listed` until the user
   chooses `ask` or `never` (see "Later, if needed").

### Going back to the previous version

`scripts/install.sh --uninstall` removes zenius; it doesn't bring back the
version an update replaced. To go back to that version, read its commit
from the backup the update made:

```bash
cd ~/zenius
backup=$(sed -n 's/^  "backup": "\(.*\)",$/\1/p' ~/.zenius/install.json)
echo "backup: ${backup:-none}"
if [ -f "$backup/chrome/JS/zenius/install.json" ]; then sed -n 's/^  "commit": "\(.*\)",$/\1/p' "$backup/chrome/JS/zenius/install.json"; fi
```

Expect `backup: /Users/<user>/.zenius/backups/<UTC time>`, then a commit:
the version the last install replaced. Run "Updating later" with that
commit as `<commit>`, and its step 4 without `--disable-ipv6` if the commit
comes before `77d83f5`; after the reopen, doctor's `zenius runtime` line
shows it. `backup: none`, or a backup with no commit after it (it holds only the
first install's `user.js`), means the last install replaced no version,
since it was the first: going back then means "Undo".

Don't copy the backup into the profile by hand. `install.sh` at that commit
writes the same files the backup holds (zen-sdk compared them: identical
but for `installedAt` in `install.json`). It also checks that Zen is closed,
backs up the version it replaces, and keeps `~/.zenius/install.json` right,
which a copy doesn't. The CLI has no backup, so only the checkout can put
back its earlier version.

To go back from the update that first brought the agent's sidebar (to
`cbac1ef`), run "Undo" with the current checkout first, which puts the
user's own sidebar back. Then run "Updating later" with `cbac1ef`. Its
step 2 prints `updated  ~/.local/bin/zenius: the sandboxed launcher` again:
`cbac1ef`'s launcher doesn't pass `ZENIUS_TASK_SPACE`, so the text changes
back. `cbac1ef`'s `install.sh` alone would leave zenius's sidebar and '>'
dispatch in place, since it doesn't know them. While zenius is installed, keep
`~/.zenius/components.prior` and the backup folder it names: Undo gives the
user's sidebar back from them, even after later updates.
