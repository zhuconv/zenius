// Prefs for every dev and test Zen: nothing of its own goes to an outside
// service. It connects only to what a test loads. zen-dev.sh appends this
// file to each dev profile's user.js on every start, and the I4 tool
// (scripts/idle-cost/run.mjs) to its profiles'. A test that needs one of these
// services sets the pref itself: ZENIUS_DEV_PREFS lines come after these
// and win, or the test sets it with Services.prefs and puts back the value
// it found. A service that must have a server address gets the loopback
// discard port, which refuses at once.
//
// Telemetry and data reporting. Zen locks the legacy telemetry prefs off,
// its server too; these keep them off on a Zen that doesn't. Glean uploads
// on its own: a negative port drops its pings, and usage reporting is a
// ping of its own.
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.usage.uploadEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("toolkit.telemetry.archive.enabled", false);
user_pref("toolkit.telemetry.newProfilePing.enabled", false);
user_pref("toolkit.telemetry.firstShutdownPing.enabled", false);
user_pref("toolkit.telemetry.shutdownPingSender.enabled", false);
user_pref("toolkit.telemetry.updatePing.enabled", false);
user_pref("toolkit.telemetry.bhrPing.enabled", false);
user_pref("telemetry.fog.test.localhost_port", -1);
user_pref("browser.ping-centre.telemetry", false);
user_pref("browser.newtabpage.activity-stream.telemetry", false);
user_pref("browser.newtabpage.activity-stream.feeds.telemetry", false);
// Studies and experiments.
user_pref("app.normandy.enabled", false);
user_pref("app.normandy.api_url", "");
user_pref("app.shield.optoutstudies.enabled", false);
user_pref("messaging-system.rsexperimentloader.enabled", false);
// Captive-portal and connectivity checks.
user_pref("network.captive-portal-service.enabled", false);
user_pref("network.connectivity-service.enabled", false);
user_pref("captivedetect.canonicalURL", "http://127.0.0.1:9/canonical.html");
// Push.
user_pref("dom.push.connection.enabled", false);
user_pref("dom.push.serverURL", "wss://127.0.0.1:9/");
// Remote settings: blocklists, Suggest's data, experiments, the
// intermediate certificates and the rest. A release build ignores a
// services.settings.server override, and away from the production server
// it skips the data it ships with, the search engines' among it. So its
// hosts resolve to this machine instead: each sync fails at once, as when
// offline, and the shipped data stays. A test that maps names of its own
// adds them to this list and puts back what it found. A public page whose
// server sends an incomplete certificate chain fails here, as in a fresh
// Firefox before its first sync.
user_pref("network.dns.localDomains", "firefox.settings.services.mozilla.com,firefox-settings-attachments.cdn.mozilla.net,content-signature-2.cdn.mozilla.net");
// Safe Browsing: no list updates and no remote lookups. The lists
// already in the profile and Gecko's built-in test entries still work.
user_pref("browser.safebrowsing.provider.google.updateURL", "");
user_pref("browser.safebrowsing.provider.google.gethashURL", "");
user_pref("browser.safebrowsing.provider.google4.updateURL", "");
user_pref("browser.safebrowsing.provider.google4.gethashURL", "");
user_pref("browser.safebrowsing.provider.google5.updateURL", "");
user_pref("browser.safebrowsing.provider.google5.gethashURL", "");
user_pref("browser.safebrowsing.provider.mozilla.updateURL", "");
user_pref("browser.safebrowsing.provider.mozilla.gethashURL", "");
user_pref("browser.safebrowsing.downloads.remote.enabled", false);
// DNS over HTTPS, and its rollout's canary lookups.
user_pref("network.trr.mode", 5);
user_pref("doh-rollout.disable-heuristics", true);
// DNS prefetch: Gecko looks up the host of every link on a page it shows,
// Firefox's own pages included (about:compat links to hundreds of Bugzilla
// bugs), though nothing loads them.
user_pref("network.dns.disablePrefetch", true);
// Speculative connections: Gecko looks a link's host up, and may connect to
// it, as the link is hovered or focused, and as a load from the browser
// starts. A .local name's lookup alone raises macOS's Local Network prompt
// for an app that was never asked, a Mac dev copy included. A bench run can
// turn them back on through ZENIUS_DEV_PREFS.
user_pref("network.http.speculative-parallel-limit", 0);
// Search suggestions, Firefox Suggest, and the region lookup that picks
// the default engines.
user_pref("browser.search.suggest.enabled", false);
user_pref("browser.search.update", false);
user_pref("browser.urlbar.suggest.searches", false);
user_pref("browser.urlbar.quicksuggest.enabled", false);
user_pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
user_pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false);
user_pref("browser.urlbar.merino.endpointURL", "");
user_pref("browser.urlbar.speculativeConnect.enabled", false);
user_pref("browser.region.network.url", "");
user_pref("browser.region.update.enabled", false);
// Add-on updates and recommendations.
user_pref("extensions.update.enabled", false);
user_pref("extensions.update.autoUpdateDefault", false);
user_pref("extensions.getAddons.cache.enabled", false);
user_pref("extensions.systemAddon.update.enabled", false);
user_pref("extensions.htmlaboutaddons.recommendations.enabled", false);
// The new-tab page's stories and sponsored sites.
user_pref("browser.newtabpage.activity-stream.feeds.system.topstories", false);
user_pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);
user_pref("browser.topsites.contile.enabled", false);
// No media plugins: a fresh profile otherwise downloads Widevine (22 MB) and
// OpenH264 into the temporary folder soon after startup, and a Zen stopped
// before it unpacks them leaves the download there. No test plays DRM media.
user_pref("media.gmp-manager.updateEnabled", false);
