// Prefs for hold-probe.mjs's second map: zen-core's COOP group switch at a
// hand-off, written and tested but off until the user decides on the
// isolated world (zenius.handoff.groupSwitch). Use a profile of its own:
// prefs.js keeps the value after a restart without this file.
//   ZENIUS_DEV_PREFS=tests/snapshot/tools/hold-prefs.js scripts/zen-dev.sh zen-snapshot-coop start
user_pref("zenius.handoff.groupSwitch", true);
