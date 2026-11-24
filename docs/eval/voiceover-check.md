# VoiceOver check: zenius's cards (about 5 minutes)

A listening script for zen-eval's hands-on VoiceOver check with the user.
The headless a11y suite (`tests/ux/a11y.test.mjs`) checks the same names,
order and announcements, but without a screen reader, so a person listens
once. zen-ux wrote this script from that suite.

The user turns VoiceOver on and off themselves (Cmd+F5). Nothing here
turns it on, changes VoiceOver's settings or touches the system clipboard.

## How to listen

- **Announced cards** speak once, when they appear. The keyboard focus and
  VoiceOver's cursor stay where they were.
- **No card takes the focus.** The user reaches one with **Tab from the
  page**, or **Shift+Tab from the address bar** (Cmd+L first). This works
  with macOS's Keyboard navigation off too. The main (filled) button comes
  first.
- **On the first button**, VoiceOver says the button's name ("…, button"),
  then, after a short pause, the card's whole text: title, detail and line.
  The text is the button's description, which VoiceOver reads as its hint
  (on by default; VO+Shift+H reads it again). A countdown in it ("it
  resumes in 7 s", "denied in 9 min") is current when you reach the button, and
  doesn't update every second while you stay there. In the tasks panel, a
  row's buttons and tabs are described by their task's name the same way.
- **Pressing:** Space or Return (or VO+Space) presses the button. A button
  that closes its card gives the focus back to where it came from: the page
  or the address bar.
- **A pass needs all of these:**
  - each announcement is heard once, in full, without the focus moving;
  - every button is reached and named;
  - nothing is read again while a countdown runs;
  - routine agent actions (its clicks, typing, page loads) say nothing.

## Order

One task in the Agents Space, its page in view: rows 1 to 5 in turn, then
a page the agent made (6), a new task for the finish (7), and the claim
(8). Never press Add to allowlist: it would write the allowlist.

| # | Card | How it comes up | VoiceOver says when it appears | Keys | Pass |
|---|---|---|---|---|---|
| 1 | Agent paused | The user clicks in the agent's page while it works (or types: "You're taking over · in … s") | Nothing: it answers their own click | Tab from the page: Take over, Resume agent | Each named, with "Agent paused, it resumes in N s" current when reached; Resume agent gives the agent back |
| 2 | You're in control | Take over on row 1 | Nothing: their own choice | Tab from the page: Resume agent | "You're in control, the agent waits until you resume it, on <site>" heard with the button. Keep it for row 3 |
| 3 | Network access denied | In row 2's hold: Cmd+L, type `http://lan.local/` (the scheme, so it's never a search), Return. zen-observe refuses it before any lookup; nothing leaves the Mac | "Network access denied: lan.local. The current network policy doesn't allow agents to access lan.local. It's on your local network; Add to allowlist lets every agent tab reach it, until you remove it." | Tab from the page: the hold's Resume agent, then Open it yourself, Add to allowlist, Dismiss | Heard once, with the host. Dismiss closes it and the focus is back in the page. Then Resume agent |
| 4 | Agent needs you | The agent sets its state text ("Log in to continue", `spaces.setState`) and calls `task.handOff()`. The user may be in their own Space | "Agent needs you in <task>, on <site>. The agent says: “Log in to continue”." | Open the task's tab (panel: Open), then Tab from the page: Resume agent | Heard once, wherever the user is in the window, with no focus move. The button's hint is the card's text, the agent's words included |
| 5 | The Resume line | In row 4's hold, on a page with a password field: type a letter in it | Nothing: their own typing | Tab from the page: Resume agent | The hint now starts "Agent needs you, <task>, on <site>. Resume agent clears password, card and code fields, so submit what you type there first.", then the agent's words. Resume agent gives the agent the tab |
| 6 | The agent made this page | A new task: the agent goes to `data:text/html,<input>` and finishes with that page kept (`task.finish({ keep: ["p1"] })`). The user opens it and clicks in the field | "The agent made this page. It might contain malicious code. Keep sensitive information out." | Tab from the page: Dismiss | Heard once, with no focus move. Dismiss closes it, focus back in the page |
| 7 | Task finished (closing tab) | A new task with pages p1 and p2, finished with `task.finish({ keep: ["p1"] })` while the user views p2 | "Task finished: <task>. This tab closes when you leave it." | Tab from the page: Keep tab, Close now | Heard once. Keep tab makes the tab theirs and the card goes |
| 8 | Claim prompt | An agent calls `claimTaskSpace(<id>)` on one of the user's Spaces | "Agent request. An agent asks to work in your Space “<name>”. It calls itself “<client>”." | Tab from the page: Allow, Deny | Heard once. The countdown in the card's name ("denied in N min") is current when reached. Deny closes it |

Pages the task leaves open say nothing else: a page kept at the finish, or
left by the panel's Stop, has no card, by design.

## Report

For each row: pass or fail, and for a fail, what VoiceOver said instead
(quoted) and where the focus went. Send it to zen-ux.
