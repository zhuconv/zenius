// Prefs for localnet-probe.mjs's dev profile (zen-snapshot-net), for
// ZENIUS_DEV_PREFS. the Linux server sits on a shared LAN, so a request the refusal misses
// must never reach a real host. With these, and the probe run inside a
// network namespace with only loopback (its header), it can't:
// - Every non-loopback request goes to an HTTP proxy on loopback, with no
//   failover to a direct connection. Port 9 has nothing on it, so until the
//   probe points the proxy at its recorder such a request just fails. The
//   recorder answers itself and never forwards or tunnels.
// - Loopback goes direct, to the fixture site.
// - The .local names the vectors use resolve to 127.0.0.1 inside Gecko:
//   never mDNS, never the network's DNS.
// - Nothing over UDP: no HTTP/3 or WebTransport, and WebRTC gathers no host
//   candidates and announces no mDNS names.
// - No DNS prefetch, predictor, DoH, or connectivity and portal checks.
user_pref("network.proxy.type", 1);
user_pref("network.proxy.http", "127.0.0.1");
user_pref("network.proxy.http_port", 9);
user_pref("network.proxy.ssl", "127.0.0.1");
user_pref("network.proxy.ssl_port", 9);
user_pref("network.proxy.socks", "");
user_pref("network.proxy.socks_port", 0);
user_pref("network.proxy.share_proxy_settings", false);
user_pref("network.proxy.no_proxies_on", "");
user_pref("network.proxy.allow_hijacking_localhost", false);
user_pref("network.proxy.failover_direct", false);
user_pref("network.dns.localDomains", "zs-lan.local,zs-printer.local");
user_pref("network.dns.disablePrefetch", true);
user_pref("network.dns.disablePrefetchFromHTTPS", true);
user_pref("network.predictor.enabled", false);
user_pref("network.trr.mode", 5);
user_pref("network.connectivity-service.enabled", false);
user_pref("network.captive-portal-service.enabled", false);
user_pref("network.http.http3.enable", false);
user_pref("network.webtransport.enabled", false);
user_pref("media.peerconnection.ice.obfuscate_host_addresses", false);
user_pref("media.peerconnection.ice.no_host", true);
user_pref("media.peerconnection.ice.default_address_only", true);
user_pref("media.peerconnection.ice.proxy_only", true);
// An AudioContext without a sound server (the audioWorklet vector).
user_pref("media.cubeb.force_mock_context", true);
