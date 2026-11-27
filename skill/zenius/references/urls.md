<!-- Written from zenius's sources by sdk/scripts/write-references.ts: change those, then run it. -->

# URLs

Which URLs agents may load, and the pages where they can't act. The MCP tools open and goto take only http: and https: URLs. A script's page.goto() takes every URL that ZEN_URL_NOT_ALLOWED below allows.

### ZEN_URL_NOT_ALLOWED

Agents load only http:, https:, data:, blob: and about:blank URLs, never browser, local or add-on pages (data.url, data.scheme).

Next: Load a web page instead; if the task needs this one, ask the user to open it.

### ZEN_PAGE_NOT_WEB_CONTENT

The page, or a frame in it, shows a browser, local, add-on or error page, where agents can't act (data.url).

Next: Load a web page with page.goto(), or hand the task to the user with task.handOff().

### ZEN_SIGN_IN_PAGE

The page is the user's sign-in (data.reason, data.page). "authorization_response": its address, or the address it came from, carries the code of a sign-in, which with the right key is the user's account, so zenius reads and does nothing there: no snapshot, text, screenshot, code or input, and its title, console and requests aren't reported. "device_login": a provider's page for typing a device code, which you may read but not type into or click. "consent": a provider's consent screen, where only the user grants an app access to their account: you may read it, but not click or type there. "one_time_code": a field for a one-time code, on a site with no visit in the user's history from before this task: only the user enters the code there, and after the refusal you may read that page but not act on it.

Next: By data.reason. "authorization_response" is a sign-in's last step, yours included: wait for the site to move on (most send you back to the app at once), or go to the app's own URL again with page.goto(). "device_login" and "consent" are the user's: hand the page to them with task.handOff() if the task needs that step, and never type a device code or grant an app access yourself. "one_time_code": hand the page to the user with task.handOff({ reason: "sign_in" }).

## Refused without an error

Nothing throws for these: the page gets the answer it already handles, and the action's receipt lists the kind in refused.

### localNetwork

The page, or a blob: shared worker of its site, tried to reach a private or link-local address or a .local name, or the page tried to start WebRTC, which reads local addresses: refused in a task's pages, since macOS's consent for the local network would cover the user's whole browser. Loopback stays open; new RTCPeerConnection() throws NotAllowedError. A shared worker from a data: URL is refused too (SecurityError): its requests name no site, so zenius couldn't keep them from the local network.

Next: Your own load of that host just fails. If the task needs it, call task.handOff({ message }) with what the user must do, such as "Open 10.0.0.1 in this tab", or ask in your reply. When the user types the address in your tab, its card offers Open it yourself, which opens it in a tab of theirs, and Add to allowlist, which lets every agent tab reach that host and loads it in your tab for you after Resume agent. Mention the allowlist only as the way to let you do the step yourself. You can't see the user's own tab, so ask for anything you need back, such as a confirmation or a value. An allowlist entry is removed in about:config (zenius.agentTabs.allowPrivateNetworks). WebRTC (calls) works only in the user's own tab.

### externalApp

A link tried to open another app (mailto:, zoommtg:, …): nothing opened.

Next: If the user should open it, tell them the link.
