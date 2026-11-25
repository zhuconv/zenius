// Loaded before every SDK test file (package.json's --import): each test
// process starts with a scratch HOME and ZENIUS_HOME (tests/lib/scratch-home.mjs),
// so nothing a test runs in-process or spawns reaches the account's own
// ~/.zenius/config.json or ~/zenius-files. A test that needs another home
// still passes its own, and runCli's guard refuses the real one.

import { scratchHome } from "../../tests/lib/scratch-home.mjs";

const scratch = scratchHome("sdk");
process.env.HOME = scratch.home;
process.env.ZENIUS_HOME = scratch.zeniusHome;
process.on("exit", () => scratch.remove());
