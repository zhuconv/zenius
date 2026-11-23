# No preemption (SPEC I1): agents don't take the browser from the user

SPEC §1 goal 3 says an agent never changes the user's selected tab, active
Space, window focus, keyboard focus or OS cursor. Invariant I1 adds that it
never focuses or raises a window. This file records what each browser did
to the user's view while an agent worked, Ego Lite against zenius, on the
user's Mac (rubric D, SPEC §6).

The evidence is taken so that nothing of the user's is read:

- **Windows:** CoreGraphics' list of all windows
  (`CGWindowListCopyWindowInfo`), sampled about every half second. Each
  sample keeps the owner's name and pid, and each window's number, layer,
  size and on-screen flag. It records no window titles and takes no screen
  captures.
- **The app in front:** `lsappinfo`.
- **The pasteboard:** its `changeCount` only, never its contents.

## 2026-11-20: Ego put its main window on screen during a dialog case

zen-input's gap probe (`tests/input/probes/ego-gaps.mjs`, as it was on
2026-11-20) ran through `ego-browser nodejs` against
the user's running Ego Lite.
- It used one task space of its own, in the background, and the user wasn't
  at the Mac.
- The run lasted 173 s, from 14:13:33 UTC. The windows were sampled 318
  times.

What the samples show:

- **Before:** none of Ego's 16 windows was on screen, at 14:12:45 and again
  at 14:13:33.5.
- **14:13:39.3:** a 448x144 Ego window appeared, off screen.
  - It lasted as long as case E, "actions while a dialog is already open".
  - In that case an `alert()` stayed open while the probe sent seven
    actions, each still pending after 3 s.
- **14:14:24.7:** the alert's window was still there, about 45 s after it
  opened. Ego's main window had been off screen at 1920x1050 until the
  sample before (14:14:23.9). Now it was 1882x1030, still off screen.
- **14:14:25.7:**
  - The alert's window was gone, and the probe had started the next case,
    a middle click on a link (D3).
  - Ego's main window was on screen at 1440x903: the built-in display's
    whole visible area.
  - A 320x88 Ego window, off screen until then, was on screen too.
- **After the run:**
  - Both windows were still on screen (14:16:45).
  - A minute later, `lsappinfo` listed Ego as the app in front.
  - Ego's task spaces were back to the user's id 0 alone.

So the main window started to move during case E. At that point the agent's
alert had been open for about 45 s, with its actions pending. The window
reached the screen within the next second, as the middle-click case
started. The samples can't tell what in that second set it off. It could be
any of these:
- something Ego does about a dialog left open, or about input waiting
  behind one;
- the dialog's dismissal;
- the start of the middle click.

**What can't be proven:**

- **Whether Ego was already the frontmost app before the run.** This can't
  be proven either way.
  - macOS logs no activation time, and the app in front wasn't recorded
    before the run.
  - All of Ego's windows were off screen until 14:14:24. That fits Ego not
    being in front, but an app can be in front with no window on screen.
- **Whether a display change played a part.** The window moved to the
  built-in display, and an external display was still attached after the
  run. But the displays weren't listed before the run. WindowServer left no
  display entries in the system log over the previous 12 hours either, so
  the log can't settle this.

**Ruled out:**

- **A native dialog:** no file-panel window appeared. Ego cancelled the two
  choosers that nobody waited for before the system dialog appeared.
- **A new window:** when the run started, Ego replaced its off-screen task
  window with a new one of the same size. That one stayed after the task
  finished, as the old one had. So Ego had as many windows after the run as
  before.
- **The pasteboard:** its `changeCount` didn't change.

**zenius, same probe.** A fresh headless dev instance at main as of 2026-11-20 14:07 UTC ran
all 35 cases in 30 s.

- In case E, every action settled within 1 ms, so no input waited behind
  the alert.
  - `click`, `hover`, `fill`, `mouse.click` and `keyboard.press` were
    refused with `ZEN_PAGE_DIALOG_OPENED`.
  - `mouse.move` and `keyboard.type` returned.
  - By design, zenius intercepts an agent tab's dialogs before Firefox shows
    them: no dialog box, no focus move, no tab switch.
