// Method modules the service loads, in order. A later module replaces a
// method an earlier one defined, and the log says so. Missing files are
// skipped, so every planned module is listed already; add a line only for a
// new module.
export const methodModules = [
  "browser", // the core
  "spaces", // the core
  "pages", // the core
  "events", // the core
  "dev", // the core: dev.* (only on a dev profile: readSettings)
  "navigation", // the observe layer
  "observe", // the observe layer
  "io", // the observe layer
  "snapshot", // the snapshot layer
  "actions", // the input layer
  "ui", // the UI
  "sidebar", // the observe layer: remote tasks, in the UI's sidebar
  "feedback", // the core: zenius feedback's report, for the sidebar's card
  "calls", // zen-runtime: calls.cancel, a client's request it gave up on
  "script", // zen-runtime: script.begin and script.end, a script tool call's step
];
