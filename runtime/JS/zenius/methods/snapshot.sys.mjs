// page.snapshot (zen-snapshot): Ego's semantic snapshot of a page. The walk
// runs in content (content/snapshot/); this side checks options, numbers the
// refs through the tab's registry and adds Ego's header and viewport footer.
//
// Portions adapted from citrolabs/ego-lite (MIT License).
// The header, footer and option messages follow
// package/ego-browser/src/page-model.ts.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { Refs } from "chrome://userscripts/content/zenius/snapshot/refs.sys.mjs";

const SIGNATURE = "await page.snapshot({ scope?, root?, includeActionMarks?, includeStableLocator? })";
const SCOPES = ["full_page", "only_within_viewport", "subtree"];
// Ego's default (EGO_BROWSER_PAGE_BUDGET), until zen-core's dispatcher hands
// over the process's budget as ctx.pageBudget; the header shows it near the
// limit.
const PAGE_BUDGET = 8;
const CONTENT_TIMEOUT_MS = 30_000;
// A busy frame (an ad's script, say) mustn't hold up the page's snapshot:
// past this it prints as an empty iframe, as a frame that failed does.
// MDN's 15k-element page walks in 0.2 s, so this only cuts a stuck frame.
// The pref is for tests.
const FRAME_TIMEOUT_MS = 5_000;
const FRAME_TIMEOUT_PREF = "zenius.snapshot.frameTimeoutMs";
// Counting locators takes milliseconds; a frame slower than this counts as
// no match.
const COUNT_TIMEOUT_MS = 1_000;

function optionsError(message) {
  return new ZenError("ZEN_INVALID_ARGUMENT", `${message}. Expected: ${SIGNATURE}`);
}

/** Ego's checks, plus interactiveOnly and maxResultLength (§4.1). */
function readOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw optionsError("page.snapshot options must be an object");
  }
  const scope = options.scope ?? "only_within_viewport";
  if (scope !== "viewport" && !SCOPES.includes(scope)) {
    throw optionsError(`page.snapshot scope must be one of ${SCOPES.join(", ")}`);
  }
  if (scope === "subtree" && options.root === undefined) {
    throw optionsError("page.snapshot subtree scope requires root to be a snapshot ref such as @21");
  }
  if (scope !== "subtree" && options.root !== undefined) {
    throw optionsError("page.snapshot root is only supported when scope is subtree");
  }
  const rootRef = options.root === undefined ? null : Refs.parse(options.root);
  if (options.root !== undefined && !rootRef) {
    throw optionsError("page.snapshot root must be a snapshot ref such as @21");
  }
  for (const name of ["includeActionMarks", "includeStableLocator", "interactiveOnly", "includeRefs"]) {
    if (options[name] !== undefined && typeof options[name] !== "boolean") {
      throw optionsError(`page.snapshot ${name} must be a boolean`);
    }
  }
  const max = options.maxResultLength;
  if (max !== undefined && !(Number.isSafeInteger(max) && max >= 0)) {
    throw optionsError("page.snapshot maxResultLength must be a non-negative integer");
  }
  return {
    scope: scope === "only_within_viewport" ? "viewport" : scope,
    root: options.root,
    rootRef,
    marks: options.includeActionMarks ?? true,
    locators: options.includeStableLocator ?? true,
    interactiveOnly: options.interactiveOnly ?? false,
    // The SDK reads only text; refs (40% of a big page's result) are for
    // tests and tools that ask.
    includeRefs: options.includeRefs ?? false,
    // Ego's native option: 0 or none means no limit.
    max: max ?? 0,
    // Dev aid: container lines carry their element's layout (golden-diff --debug).
    debug: options.debug === true,
    // Dev aid: false walks offscreen subtrees too, to check the pruning.
    prune: options.prune !== false,
    // Dev aid: switches for fitting the tree to Ego's (golden-diff --fit).
    fit: options.fit && typeof options.fit === "object" && !Array.isArray(options.fit) ? options.fit : undefined,
  };
}

function compactTitle(value) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

