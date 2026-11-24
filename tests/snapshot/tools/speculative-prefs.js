// Prefs for speculative-probe.mjs's dev profile, which speculative-run.sh
// passes through ZENIUS_DEV_PREFS: Gecko's defaults, as Zen ships them, for
// what the dev profiles' scripts/dev/no-outside-traffic.js turns off, so the
// probe meets speculative connections and DNS prefetch as a user's Zen does.
// The run's namespaces keep every packet and lookup on this machine.
user_pref("network.http.speculative-parallel-limit", 20);
user_pref("network.dns.disablePrefetch", false);
user_pref("browser.urlbar.speculativeConnect.enabled", true);