- The middle click left no new tab. The task kept its two pages. Afterwards
  the instance's only tab was its initial blank tab, still selected in the
  active workspace.
- A headless run can't show a window coming forward. `tests/core/i1.test.mjs`
  covers neither a dialog nor a middle click. The headed run of cases E and
  D3 on zenius, with the same sampler, is in the next section.

## 2026-11-20: zenius, cases E and D3 headed: no window came forward

The same probe, with every case but E and D3 skipped, ran through
`sdk/bin/zenius nodejs` against a headed dev instance on the Mac, at main
as of 2026-11-20 16:06 UTC. The user was at the Mac, working in other apps.

**How it was watched:**

- the window sampler above, every half second;
- `lsappinfo front` every half second, and once just before and once just
  after the cases;
- a watcher that read the app in front every 0.1 s. When a dev Zen was in
  front, the watcher logged it and gave the front back to the app that had
  been in front just before.
  - A headed dev Zen takes the front when it launches: `zen-dev.sh` starts
    the binary directly, not through LaunchServices.
  - The cases started 3 s after the launch, once the launch's own
    activation was over.
- the pasteboard's `changeCount`.

Two runs gave the same results:

- the first, 16:08:14–16:08:21 UTC, started the cases right after the
  launch;
- the second, 16:09:44–16:09:51, waited the 3 s.

The second run's samples:

- **16:09:46.6:** the dev window came on screen at launch and took the
  front. The watcher gave the front back to the user's terminal at once.
- **About 16:09:49.7 to 16:09:50.9:** the two cases. The terminal was in
  front just before and just after them, and the watcher logged no
  activation of the dev Zen in that time. An activation lasts until another
  app takes the front, so 0.1 s reads would have caught one.
- **16:09:51.0:** the window closed as the instance stopped.
- No dev-Zen window appeared after the launch, on screen or off.
- The system's alert and file-panel windows stayed off screen.
- The `changeCount` didn't change.
- The user's own Zen ran throughout.

**The results match the headless run:**

- **E:**
  - `click`, `hover`, `fill`, `mouse.click` and `keyboard.press` were
    refused with `ZEN_PAGE_DIALOG_OPENED` within 2 ms.
  - `mouse.move` and `keyboard.type` returned.
  - No dialog box appeared.
- **D3:** the middle click resolved in 23 ms. The page saw `mousedown`,
  `mouseup` and `auxclick`. No page opened, and the task kept its two pages.

So on the Mac, neither case put a zenius window on screen or changed the app
in front. At the same point of the same probe, Ego's main window came on
screen (previous section). The one front change came from launching a headed
dev instance. In real use zenius runs inside the user's Zen, which is
already running, so that change doesn't occur there.

## 2026-11-22: zenius on round 2's build, cases E and D3 headed: a middle click brought Zen to the front

The same probe, at round 2's build (a 0.1.0 pre-release from 2026-11-21), with every case but E and D3
skipped, ran through `sdk/bin/zenius nodejs` against a fresh headed dev
instance on the Mac. The user was at the Mac, with their terminal in front.

**How it was watched:** as on 11-20, with two changes for the second run.

- The watcher logged its times to the millisecond.
- The probe's steps ran 2.5 s apart, each with a wall-clock mark.

Two runs:

- the first, 01:37:47–01:37:54 UTC, ran the probe as on 11-20;
- the second, 01:41:31–01:41:50, was the timed one.

The second run's samples:

- **01:41:30.5:** the dev window came on screen at launch and took the
  front. The watcher gave the front back to the user's terminal at once.
- **01:41:37.48 to 37.55:** case E. Nothing came forward.
- **01:41:40.07:** D3's middle click. It resolved at 40.47, with the link
  open as a new page of the task.
- **01:41:40.58:** the dev Zen came to the front. The watcher gave the front
  back at 40.95. The probe was only waiting at that point.
- **01:41:42.98 to 43.00:** the probe closed the new page. Nothing came
  forward.
