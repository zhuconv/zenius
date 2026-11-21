// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Ego's e2e case page-shadow-dom.mjs, ported to tests/input/harness.mjs (Ego's Page
// API over zenius RPC). Edits from Ego's text are marked "zenius:".

export async function pageShadowDomCase(h) {
  const { taskSpace, taskName, newPageAt, baseUrl, assert, assertEqual, assertIncludes, assertRejects, assertRejectsAny, wait } = h;
  const { scrollingActionTimeout, artifactDir, join, readFile } = h;
  const task = await taskSpace(taskName);
  const page = await newPageAt(task, baseUrl + "/?page=shadow-dom");
  try {
    const snapshot = await page.snapshot({ scope: "full_page" });
    assertIncludes(snapshot, "Shadow field", "snapshot exposes the shadow input");

    await page.fill('loc=css:input[aria-label="Shadow field"]', "shadow value");
    assertEqual(
      await page.evaluate(() =>
        document
          .querySelector("#shadow-fixture")
          .shadowRoot.querySelector('input[aria-label="Shadow field"]')
          .value
      ),
      "shadow value",
      "snapshot-style CSS locators resolve inside an open shadow root"
    );

    await page.click("#shadow-action");
    assertEqual(
      await page.evaluate(() =>
        document
          .querySelector("#shadow-fixture")
          .shadowRoot.querySelector("nested-shadow-fixture")
          .shadowRoot.querySelector("#shadow-action")
          .dataset.clicked
      ),
      "true",
      "raw CSS selectors resolve controls inside nested open shadow roots"
    );
  } finally {
    await page.close();
  }
}
