<!-- Portions adapted from citrolabs/ego-lite (MIT License). -->

# Clearing cookies, cache, and storage

Read this file before clearing any cookie, cache, or storage. Every task space runs in the user's own Zen profile: its cookie jar, HTTP cache, and site storage are shared with the user's own tabs and with every other task space. A space created with a container `profileId` shares them with that container's tabs instead. Clearing the wrong thing signs the user out of sites in the browser they use every day, and nothing can bring those sessions back.

## What a script can clear

zenius has no method that clears browser-wide state, and Zen has no DevTools Protocol to send one through. `page.evaluate()` reaches only the Page's own origin:

| In `page.evaluate()`                              | Reaches                                         |
| ------------------------------------------------- | ----------------------------------------------- |
| `localStorage.clear()`, `sessionStorage.clear()`  | this origin's web storage                       |
| `indexedDB.deleteDatabase(name)`                  | one IndexedDB database of this origin           |
| `caches.delete(key)`                              | one Cache API cache of this origin              |
| `document.cookie = "name=; Max-Age=0; path=/"`    | one cookie that scripts can read (not HttpOnly) |

Leave service workers out: the site's run for the user's own tabs, and a task's pages don't use them. To a task's page the site has none, and asking for its registrations only reports a `serviceWorker` refusal.

A session the user wants anonymous, or a site whose stored state is stuck — clear that one origin, then reload:

```js
await page.evaluate(async () => {
  localStorage.clear();
  sessionStorage.clear();
  for (const db of await indexedDB.databases()) indexedDB.deleteDatabase(db.name);
  for (const key of (await globalThis.caches?.keys()) ?? []) await caches.delete(key);
});
await page.reload();
```

## A sign-in wall is no reason to clear

A sign-in wall you can't pass by signing in as one of the user's own accounts (see `references/sign-in.md`), a CAPTCHA, or an account not known to be the user's: call `task.handOff()` with its reason (`sign_in`, or `human_check` for a CAPTCHA) and let the user act. Do not clear state to get past it.

## HttpOnly cookies and whole-site clears need the user

A stale `HttpOnly` cookie cannot be cleared from a script. When one blocks the task, call `task.handOff()` and ask the user to clear that one site: in Zen, the site information button at the left of the address bar, then **Clear cookies and site data**. Say that it signs them out of that site in every Space.

Never ask the user to clear cookies, cache, or history for the whole profile (Settings, Privacy & Security, Cookies and Site Data, **Clear Data**) unless that is exactly what they asked for. It signs them out of every site they use, and you cannot put it back.
