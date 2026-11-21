// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Ego's e2e case page-oopif.mjs, ported to tests/input/harness.mjs (Ego's Page
// API over zenius RPC). Edits from Ego's text are marked "zenius:".

export async function pageOopifActionCase(h) {
  const { taskSpace, taskName, newPageAt, baseUrl, assert, assertEqual, assertIncludes, assertRejects, assertRejectsAny, wait } = h;
  const { scrollingActionTimeout, artifactDir, join, readFile } = h;
  const task = await taskSpace(taskName);
  const page = await newPageAt(task, baseUrl + "/?page-api=oopif");
  const initialFrameState = await page.evaluate(() => {
    const frame = document.querySelector("#fixture-frame");
    frame.style.cssText =
      "display:block;margin-top:1600px;width:500px;height:300px";
    window.__rootWheelEvents = [];
    window.addEventListener(
      "wheel",
      (event) => window.__rootWheelEvents.push({
        deltaY: event.deltaY,
        trusted: event.isTrusted,
      }),
      { passive: true }
    );
    return {
      frameTop: frame.getBoundingClientRect().top,
      viewportHeight: innerHeight,
    };
  });
  assert(
    initialFrameState.frameTop > initialFrameState.viewportHeight,
    "the cross-site iframe starts below the viewport"
  );
  const snapshot = await page.snapshot({ scope: "full_page" });
  assertIncludes(snapshot, "Run iframe action", "snapshot includes cross-site iframe content");
  assertIncludes(snapshot, "Iframe field", "snapshot includes the iframe input");
  await page.click('loc=role:button[name="Run iframe action"]', { timeout: scrollingActionTimeout });
  await page.fill('loc=css:#iframe-field', "filled through Page", { timeout: scrollingActionTimeout });

  const outerScrollState = await page.evaluate(() => ({
    scrollY,
    wheelEvents: window.__rootWheelEvents,
  }));
  assert(outerScrollState.scrollY > 0, "Page actions scroll the iframe owner into view");
  assert(
    outerScrollState.wheelEvents.length > 0 &&
      outerScrollState.wheelEvents.every((event) => event.trusted),
    "the outer document receives trusted wheel input"
  );

  // zenius: no CDP targets; read the cross-site frame through its own process.
  const js = code => h.frameJs(page, "/frame.html", code);
  assertEqual(
    await js("return document.querySelector('#iframe-result')?.textContent"),
    "clicked:true",
    "Page.click dispatches a trusted click in the iframe session"
  );
  assertEqual(
    await js("return document.querySelector('#iframe-field')?.value"),
    "filled through Page",
    "Page.fill writes through the iframe session"
  );

  const sameOrigin = await newPageAt(task, baseUrl + "/same-origin-frame");
  assertIncludes(
    await sameOrigin.snapshot({ scope: "full_page" }),
    "Run iframe action",
    "snapshot includes same-process iframe content"
  );
  await sameOrigin.evaluate(() => {
    const frame = document.querySelector("#fixture-frame");
    frame.style.cssText =
      "position:fixed;left:20px;top:80px;width:500px;height:300px;z-index:20";
    const covered = document.createElement("button");
    covered.id = "covered-frame-duplicate";
    covered.textContent = "Run iframe action";
    covered.style.cssText =
      "position:fixed;left:100px;top:120px;width:220px;height:60px;z-index:10";
    covered.addEventListener("click", () => covered.dataset.clicked = "true");
    document.body.append(covered);
  });
  await sameOrigin.click('text="Run iframe action"', {
    timeout: scrollingActionTimeout,
  });
  await sameOrigin.fill('loc=css:#iframe-field', "same process", {
    timeout: scrollingActionTimeout,
  });
  const sameOriginState = await sameOrigin.evaluate(() => {
    const frame = document.querySelector("#fixture-frame");
    return {
      coveredClicked: document.querySelector("#covered-frame-duplicate")?.dataset.clicked,
      result: frame?.contentDocument?.querySelector("#iframe-result")?.textContent,
      value: frame?.contentDocument?.querySelector("#iframe-field")?.value,
    };
  });
  assertEqual(
    sameOriginState.coveredClicked,
    undefined,
    "the covered top-document duplicate is not clicked"
  );
  assertEqual(sameOriginState.result, "clicked:true", "Page.click works in a same-process iframe");
  assertEqual(sameOriginState.value, "same process", "Page.fill works in a same-process iframe");
  await sameOrigin.close();
  // zenius: the next case is a later round on the same Page.
  return { label: page.label };
}

export async function pageOopifRestoreCase(h, saved) {
  const { taskSpace, taskName, newPageAt, baseUrl, assert, assertEqual, assertIncludes, assertRejects, assertRejectsAny, wait } = h;
  const { scrollingActionTimeout, artifactDir, join, readFile } = h;
  const task = await taskSpace(taskName);
  const page = task.page(saved.label);
  const snapshot = await page.snapshot({ scope: "full_page" });
  assertIncludes(snapshot, "Run iframe action", "a later round observes the iframe");
  await page.click('text="Run iframe action"');

  // zenius: no CDP targets; read the cross-site frame through its own process.
  assertEqual(
    await h.frameJs(page, "/frame.html", "return document.querySelector('#iframe-result')?.textContent"),
    "clicked:true",
    "the restored Page routes the iframe action to the child session"
  );
  // zenius: that a closed Page's handle rejects is the SDK's check (zen-sdk).
  await page.close();
}
