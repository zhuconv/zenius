// Method modules the service loads, in order. A later module replaces a
// method an earlier one defined, and the log says so. Missing files are
// skipped, so every planned module is listed already; add a line only for a
// new module.
export const methodModules = [
  "browser", // zen-core
  "spaces", // zen-core
  "pages", // zen-core
  "events", // zen-core
  "dev", // zen-core: dev.* (only on a dev profile: readSettings)
  "navigation", // zen-observe
  "observe", // zen-observe
  "io", // zen-observe
  "snapshot", // zen-snapshot
  "actions", // zen-input
  "ui", // zen-ux
  "sidebar", // zen-observe: remote tasks, in zen-ux's sidebar
  "feedback", // zen-core: zenius feedback's report, for the sidebar's card
  "calls", // zen-runtime: calls.cancel, a client's request it gave up on
  "script", // zen-runtime: script.begin and script.end, a script tool call's step
];
