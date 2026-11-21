// Speculative-connect probes (docs/research/speculative-connect.md): paths
// from a task page that reach the network with no HTTP channel, so without
// http-on-opening-request, where zen-observe's local network refusal runs:
// - <link rel=preconnect>, the agent's and the page's own;
// - a preconnect in a 103 Early Hints on the agent's navigation;
// - DNS prefetch: <link rel=dns-prefetch>, and an http page's anchors;
// - the network predictor, taught by the task's page or by the user's tab.
// Each aims at 192.168.77.1 (private) or a .local name that resolves to it.
// The task pages are served from 203.0.113.10, a public address, so Gecko's
// Local Network Access, as shipped, would see public-to-private.
//
// Gecko's own network defaults: the probe changes no pref. Run it only
// through speculative-run.sh, which builds the namespaces (network: lo only;
// mount: hosts from files only); the probe checks them.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { connect } from "../../../scripts/lib/rpc.mjs";

const PRIV = "192.168.77.1";
const PUB = "203.0.113.10";
const NAMES = ["zs-pc1.local", "zs-pc2.local", "zs-eh1.local", "zs-dp1.local", "zs-dp2.local", "zs-dp3.local", "zs-dp4.local", "zs-dp5.local"];

const fail = m => {
  console.error(`speculative-probe: ${m}`);
  process.exit(2);
};
if (process.platform !== "linux") {
  fail("Linux only");
}
const ifs = os.networkInterfaces();
if (Object.keys(ifs).some(n => n !== "lo")) {
  fail(`run it through speculative-run.sh; found ${Object.keys(ifs).join(", ")}`);
}
for (const a of [PRIV, PUB]) {
  if (!(ifs.lo ?? []).some(x => x.address === a)) {
    fail(`${a} is not on lo (speculative-run.sh)`);
  }
}
if (/^hosts:\s*(.*)$/m.exec(fs.readFileSync("/etc/nsswitch.conf", "utf8"))?.[1]?.trim() !== "files") {
  fail("/etc/nsswitch.conf must say hosts: files (speculative-run.sh)");
}
const etcHosts = fs.readFileSync("/etc/hosts", "utf8");
for (const n of NAMES) {
  if (!new RegExp(`^192\\.168\\.77\\.1\\s+${n.replace(/\./g, "\\.")}\\s*$`, "m").test(etcHosts)) {
    fail(`/etc/hosts lacks ${n} (speculative-run.sh)`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const q = encodeURIComponent;
const esc = s => String(s).replace(/[&"<>]/g, c => `&#${c.charCodeAt(0)};`);
const P = (port, scheme = "http") => `${scheme}://${PRIV}:${port}`;
const N = (name, port) => `http://${name}:${port}`;

// TCP listeners on the private target: every connect, and what it sent first.
const conns = [];
function listen(port, host = PRIV) {
  const server = net.createServer(sock => {
    const c = { port, t: Date.now(), first: null };
    conns.push(c);
    sock.on("error", () => {});
    sock.once("data", d => {
      c.first = d[0] === 0x16 ? "tls" : JSON.stringify(d.toString("latin1").split("\r\n")[0].slice(0, 60));
      // An HTTP request gets an answer, so it ends.
      if (c.first.startsWith('"GET') || c.first.startsWith('"POST')) {
        sock.end("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\naccess-control-allow-origin: *\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
      }
    });
    setTimeout(() => sock.destroy(), 15000);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

// The site's pages, on the public address and on loopback.
const page = (head, body = "<p>A page of the site.</p>") => `<!doctype html><meta charset=utf-8><title>spec</title>${head}${body}`;
function site(req, res) {
  const u = new URL(req.url, "http://x");
  const get = k => u.searchParams.get(k) ?? "";
  const send = html => {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(html);
  };
  req.resume();
  switch (u.pathname) {
    case "/p":
      return send(page(""));
    case "/preconnect":
      return send(page(`<link rel=preconnect href="${esc(get("href"))}">`));
    case "/dns":
      return send(page(`<link rel=dns-prefetch href="//${esc(get("host"))}">`));
    case "/anchor":
      return send(page("", `<a href="${esc(get("href"))}">a link</a>`));
    case "/pred":
      return send(page("", `<img src="${esc(get("src"))}" alt="">`));
    case "/early":
      res.writeEarlyHints({ link: get("link") });
      return setTimeout(() => send(page("")), 400);
    default:
      res.writeHead(404);
      return res.end();
  }
}
const servers = [];
for (const [host, port] of [
  [PUB, 80],
  ["127.0.0.1", 8090],
]) {
  const s = http.createServer(site);
  await new Promise(r => s.listen(port, host, r));
  servers.push(s);
}
const PUB_BASE = `http://${PUB}`;
const LOOP_BASE = "http://127.0.0.1:8090";

const client = await connect(process.env.ZENIUS_INSTANCE ?? "zen-snapshot-spec");
const call = (method, params) => client.call(method, params);
const PRE = `
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error("timed out"); await sleep(25); } };
  const loaded = t => t.linkedBrowser.currentURI.spec !== "about:blank" && !t.linkedBrowser.webProgress?.isLoadingDocument;
`;
const chrome = (code, arg) => call("dev.evalChrome", { code: PRE + code, arg });

/** Requests to the target that reached http-on-opening-request, and speculative-connect notices. */
const WATCH_ON = `
  const S = (win.__spec = { seen: [], spec: [] });
  S.obs = {
    observe(subject, topic, data) {
      if (topic === "speculative-connect-request") {
        S.spec.push({ t: Date.now(), data: data ?? null });
        return;
      }
      try {
        const ch = subject.QueryInterface(Ci.nsIHttpChannel);
        const host = ch.URI.host;
        if (host !== arg.priv && !host.endsWith(".local")) return;
        const rec = { t: Date.now(), url: ch.URI.spec, tab: ch.loadInfo.browsingContext?.top?.browserId ?? null };
        S.seen.push(rec);
        win.setTimeout(() => { rec.status = "0x" + (ch.status >>> 0).toString(16); }, 50);
      } catch (e) {}
    },
  };
  Services.obs.addObserver(S.obs, "http-on-opening-request");
  Services.obs.addObserver(S.obs, "speculative-connect-request");
  return true;
`;
const WATCH_OFF = `
  const S = win.__spec;
  if (S?.obs) {
    Services.obs.removeObserver(S.obs, "http-on-opening-request");
    Services.obs.removeObserver(S.obs, "speculative-connect-request");
  }
  return true;
`;

/** The agent's task: a new Space whose page loads url; its code runs, if any. */
async function agentPage(s, url, code = null) {
  await call("page.goto", { space: s, page: "p1", url });
  if (code) {
    return call("page.evaluate", { space: s, page: "p1", fn: `() => { ${code} }`, isFunction: true }).then(
      v => v,
      e => `evaluate failed: ${e.code}`
    );
  }
  return "loaded";
}
const goto = (s, url) =>
  call("page.goto", { space: s, page: "p1", url }).then(
    () => "loaded",
    e => `goto failed: ${e.code}`
  );
const addLink = (rel, href) => `const l = document.createElement("link"); l.rel = ${JSON.stringify(rel)}; l.href = ${JSON.stringify(href)}; document.head.append(l); return "added";`;

/** A tab of the user's, in their Space, at url; code runs in it once it has loaded. Then it closes. */
function userTab(url, code = null, keep = 2500) {
  return chrome(
    `
    const agents = ctx.spaces.agentsSpace.uuid;
    const mine = gZenWorkspaces.getWorkspaces().find(ws => ws.uuid !== agents);
    const t = gBrowser.addTrustedTab(arg.url, { inBackground: true, workspaceId: mine?.uuid });
    try {
      await until(() => t.linkedBrowser.currentURI.spec === arg.url && loaded(t), 10000).catch(() => {});
      let out = "loaded";
      if (arg.code) {
        out = await Promise.race([
          ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { code: arg.code }),
          sleep(6000).then(() => "pending after 6 s"),
        ]);
      }
      await sleep(arg.keep);
      const pn = t.ownerDocument.defaultView.PopupNotifications;
      return { out, prompts: (pn.getNotificationsForBrowser(t.linkedBrowser) ?? []).map(n => n.id) };
    } finally {
      gBrowser.removeTab(t, { animate: false });
    }
  `,
    { url, code, keep }
  );
}

const fetchCode = url => `return fetch(${JSON.stringify(url)}).then(r => "status " + r.status, e => e.name + ": " + e.message);`;

/**
 * port/host: what the vector aims at. kind "control" runs no speculative
 * path. A vector's run gets its task's Space (task vectors) and may call
 * mark() to count only what follows.
 */
const VECTORS = {
  // Controls. A task page's own request: zen-observe cancels it.
  fetchTask: { port: 4500, kind: "control", run: s => agentPage(s, `${PUB_BASE}/p`, `fetch(${JSON.stringify(`${P(4500)}/x`)}).catch(() => {}); return "fetching";`) },
  // A user tab's request, from a public page, then from a loopback page: Gecko's LNA alone.
  fetchUserPublic: { port: 4510, kind: "control", user: true, run: () => userTab(`${PUB_BASE}/p`, fetchCode(`${P(4510)}/x`)) },
  fetchUserLoopback: { port: 4511, kind: "control", user: true, run: () => userTab(`${LOOP_BASE}/p`, fetchCode(`${P(4511)}/x`)) },
  // Preconnect.
  preconnectAgent: { port: 4501, run: s => agentPage(s, `${PUB_BASE}/p`, addLink("preconnect", P(4501))) },
  preconnectAgentHttps: { port: 4502, run: s => agentPage(s, `${PUB_BASE}/p`, addLink("preconnect", P(4502, "https"))) },
  preconnectAgentName: { port: 4503, host: "zs-pc1.local", run: s => agentPage(s, `${PUB_BASE}/p`, addLink("preconnect", N("zs-pc1.local", 4503))) },
  preconnectPage: { port: 4504, run: s => goto(s, `${PUB_BASE}/preconnect?href=${q(P(4504))}`) },
  preconnectPageName: { port: 4505, host: "zs-pc2.local", run: s => goto(s, `${PUB_BASE}/preconnect?href=${q(N("zs-pc2.local", 4505))}`) },
  preconnectAgentLoopbackPage: { port: 4506, run: s => agentPage(s, `${LOOP_BASE}/p`, addLink("preconnect", P(4506))) },
  preconnectUser: { port: 4512, kind: "control", user: true, run: () => userTab(`${PUB_BASE}/preconnect?href=${q(P(4512))}`) },
  // Does Gecko preconnect here at all? The same to the public address.
  preconnectPublicTarget: { port: 4530, addr: PUB, kind: "control", run: s => agentPage(s, `${PUB_BASE}/p`, addLink("preconnect", `http://${PUB}:4530`)) },
  earlyHintsPublicTarget: { port: 4531, addr: PUB, kind: "control", run: s => goto(s, `${PUB_BASE}/early?link=${q(`<http://${PUB}:4531>; rel=preconnect`)}`) },
  // Early Hints on the agent's navigation.
  earlyHints: { port: 4507, run: s => goto(s, `${PUB_BASE}/early?link=${q(`<${P(4507)}>; rel=preconnect`)}`) },
  earlyHintsName: { port: 4508, host: "zs-eh1.local", run: s => goto(s, `${PUB_BASE}/early?link=${q(`<${N("zs-eh1.local", 4508)}>; rel=preconnect`)}`) },
  earlyHintsLoopbackPage: { port: 4514, run: s => goto(s, `${LOOP_BASE}/early?link=${q(`<${P(4514)}>; rel=preconnect`)}`) },
  earlyHintsUser: { port: 4513, kind: "control", user: true, run: () => userTab(`${PUB_BASE}/early?link=${q(`<${P(4513)}>; rel=preconnect`)}`) },
  // Gecko takes a 103 only for a secure context: from the loopback page (potentially trustworthy).
  earlyHintsLoopbackPageName: { port: 4515, host: "zs-pc1.local", run: s => goto(s, `${LOOP_BASE}/early?link=${q(`<${N("zs-pc1.local", 4515)}>; rel=preconnect`)}`) },
  earlyHintsLoopbackPageNameHttps: { port: 4516, host: "zs-pc2.local", run: s => goto(s, `${LOOP_BASE}/early?link=${q(`<https://zs-pc2.local:4516>; rel=preconnect`)}`) },
  earlyHintsLoopbackPagePublicTarget: { port: 4532, addr: PUB, kind: "control", run: s => goto(s, `${LOOP_BASE}/early?link=${q(`<http://${PUB}:4532>; rel=preconnect`)}`) },
  earlyHintsLoopbackPagePublicTargetHttps: { port: 4533, addr: PUB, kind: "control", run: s => goto(s, `${LOOP_BASE}/early?link=${q(`<https://${PUB}:4533>; rel=preconnect`)}`) },
  // DNS prefetch: lookups only.
  dnsPrefetchAgent: { host: "zs-dp1.local", run: s => agentPage(s, `${PUB_BASE}/p`, addLink("dns-prefetch", "//zs-dp1.local")) },
  dnsPrefetchPage: { host: "zs-dp2.local", run: s => goto(s, `${PUB_BASE}/dns?host=zs-dp2.local`) },
  anchorPrefetchPage: { host: "zs-dp3.local", port: 4509, run: s => goto(s, `${PUB_BASE}/anchor?href=${q(`${N("zs-dp3.local", 4509)}/`)}`) },
  anchorPrefetchAgent: {
    host: "zs-dp4.local",
    run: s => agentPage(s, `${PUB_BASE}/p`, `const a = document.createElement("a"); a.href = "http://zs-dp4.local/"; a.textContent = "a link"; document.body.append(a); return "added";`),
  },
  dnsPrefetchUser: { host: "zs-dp5.local", kind: "control", user: true, run: () => userTab(`${PUB_BASE}/dns?host=zs-dp5.local`) },
  // The predictor: taught by the task's own earlier visit, or by the user's
  // tab; then the agent loads the page. Only what follows that load counts.
  predictorTask: {
    port: 4520,
    wait: 4000,
    run: async (s, mark) => {
      const url = `${LOOP_BASE}/pred?src=${q(`${P(4520)}/a.png`)}`;
      await goto(s, url);
      await sleep(1500);
      await goto(s, `${LOOP_BASE}/p`);
      await sleep(500);
      mark();
      return goto(s, url);
    },
  },
  predictorUserLoopback: {
    port: 4521,
    wait: 4000,
    run: async (s, mark) => {
      const url = `${LOOP_BASE}/pred?src=${q(`${P(4521)}/b.png`)}`;
      await userTab(url, null, 1500);
      await userTab(url, null, 1500);
      await sleep(500);
      mark();
      return goto(s, url);
    },
  },
  predictorUserPublic: {
    port: 4522,
    wait: 4000,
    run: async (s, mark) => {
      const url = `${PUB_BASE}/pred?src=${q(`${P(4522)}/c.png`)}`;
      await userTab(url, null, 1500);
      await userTab(url, null, 1500);
      await sleep(500);
      mark();
      return goto(s, url);
    },
  },
};

/** Gecko's log lines about a host name (lookups) and a target port (sockets). */
function logLines() {
  const dir = process.env.SPEC_OUT;
  if (!dir) {
    return null;
  }
  let text = "";
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith("moz.log"))) {
    try {
      text += fs.readFileSync(path.join(dir, f), "latin1");
    } catch {}
  }
  return text.split("\n");
}
function fromLog(lines, v) {
  if (!lines) {
    return null;
  }
  const pick = re => {
    const hits = lines.filter(l => re.test(l));
    return { count: hits.length, sample: hits.slice(0, 3).map(l => l.replace(/^.*?(nsHostResolver|nsSocketTransport)/, "$1").slice(0, 200)) };
  };
  const out = {};
  if (v.host) {
    out.lookups = pick(new RegExp(`nsHostResolver.*${v.host.replace(/\./g, "\\.")}`));
  }
  if (v.port) {
    out.sockets = pick(new RegExp(`nsSocketTransport.*${PRIV.replace(/\./g, "\\.")}.{0,3}${v.port}\\b`));
  }
  return out;
}

const results = { prefs: null, vectors: {} };
let printed = false;
const print = () => {
  if (!printed) {
    printed = true;
    console.log(JSON.stringify(results, null, 1));
  }
};
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    print();
    process.exit(1);
  });
}

try {
  results.prefs = await chrome(`
    const get = name => {
      const t = Services.prefs.getPrefType(name);
      return t === 128 ? Services.prefs.getBoolPref(name) : t === 64 ? Services.prefs.getIntPref(name) : t === 32 ? Services.prefs.getStringPref(name) : null;
    };
    const out = { zen: Services.appinfo.version, gecko: Services.appinfo.platformVersion };
    for (const name of ["network.predictor.enabled", "network.predictor.enable-prefetch", "network.predictor.preconnect-min-confidence", "network.dns.disablePrefetch",
      "network.dns.disablePrefetchFromHTTPS", "network.early-hints.enabled", "network.early-hints.preconnect.enabled", "network.early-hints.preconnect.max_connections",
      "network.http.speculative-parallel-limit", "network.trr.mode", "network.process.enabled", "network.proxy.type", "network.dns.localDomains"]) out[name] = get(name);
    for (const name of Services.prefs.getChildList("network.lna.")) out[name] = get(name);
    return out;
  `);
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(VECTORS);
  for (const v of Object.values(VECTORS)) {
    if (v.port && names.some(n => VECTORS[n] === v)) {
      await listen(v.port, v.addr ?? PRIV);
    }
  }
  await chrome(WATCH_ON, { priv: PRIV });
  for (const name of names) {
    const v = VECTORS[name];
    if (!v) {
      results.vectors[name] = { error: "no such vector" };
      continue;
    }
    step(name);
    const r = { kind: v.kind ?? "speculative" };
    let space = null;
    let from = Date.now();
    const mark = () => {
      from = Date.now();
    };
    try {
      if (!v.user) {
        ({ id: space } = await call("spaces.create", { name: `spec ${name}` }));
      }
      r.outcome = await Promise.race([v.run(space, mark), sleep(40000).then(() => "budget ran out")]);
      await sleep(v.wait ?? 3000);
      if (space !== null) {
        r.task = await chrome(
          `
          const rec = ctx.spaces.peek(arg);
          const t = ctx.resolvePage({ space: arg, page: "p1" })?.tab;
          const pn = t?.ownerDocument.defaultView.PopupNotifications;
          return { ownership: rec?.ownership ?? null, prompts: t ? (pn.getNotificationsForBrowser(t.linkedBrowser) ?? []).map(n => n.id) : null };
        `,
          space
        ).catch(e => ({ error: e.message }));
      }
      const w = await chrome(`return { seen: win.__spec.seen.filter(x => x.t >= arg), spec: win.__spec.spec.filter(x => x.t >= arg).length };`, from);
      r.channels = w.seen.filter(x => (v.port && x.url.includes(`:${v.port}`)) || (v.host && x.url.includes(v.host))).map(x => ({ url: x.url.replace(/^https?:\/\//, ""), status: x.status }));
      r.speculativeNotices = w.spec;
      r.connects = conns.filter(c => c.port === v.port && c.t >= from).map(c => c.first ?? "no bytes");
    } catch (e) {
      r.error = `${e.code ?? ""} ${e.message ?? e}`.trim().slice(0, 200);
    } finally {
      if (space !== null) {
        await call("spaces.finish", { space, keep: [] }).catch(() => {});
      }
    }
    results.vectors[name] = r;
  }
  await chrome(WATCH_OFF);
  // Let Gecko's log catch up, then attribute its lines.
  await sleep(1000);
  const lines = logLines();
  for (const [name, r] of Object.entries(results.vectors)) {
    if (VECTORS[name]) {
      r.log = fromLog(lines, VECTORS[name]);
    }
  }
} catch (e) {
  results.error = String(e?.message ?? e);
} finally {
  print();
  client.close();
  for (const s of servers) {
    s.close();
  }
  process.exit(0);
}
