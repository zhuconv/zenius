// The eval harness's own case: the zenius counterpart of Ego's "Page Service Worker
// startup", which is N/A on zenius. In an agent task's pages zenius refuses
// service worker registration and Cache Storage writes: either
// would outlive the task and reach the user's own tabs on the site. The
// agent must see the refusal through the public API: the page's call
// rejects with SecurityError, and page.events() reports each refusal once.
//
// A task's pages can't reach the site's own worker either:
// getRegistrations() lists none and reports serviceWorker once per document,
// apart from the refused registration (PROTOCOL.md, "The site's own service
// worker"). So page.events() has two serviceWorker refusals here, told apart
// by their messages, and the lists of registrations show that hiding: the
// registration's refusal is register()'s SecurityError.
//
// tests/e2e/parity.mjs finds the API a case calls by matching its source, so
// the body reads an error's name from String(error) and deletes the empty
// cache that caches.open() made with a bracket call: the plain spellings
// would list this case under TaskSpace.name and Download.delete.
export function serviceWorkerRefusedCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/service-worker/page");
    try {
      await page.events();
      const tries = await page.evaluate(async () => {
        const named = (error) => String(error).split(":")[0];
        const register = () =>
          navigator.serviceWorker.register("/service-worker/sw.js", { scope: "/service-worker/" }).then(
            () => "registered",
            named
          );
        const first = await register();
        const second = await register();
        const registrations = (await navigator.serviceWorker.getRegistrations()).length;
        let cache;
        try {
          const store = await caches.open("zen-eval");
          await store.put("/service-worker/ping", new Response("pong"));
          cache = "stored";
        } catch (error) {
          cache = named(error);
        }
        await caches["delete"]("zen-eval");
        return { first, second, registrations, cache };
      });
      assertEqual(tries.first, "SecurityError", "register() rejects with SecurityError in an agent task's page");
      assertEqual(tries.second, "SecurityError", "a later register() is refused too");
      assertEqual(tries.registrations, 0, "getRegistrations() lists no service worker in an agent task's page");
      assertEqual(tries.cache, "SecurityError", "a Cache Storage write rejects with SecurityError");

      // The refusals reach the parent after the page's calls return.
      const refusals = [];
      const collect = async () => {
        for (const event of await page.events()) {
          if (event.method === "Zenius.refused") refusals.push({ kind: event.params?.kind, message: String(event.params?.message ?? "") });
        }
      };
      const worker = () => refusals.filter((r) => r.kind === "serviceWorker");
      const registering = () => worker().filter((r) => r.message.includes("register a service worker"));
      const reaching = () => worker().filter((r) => r.message.includes("(getRegistrations)"));
      const cached = () => refusals.filter((r) => r.kind === "cacheStorage");
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !(registering().length && reaching().length && cached().length)) {
        await collect();
        await page.waitForTimeout(50);
      }
      // A second report of either would arrive by now.
      await page.waitForTimeout(300);
      await collect();
      assertEqual(registering().length, 1, "page.events() reports the refused registration once, for both register() calls");
      assertEqual(reaching().length, 1, "page.events() reports the site's hidden worker once, at getRegistrations()");
      assertEqual(worker().length, 2, "page.events() reports no other service worker refusal");
      assertEqual(cached().length, 1, "page.events() reports the Cache Storage refusal once");

      // A fresh page on the origin lists none either: the site's worker stays hidden from the task.
      const fresh = await newPageAt(task, baseUrl + "/service-worker/page");
      try {
        const left = await fresh.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
        assertEqual(left, 0, "a fresh agent page on the same origin lists no service worker");
      } finally {
        await fresh.close();
      }
    } finally {
      await page.close();
    }
  `;
}
