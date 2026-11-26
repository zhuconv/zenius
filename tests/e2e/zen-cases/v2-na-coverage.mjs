// The eval harness's own case, not Ego's. Three of the cases zenius marks N/A (they
// drive Ego's v1 helpers) also check v2 behaviours that no counted case
// covers:
// - "keyboard regression": fill on email, number and React-style controlled
//   inputs, and xpath= in fill, press and setInputFiles;
// - "pointer and scroll helpers": an xpath= click and a right-click;
// - "target-scoped event isolation": a page reaches network idle while
//   another tab keeps fetching.
// This checks them with the v2 API on the fixture's home page. It must pass
// on Ego to count.
export function v2NaCoverageCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?v2-na-coverage=" + Date.now());
    const value = (id) => page.evaluate((i) => document.getElementById(i).value, id);
    const state = (key) => page.evaluate((k) => window.__fixtureState[k], key);
    // Most targets are below the fold, and fill and click wheel-scroll them
    // into view: Ego's budget for that (see scrollingActionTimeout).
    const act = { timeout: scrollingActionTimeout };
    let other;
    try {
      await page.fill("#email-input", "marcus.hale@example.com", act);
      assertEqual(await value("email-input"), "marcus.hale@example.com", "fill replaces a type=email value");
      await page.fill("#number-input", "456", act);
      assertEqual(await value("number-input"), "456", "fill replaces a type=number value");
      await page.fill("#controlled-input", "hello-react", act);
      assertEqual(await value("controlled-input"), "hello-react", "fill persists on a React-style controlled input");
      const mirrored = await page.evaluate(() => document.querySelector("#controlled-state").textContent);
      assert(mirrored.startsWith("hello-react"), "the controlled component's state mirrors the fill");

      await page.fill('xpath=//input[@id="text-input"]', "via-xpath", act);
      assertEqual(await value("text-input"), "via-xpath", "fill resolves an xpath= selector");
      await page.press('xpath=//input[@id="text-input"]', "Enter");
      assertIncludes((await state("keys")).join(","), "Enter", "press resolves an xpath= selector");
      await page.setInputFiles('xpath=//input[@id="file-input"]', uploadPath);
      const files = await page.evaluate(() => Array.from(document.querySelector("#file-input").files, (f) => f.name).join(","));
      assertEqual(files, "fixture-upload.txt", "setInputFiles resolves an xpath= selector");

      const clicks = await state("clicks");
      await page.click("xpath=//*[@id='click-button']", act);
      assertEqual(await state("clicks"), clicks + 1, "click resolves an xpath= selector");
      // A right click Ego sends through CDP can open Chromium's native context
      // menu on the user's screen. The zone's own handler cancels it there;
      // this capture listener cancels it on any other target, without
      // stopping the event before the zone sees it.
      await page.evaluate(() => document.addEventListener("contextmenu", (e) => e.preventDefault(), true));
      await page.click("#context-menu-zone", { button: "right", ...act });
      assertEqual(await state("rightClicked"), true, "a right-click reaches the page's contextmenu handler");

      // This tab keeps a slow fetch in flight; another tab must still go idle.
      await page.evaluate(() => {
        window.__pulse = setInterval(() => fetch("/api/slow?ms=2000&pulse=" + Date.now()).catch(() => {}), 50);
      });
      other = await task.newPage();
      const startedAt = Date.now();
      await other.goto(baseUrl + "/secondary?v2-na-idle=" + Date.now(), { waitUntil: "networkidle", timeout: 4000 });
      const idleMs = Date.now() - startedAt;
      assert(idleMs < 2500, "another tab's fetches don't keep a page from network idle (" + idleMs + " ms)");
    } finally {
      await page.evaluate(() => clearInterval(window.__pulse)).catch(() => {});
      await other?.close().catch(() => {});
      await page.close().catch(() => {});
    }
  `;
}
