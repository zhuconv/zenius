## What this means for rubric A

In single runs Ego Lite passed 64, 60 and 61 of the 68 rubric-A cases (88–94%).
Only 55 passed in all three runs. Rubric A asks zenius for ≥ 90% under the same
conditions, so the bar is roughly what Ego reaches in a good run here, not 100%.
Flaky cases deserve a second look before they count against zenius.

## What fails on Ego Lite, and why

Ego's repository runs this suite as its pre-push hook (`lefthook.yml`), so it
normally passes where Ego is developed. The failures here most likely come
from conditions on this Mac: task spaces sit in background macOS Spaces, and
the user works alongside. Grouped by cause, with each case's result in runs
1, 2 and 3 (P pass, F fail):

- **Actions on targets below the fold time out** with "element is not
  visible in the viewport":
  - page actions and popup adoption (FFF);
  - Page text locators (PFP), Page open Shadow DOM locators (FPP), Page ref
    identity across partial snapshots (PPF);
  - Page download across rounds: prepare (PFP). Its resume half then fails
    for lack of the prepared state (PFP);
  - the legacy pointer case (PFF, an iframe target).

  Ego scrolls a target into view with wheel input. In the words of Ego's own
  e2e prelude: "While the browser window is covered …, macOS slows its frames
  to about one per second, and Chromium holds the next mouse event's
  acknowledgement for up to a second until the wheel gesture ends." The
  prelude gives three case files a 10 s `scrollingActionTimeout` for that
  reason; these cases keep the 3 s default.
- **Escape never reaches the page** (FFF in page basic operations and in
  Page keyboard interface). `page.keyboard.press("Escape")` is lost, and so
  is an `ArrowDown` sent right after it. Enter, letters and Meta+A arrive.
  The cause isn't known yet.
- **Ego's own latency checks fail under load** (PPF):
  - Page action popup receipts: four fills and a select must finish within
    250 ms; they took 2168 ms.
  - Page action idle fail-fast: a missing target must be rejected within
    2 s; it took 2081 ms.
- **Other timeouts:**
  - Page popup waiter (PFP): `waitForEvent("popup")` timed out at 3 s.
  - Page API alignment (PFP): a `selectOption` error should list the
    options, but instead says the Page didn't answer `Page.getFrameTree`.
  - Page JavaScript dialog handling (PPF): `waitForFileChooser` timed out at
    2 s. The error was thrown from a timer, so it ended the script.
- **Legacy help text** (FFF, v1 runtime case, N/A).
  `help("legacy", "click", "fillInput")` answers "Unknown legacy helper:
  click". The SDK embedded in Ego Lite 0.6.3.17 lacks the legacy JSDoc that
  the v2.2.1 checkout has. No v2 case found any other difference between the
  embedded SDK and tag v2.2.1.
- **Chromium's PDF viewer** (FFF, N/A) never shows its download button
  within 10 s (`cr-icon-button#save`).

zenius's agent tabs also run where the user isn't looking, as background tabs
in other Zen Spaces, so its runs should happen the same way: with the user's
work in front.
