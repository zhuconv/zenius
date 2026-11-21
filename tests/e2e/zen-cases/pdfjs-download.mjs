// zen-eval's own case: the pdf.js counterpart of Ego's "Page Chromium PDF
// viewer download", which is N/A on zenius because it drives Chromium's
// viewer. Zen opens a PDF link in pdf.js. An agent must be able to read it
// (the snapshot shows pdf.js's page counter), use its toolbar, and save the
// original file, with the download reported to the viewer Page that started
// it, as Ego reports its viewer's download. Gecko only: the selectors are
// pdf.js's.
export function pdfjsViewerDownloadCase() {
  return `
    const task = await taskSpace(taskName);
    const source = await newPageAt(task, baseUrl + "/download-entry");
    const savedPath = join(tempDir, "pdfjs-viewer-download.pdf");
    const served = Buffer.from(await (await fetch(baseUrl + "/api/openai-gpt-4-system-card.pdf")).arrayBuffer());
    const { createHash } = await import("node:crypto");
    const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
    let preview;
    try {
      const pendingPopup = source.waitForEvent("popup", { timeout: 3_000 });
      await source.click("loc=role:link[name='Preview report']");
      preview = await pendingPopup;
      // A new popup's url() can read about:blank until its first navigation
      // commits; the popup receipt cases check that. Here, wait for the PDF.
      await preview.waitForURL("**/api/openai-gpt-4-system-card.pdf", { timeout: 5_000 });
      await preview.waitForSelector("#downloadButton", { state: "visible", timeout: 10_000 });

      // pdf.js writes "(1 of 60)" beside the page label when the PDF has page
      // labels, as Ego's fixture does. Otherwise it writes only "of 2", with
      // the page number in its spinbutton, as for the generated fixture
      // without refs/. Either way, [1] is the page and [2] the page count.
      const counter = async () => {
        const snapshot = await preview.snapshot({ scope: "full_page" });
        return (
          /\\((\\d+) of (\\d+)\\)/.exec(snapshot) ??
          /spinbutton\\b[^\\n]*\\n\\s*text "(\\d+)"\\n\\s*text "of (\\d+)"/.exec(snapshot)
        );
      };
      const waitForCounter = async (page) => {
        const deadline = Date.now() + 10_000;
        let seen = null;
        while (Date.now() <= deadline) {
          seen = await counter();
          // Until the document has loaded, pdf.js's toolbar reads "of 0" (its
          // reset state), while the download button already shows.
          if (seen && Number(seen[2]) > 0 && (page === undefined || Number(seen[1]) === page)) return seen;
          await preview.waitForTimeout(100);
        }
        return seen;
      };
      const opened = await waitForCounter();
      assert(Boolean(opened), "the snapshot shows pdf.js's page counter");
      assert(Number(opened[2]) > 0, "pdf.js loads the PDF within 10 s (its toolbar still reads 'of 0')");
      // Ego's fixture has 60 pages; without refs/ the fixture server serves a
      // generated 2-page PDF.
      assertEqual(
        Number(opened[2]),
        served.length === 1_014_552 ? 60 : 2,
        "pdf.js renders every page of the PDF"
      );
      await preview.click("#next");
      assertEqual(Number((await waitForCounter(2))?.[1]), 2, "a Page click reaches pdf.js's toolbar");

      const pendingDownload = preview.waitForEvent("download", { timeout: 10_000 });
      await preview.click("#downloadButton", { timeout: 10_000 });
      const download = await pendingDownload;
      assertEqual(download.page(), preview, "the download belongs to the PDF viewer Page that started it");
      assertIncludes(download.url(), "/api/openai-gpt-4-system-card.pdf", "pdf.js downloads its source resource");
      assertEqual(download.suggestedFilename(), "openai-gpt-4-system-card.pdf", "pdf.js keeps the source filename");
      assertEqual(await download.failure(), null, "the pdf.js download completes");
      await download.saveAs(savedPath);
      assertEqual(sha256(await readFile(savedPath)), sha256(served), "the saved file is the PDF the server sent");
      await download.delete();
      assertIncludes(await source.url(), "/download-entry", "the source Page stays on the download entry");
    } finally {
      if (preview) await preview.close().catch(() => {});
      await source.close();
    }
  `;
}
