#!/usr/bin/env node
// Stands in for `ego-browser` in runner tests. FAKE_MODE picks a behavior:
//   silent     exit 0 and print nothing, as a launcher that never ran the script
//   nonceless  print a success summary without the run's sentinel
//   honest     print the summary with the sentinel found in the script
import { readFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("ego-browser 0.0.0-fake");
  process.exit(0);
}
const source = readFileSync(0, "utf8");
const mode = process.env.FAKE_MODE || "silent";
if (mode === "nonceless") console.log(JSON.stringify({ ok: true, assertions: 3 }));
if (mode === "honest") {
  const sentinel = /sentinel: "([^"]*)"/.exec(source)?.[1];
  console.log(JSON.stringify({ ok: true, assertions: 3, sentinel }));
}
process.exit(0);
