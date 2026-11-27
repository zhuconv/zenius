# Signing in

Read this file before you sign in on a site as another of the user's accounts. Every task space runs in the user's own Zen profile, so signing in in a task's tab signs in the user's own tabs on that site too.

## The user's tabs keep their account

Some sites, such as Google, keep several accounts signed in at once. Most keep one at a time for the whole browser: signing in as another account signs every tab of the user's on that site out of the account they use.

- Where the site keeps both accounts signed in, use its own account switcher. Nothing needs undoing.
- Where the user keeps that account in a Zen container (`profiles()` lists them), make the task in it: `taskSpace(name, { profileId })`. Its tabs don't share the user's other tabs' sign-ins.
- Otherwise, switch back when you're done:
  1. Before you switch, note the account the user's tabs use there, as the site shows it (often an email): `await task.noteAccount({ site: "claude.ai", account: "c@example.com" })`. `site` is the site's bare host.
  2. Sign in as the other account, take the step, and sign back in as the noted one. Keep it short, in one script where you can: until then, the user's own tabs on that site are on the other account.
  3. Then `await task.noteAccount({ site: "claude.ai", restored: true })`.

If signing back in needs the user, such as a password Zen doesn't have or a code from their phone, hand off with `sign_in` at the end, or say so in your last message.

zenius keeps the notes with the task, across a Zen restart. After one, switch back first: `listTaskSpaces()` lists the task's notes as `accountsToRestore`. When a task ends with one left, Zen tells the user that their tabs on that site may be on another account. zenius doesn't check the switch: it keeps what you note.