/** What Chromium shows as a tab's title: the document title, else the URL without its scheme. */
function tabTitle(browser) {
  const title = browser?.contentTitle;
  if (title) {
    return compactTitle(title);
  }
  const url = browser?.currentURI?.spec;
  return compactTitle(url ? url.replace(/^https?:\/\//, "") : "untitled");
}

/** Ego's snapshotSourceHeader (§1.1). */
function header(ctx, space, page, browser) {
  try {
    const pages = ctx.pages.list(space.id);
    // The space's tabs that aren't pages, by zen-core's own pairing: for a
    // task in the shared Agents Space, only its own tabs, and a page's copy
    // in another window is still that page.
    const untracked = ctx.pages.inventory(space).filter(entry => !entry.page).length;
    const inventory = pages.map(p => {
      const current = p.label === page.label ? "*" : "";
      return `${p.label}${current} ${JSON.stringify(tabTitle(ctx.pages.tabFor(p)?.linkedBrowser))}`;
    });
    const limit = ctx.pageBudget ?? PAGE_BUDGET;
    const budget = pages.length >= limit - 1 ? ` | budget ${pages.length}/${limit}` : "";
    const list = inventory.length ? ` — ${inventory.join(", ")}` : "";
    return `[${page.label} ${JSON.stringify(tabTitle(browser))} | space ${JSON.stringify(space.name)}(${space.id}): ${pages.length} managed, ${untracked} untracked${list}${budget}]`;
  } catch {
    return `[${page.label} | space ${JSON.stringify(space.name)}(${space.id})]`;
  }
}

/** Ego's viewportOverflowHint (§1.1): "" when the page fits, 1 px tolerance. */
function overflowHint(metrics) {
  const { viewportHeight, scrollY, pageHeight } = metrics ?? {};
  if (![viewportHeight, scrollY, pageHeight].every(Number.isFinite)) {
    return "";
  }
  const top = Math.round(scrollY);
  const viewport = Math.round(viewportHeight);
  const page = Math.round(pageHeight);
  const above = top > 1;
  const below = page - (top + viewport) > 1;
  if (!above && !below) {
    return "";
  }
  const where = above && below ? "above and below" : above ? "above" : "below";
  return `[more content ${where} the viewport: scrollY=${top}, viewport ${viewport} / page ${page} px; scroll or use snapshot({ scope: "full_page" })]`;
}

/**
 * Captures the target and, one level at a time, the out-of-process frames
 * inside it (§4.4). Returns the captures with their child links.
 */
async function captureAll(ctx, target, args) {
  const call = (bc, extra, timeout = CONTENT_TIMEOUT_MS) =>
    ctx.content(bc, "snapshot/index#capture", { ...args, ...extra }, { timeout });
  const frameTimeout = Services.prefs.getIntPref(FRAME_TIMEOUT_PREF, FRAME_TIMEOUT_MS);
  // Content processes that didn't answer in time: every frame they host is
  // stuck behind the same main thread, so none of them gets asked again.
  const busy = new Set();
  const top = await call(target, {});
  if (top.stale) {
    return null;
  }
  const captures = [{ result: top, bc: target }];
  const children = new Map();
  let pending = top.frames.map((frame, index) => ({ parent: 0, index, frame }));
  while (pending.length) {
    const results = await Promise.all(
      pending.map(({ frame }) => {
        const bc = BrowsingContext.get(frame.bcId);
        // A frame that went away or failed prints as an empty iframe.
        if (!bc) return null;
        return call(bc, { topLevel: false, rootLocalId: null, clip: frame.clip }, frameTimeout).catch(e => {
          if (e?.code === "ZEN_PAGE_UNRESPONSIVE") busy.add(bc.currentWindowGlobal?.contentParentId);
          return null;
        });
      })
    );
    const next = [];
    results.forEach((result, i) => {
      if (!result || result.stale) return;
      const index = captures.push({ result, bc: BrowsingContext.get(pending[i].frame.bcId) }) - 1;
      children.set(`${pending[i].parent}:${pending[i].index}`, index);
      result.frames.forEach((frame, j) => next.push({ parent: index, index: j, frame }));
    });
    pending = next;
  }
  return { captures, children, busy, frameTimeout };
}

/**
 * Locator texts that match exactly one element in the whole tab, every frame
 * included, walked or not, as Ego checks (§6). Each capture counted its own
 * candidates in the documents it walked (ref[5]); every other frame counts
 * them now, all frames at once.
 */
async function uniqueLocators(ctx, top, { captures, busy, frameTimeout }) {
  const owners = new Map();
  captures.forEach(({ result }, i) => {
    for (const doc of result.docs) {
      for (const ref of doc.refs) {
        if (!ref[3] || !(ref[5] > 0)) continue;
        const owner = owners.get(ref[3]);
        if (!owner) owners.set(ref[3], { capture: i, total: ref[5] });
        // Unique in two captures is two matches.
        else if (owner.capture !== i) owner.total = 2;
      }
    }
  });
  const unique = new Set();
  for (const [text, owner] of owners) {
    if (owner.total === 1) unique.add(text);
  }
  const walked = captures.map(({ result }) => new Set(result.docs.map(doc => doc.innerWindowId)));
  const frames = top
    .getAllBrowsingContextsInSubtree()
    .filter(bc => bc.currentWindowGlobal && !busy.has(bc.currentWindowGlobal.contentParentId));
  const timeout = Math.min(COUNT_TIMEOUT_MS, frameTimeout);
  await Promise.all(
    frames.map(async bc => {
      const id = bc.currentWindowGlobal.innerWindowId;
      const texts = [...unique].filter(text => !walked[owners.get(text).capture].has(id));
      if (!texts.length) return;
      // A frame that can't answer (gone, busy, no actor) counts as no match.
      const counts = await ctx
        .content(bc, "snapshot/index#countLocators", { texts }, { timeout })
        .catch(() => null);
      counts?.forEach((n, i) => {
        if (n > 0) unique.delete(texts[i]);
      });
    })
  );
  return unique;
}

const REF = /\u0001(\d+):(\d+)\u0002/g;
const BRACKET = / \[\u0001(\d+):(\d+)\u0002\]/g;

// Refs on these mark a region, not a control: what they hold doesn't label them.
const REGION_ROLES = new Set(["container", "iframe", "dialog_modal", "dialog_modeless", "root"]);

/**
 * interactiveOnly (§4.8): root, iframes and ref'd nodes print, and inside a
 * control so do the text and named nodes that label it. Other lines are
 * transparent: what they hold moves up to the nearest printed ancestor.
 */
function interactiveLines(lines) {
  const out = [];
  const stack = [];
  for (const line of lines) {
    const body = line.trimStart();
    const depth = line.length - body.length;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const parent = stack.at(-1);
    const indent = parent ? parent.childIndent : 0;
    const role = /^[a-z_]+/.exec(body)?.[0] ?? "";
    const ref = /\u0001\d+:\d+\u0002/.test(body);
    const labels = parent?.inControl ?? false;
    const keep = ref || role === "root" || role === "iframe" || (labels && /^[a-z_]+ "/.test(body));
    if (keep) out.push(" ".repeat(indent) + body);
    stack.push({ depth, childIndent: keep ? indent + 2 : indent, inControl: labels || (ref && !REGION_ROLES.has(role)) });
  }
  return out;
}

/** The final lines: frame placeholders replaced, ref placeholders made global (doc index). */
function stitch(captures, children, bases, index = 0, out = [], pad = "") {
  const { text } = captures[index].result;
  for (const line of text.split("\n")) {
    const frame = /^( *)\u0003(\d+)\u0004$/.exec(line);
    if (frame) {
      const child = children.get(`${index}:${frame[2]}`);
      if (child !== undefined) stitch(captures, children, bases, child, out, pad + frame[1]);
      continue;
    }
    out.push(pad + line.replace(/\u0001(\d+):(\d+)\u0002/g, (_, d, k) => `\u0001${bases[index] + Number(d)}:${k}\u0002`));
  }
  return out;
}

// Gate classes: access for the control
// gate (I3), i5 for the web-content gate (I5).
export const access = {
  "page.snapshot": "read",
};

export const i5 = {
  "page.snapshot": "document",
};

export const methods = {
  "page.snapshot": async (ctx, params) => {
    const t0 = ChromeUtils.now();
    const options = readOptions(params.options ?? {});
    const { space, page, browser, browsingContext } = ctx.resolvePage(params);

    let target = browsingContext;
    let rootLocalId = null;
    if (options.rootRef) {
      let ref;
      try {
        ref = Refs.resolve(browser, options.rootRef);
      } catch (e) {
        if (e?.code === "ZEN_REF_NOT_FOUND") {
          throw new ZenError("ZEN_REF_NOT_FOUND", `Unknown ref: ${options.root}`, { ref: options.rootRef });
        }
        throw e;
      }
      target = ref.browsingContext;
      rootLocalId = ref.localId;
    }

    const topOrigin = browsingContext.currentWindowGlobal?.documentPrincipal?.originNoSuffix ?? "";
    const captured = await captureAll(ctx, target, {
      scope: options.scope,
      topLevel: target === browsingContext,
      topOrigin,
      locators: options.locators,
      rootLocalId,
      debug: options.debug,
      prune: options.prune,
      fit: options.fit,
    });
    if (!captured) {
      Refs.markStale(browser, options.rootRef);
      throw new ZenError("ZEN_REF_STALE", `Stale ref: @${options.rootRef}; take a new snapshot`, { ref: options.rootRef });
    }
    const { captures, children } = captured;
    const t1 = ChromeUtils.now();
    const unique = options.locators ? await uniqueLocators(ctx, browsingContext, captured) : new Set();
    const t2 = ChromeUtils.now();

    // Every document's refs, globally indexed; placeholders become \u0001d:k\u0002 over these.
    const docs = [];
    const bases = [];
    for (const { result } of captures) {
      bases.push(docs.length);
      docs.push(...result.docs);
    }
    // The tree, with ref placeholders \u0001d:k\u0002 over docs (§4.6). With
    // no out-of-process frames there's nothing to stitch: the one capture's
    // document indexes are already global. Whole-text passes, not per-line
    // ones: a 200k-line page spent 0.5 s in per-line regexes here.
    const single = captures.length === 1 && !captures[0].result.frames.length;
    let tree = single ? captures[0].result.text : stitch(captures, children, bases).join("\n");
    let lines = null;
    if (options.interactiveOnly) {
      lines = interactiveLines(tree.split("\n"));
    }

    // Only the ref the locator matches gets it, not another ref proposing the same text.
    const locOf = ref => (ref[3] && ref[5] > 0 && unique.has(ref[3]) ? ref[3] : null);
    const bracket = (d, k, number) => {
      const ref = docs[d].refs[k];
      const loc = locOf(ref);
      const parts = options.marks ? [`ref=${number}`] : [];
      if (loc) parts.push(`loc=${loc}`);
      if (ref[4]) parts.push(`url=${ref[4]}`);
      return parts.length ? ` [${parts.join(", ")}]` : "";
    };
    // Refs in print order, as [d, k] pairs over docs.
    const refsIn = text => Array.from(text.matchAll(REF), m => [Number(m[1]), Number(m[2])]);
    const printed = order =>
      order.map(([d, k]) => {
        const doc = docs[d];
        const ref = doc.refs[k];
        return { bcId: doc.bcId, innerWindowId: doc.innerWindowId, localId: ref[0], role: ref[1], name: ref[2] };
      });

    // maxResultLength (§4.8) keeps whole lines while the tree fits, measured
    // with the numbers the refs will get, so only printed refs register.
    let truncated = false;
    if (options.max > 0) {
      lines ??= tree.split("\n");
      const order = lines.flatMap(refsIn);
      const preview = options.marks ? Refs.preview(browser, printed(order)) : [];
      const guessed = docs.map(() => []);
      order.forEach(([d, k], i) => (guessed[d][k] = preview[i]));
      let used = -1;
      let cut = 0;
      for (; cut < lines.length; cut++) {
        const length = lines[cut].replace(BRACKET, (_, d, k) => bracket(+d, +k, guessed[d][k])).length + 1;
        if (used + length > options.max) break;
        used += length;
      }
      truncated = cut < lines.length;
      lines = lines.slice(0, cut);
    }
    if (lines) {
      tree = lines.join("\n");
    }

    const order = refsIn(tree);
    const numbers = docs.map(() => []);
    if (options.marks) {
      // A truncated full_page didn't see the whole page, so it retires nothing.
      const assigned = Refs.register(browser, printed(order), { replace: options.scope === "full_page" && !truncated });
      order.forEach(([d, k], i) => (numbers[d][k] = assigned[i]));
    }
    tree = tree.replace(BRACKET, (_, d, k) => bracket(+d, +k, numbers[d][k]));
    const refs =
      options.marks && options.includeRefs
        ? order.map(([d, k]) => {
            const ref = docs[d].refs[k];
            const loc = locOf(ref);
            return { ref: numbers[d][k], role: ref[1], name: ref[2], ...(loc ? { loc } : {}), ...(ref[4] ? { url: ref[4] } : {}) };
          })
        : [];

    const head = header(ctx, space, page, browser);
    const hint = options.scope === "viewport" && !rootLocalId ? overflowHint(captures[0].result.metrics) : "";
    const notice = truncated
      ? `[snapshot truncated at maxResultLength=${options.max}; use scope "subtree" with a ref, or a larger maxResultLength]`
      : "";
    const content = notice ? (tree ? `${tree}\n${notice}` : notice) : tree;
    // Ego's native content ends with a newline; the hint goes right below the
    // last node instead.
    const text = hint ? `${head}\n${content}\n${hint}` : `${head}\n${content}\n`;

    const s = captures[0].result.stats ?? {};
    ctx.log(
      `snapshot ${options.scope} ${(ChromeUtils.now() - t0).toFixed(1)}ms: top content ${(s.contentMs ?? 0).toFixed(1)}ms ` +
        `(walk ${(s.walkMs ?? 0).toFixed(1)}, locators ${(s.locMs ?? 0).toFixed(1)}, count ${(s.countMs ?? 0).toFixed(1)}), ${captures.length} captures, ` +
        `parent ${(ChromeUtils.now() - t1).toFixed(1)}ms (frame locators ${(t2 - t1).toFixed(1)}); ${s.elements} elements, ${s.texts} texts, ${s.rects} rects, ` +
        `${s.styleReads} styles, ${s.pseudoQueries ?? 0} pseudo queries, ${s.pruned} pruned, ${s.docs} docs, ${order.length} refs, ${text.length} chars`
    );
    return options.includeRefs ? { text, refs } : { text };
  },
};
