// Prefs for devices-probe.mjs, for ZENIUS_DEV_PREFS. Fake cameras,
// microphones and MIDI ports. A network location provider that only ever
// reaches loopback: the probe points it at its fixture's /geo, and Zen's
// default would ask an outside service. No system location, notification
// or wifi services. Linux only: the probe refuses to run on macOS.
user_pref("media.navigator.streams.fake", true);
user_pref("media.audio_loopback_dev", "");
user_pref("media.video_loopback_dev", "");
user_pref("geo.provider.testing", true);
user_pref("geo.provider.network.url", "http://127.0.0.1:9/geo");
user_pref("geo.provider.network.scan", false);
user_pref("geo.provider.network.timeToWaitBeforeSending", 2000);
user_pref("geo.provider.use_geoclue", false);
user_pref("geo.provider.use_gpsd", false);
user_pref("geo.provider.use_corelocation", false);
user_pref("midi.testing", true);
user_pref("alerts.useSystemBackend", false);
// The speech recognition model's hub, Remote Settings and Region's country
// lookup: Gecko's own fetches, which would leave loopback.
user_pref("browser.ml.modelHubRootUrl", "http://127.0.0.1:9/hub/");
user_pref("services.settings.server", "http://127.0.0.1:9/v1");
user_pref("browser.region.network.url", "");
user_pref("browser.region.update.enabled", false);
// Audio output (selectAudioOutput, setSinkId) on a mock cubeb, not the Linux server's sound stack.
user_pref("media.cubeb.force_mock_context", true);
