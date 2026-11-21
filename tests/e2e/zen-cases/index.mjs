// Cases zen-eval adds to Ego's suite, run after Ego's 83 and reported apart.
// `targets` limits a case to the targets it applies to; elsewhere it is N/A.
import { v2ControlLifecycleCase } from "./control-lifecycle.mjs";
import { pdfjsViewerDownloadCase } from "./pdfjs-download.mjs";
import { serviceWorkerRefusedCase } from "./service-worker-refused.mjs";
import { v2NaCoverageCase } from "./v2-na-coverage.mjs";

export const zenEvalCases = [
  { name: "zen-eval: v2 control lifecycle", body: v2ControlLifecycleCase, origin: "zen-eval" },
  { name: "zen-eval: v2 checks from N/A cases", body: v2NaCoverageCase, origin: "zen-eval" },
  {
    name: "zen-eval: pdf.js viewer download",
    body: pdfjsViewerDownloadCase,
    origin: "zen-eval",
    // Ego's counterpart is "Page Chromium PDF viewer download".
    targets: ["zenius"],
  },
  {
    name: "zen-eval: a task's service worker is refused",
    body: serviceWorkerRefusedCase,
    origin: "zen-eval",
    // Ego's counterpart is "Page Service Worker startup".
    targets: ["zenius"],
  },
];
