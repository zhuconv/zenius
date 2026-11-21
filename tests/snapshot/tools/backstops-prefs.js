// Prefs for backstops-probe.mjs, for ZENIUS_DEV_PREFS, in a profile of its
// own, headless on the Linux server. Fake cameras and microphones; Gecko's own alerts,
// not the system's; a mock audio context. The probe's peer connection stops
// at createOffer, so ICE never gathers; the two ICE prefs keep it off the
// network anyway (no host candidates, no mDNS names). Gecko's own fetches
// that would leave loopback point at a closed loopback port.
user_pref("media.navigator.streams.fake", true);
user_pref("media.audio_loopback_dev", "");
user_pref("media.video_loopback_dev", "");
user_pref("alerts.useSystemBackend", false);
user_pref("media.cubeb.force_mock_context", true);
user_pref("media.peerconnection.ice.no_host", true);
user_pref("media.peerconnection.ice.obfuscate_host_addresses", false);
// Location and MIDI, for the zenius cases: the testing providers, and the
// network location provider pointed at a closed loopback port.
user_pref("geo.provider.network.url", "http://127.0.0.1:9/geo");
user_pref("geo.provider.testing", true);
user_pref("geo.provider.network.scan", false);
user_pref("geo.provider.use_geoclue", false);
user_pref("geo.provider.use_gpsd", false);
user_pref("geo.provider.use_corelocation", false);
user_pref("midi.testing", true);
user_pref("browser.ml.modelHubRootUrl", "http://127.0.0.1:9/hub/");
user_pref("services.settings.server", "http://127.0.0.1:9/v1");
user_pref("browser.region.network.url", "");
user_pref("browser.region.update.enabled", false);
