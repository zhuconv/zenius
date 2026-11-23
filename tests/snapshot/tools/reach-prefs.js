// Prefs for reach-probe.mjs's dev profile.
// A camera request that gets through gets Gecko's fake stream, never a
// device; the probe checks this pref before it grants the fixture site.
user_pref("media.navigator.streams.fake", true);
user_pref("media.cubeb.force_mock_context", true);
user_pref("media.navigator.permission.disabled", false);