- **01:41:48.01 to 48.05:** `finish()`. Nothing came forward.
- **01:41:50.5:** the window closed as the instance stopped.
- No other dev-Zen window came on screen. The system's alert windows stayed
  off screen, the `changeCount` didn't change, and the user's own Zen ran
  throughout.

The first run shows the same activation during D3, at 01:37:53.

**The results:**

- **E:** as on 11-20.
  - `click`, `hover`, `fill`, `mouse.click` and `keyboard.press` were
    refused with `ZEN_PAGE_DIALOG_OPENED` within 3 ms.
  - `mouse.move` and `keyboard.type` returned.
  - No dialog box appeared.
- **D3:** the middle click now opens the link as a new page of the task, as
  on Ego.
  - The click resolved in 400 ms (562 ms in the first run), and its receipt
    listed the new page.
  - The task went from two pages to three.
  - The page saw `mousedown`, `mouseup` and `auxclick`.

**So on round 2's build, a middle click on a link brought Zen to the front,
which I1 rules out.**

- The middle-click change opens the link with Zen's `openLinkIn`.
- In Zen 1.24.3b, `openLinkIn` raises the window it loads into before
  loading ("Raise the target window before loading the URI"), background
  tabs included.
- Inside the browser the user's view stays as it was, and the change's own
  test checks that. The activation is outside the browser: it takes the
  front from whatever app the user is in.
- Nothing else in the probe brought Zen forward. The launch's activation
  doesn't occur in real use (previous section).
- The fix opens the link with `gBrowser.addTab`, which doesn't raise the
  window. Its run follows.

## 2026-11-22: zenius on the release candidate, cases E, D3 and F headed: nothing came forward

The same probe at the 0.1.0 release candidate of 2026-11-22, which has the middle-click
fix. Every case but E, D3 and F was skipped. It ran through
`sdk/bin/zenius nodejs` against a fresh headed dev instance on the Mac,
with the user at the Mac and working.

Case F is new: it checks what no headless test can see.
An agent clicks a button whose handler calls
`window.open("/blank", "zenEvalF", "width=420,height=320")`. A popup with
a size gets a window of its own in Firefox, not a tab, before zenius moves
its tab into the task.

**How it was watched:** as on round 2's build.

- The window sampler ran every half second.
- The focus guard read the app in front every 0.1 s.
- The probe's steps ran 2.5 s apart, each with a wall-clock mark.
- `changeCount` was read every 4 s.

**The run, 03:56:00 to 03:56:30 UTC:**

- **03:56:00.5:** the dev window (1280x812) came on screen at launch. It
  didn't take the front: the user's own Zen was in front from 03:55:55, and
  the focus guard never saw the dev Zen as the app in front.
- **03:56:10.29 to 10.38:** case E. Nothing came forward.
- **03:56:12.91:** D3's middle click. It resolved at 13.07. Nothing came
  forward.
- **03:56:20.79:** F's click. It resolved at 20.87. No new window came on
  screen, and nothing came forward.
- **03:56:27.62:** `finish()`. Nothing came forward.
- **03:56:30:** the window closed as the instance stopped.
- `changeCount` changed once, between 03:56:26 and 03:56:30. The user
  confirmed that was their own copy; the probe uses no clipboard. The
  system's alert windows stayed off screen.

**The results:**

- **E:** as before.
  - `click`, `hover`, `fill`, `mouse.click` and `keyboard.press` were
    refused with `ZEN_PAGE_DIALOG_OPENED` within 2 ms.
  - `mouse.move` and `keyboard.type` returned.
  - No dialog box appeared.
- **D3:** the click resolved in 154 ms, and its receipt listed the new page
  as a popup.
  - The task went from two pages to three.
  - The page saw `mousedown`, `mouseup` and `auxclick`.
- **F:** the click resolved in 75 ms, and its receipt listed the popup.
  - `window.open` returned a window.
  - The task went from two pages to three, the third the popup's page.

**So on the release candidate, nothing an agent did in E, D3 or F brought Zen to the
front or put a window on screen.** The middle-click fix holds on the Mac,
and so does the popup path F added.

- The window sampler reads every half second, so it can't rule out a
  window that lasted less than that.
- The focus guard's 0.1 s reads would still have seen any activation.
