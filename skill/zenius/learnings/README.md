<!-- Portions adapted from citrolabs/ego-lite (MIT License). -->

# Site learnings

Notes and small tools for one site each. Scripts reach them through
`learnContext(pageOrUrl)`, `siteSkills(pageOrUrl)`, `runSiteTool(page, siteId,
toolName, args)` and `runSiteBrowserTool(page, siteId, toolName, args)`
(`help("learnings")`). Set `ZENIUS_AGENT_WORKSPACE` to read
`$ZENIUS_AGENT_WORKSPACE/learnings/` instead of this directory.

The format:

- `<site>/manifest.json`: `id` (the directory name), `name`, `domains`
  (`example.com` or `*.example.com`), `notes` (`notes/*.md`), and
  `nodeTools` / `browserTools` keyed by tool name, each with `description`,
  `path`, `args` (`{type, required, description}` per argument) and
  `returns`. Node tools also name their exported `callable`.
- Node tools (`tools/*.js`) are ES modules whose callable gets `(ctx, args)`.
  `ctx.page` is the zenius Page the tool runs against, and `ctx` has three
  helpers: `ctx.openOrReuseTab(url)` (navigates that Page), `ctx.waitForLoad()`
  and `ctx.js(expression)`.
- Browser tools (`browser-tools/*.js`) hold one function expression,
  `async function (args) { ... }`, run inside the Page.
- Use stable selectors; snapshot refs such as `@12` change on every snapshot.

`sdk/test/skill.test.ts` validates every learning here.
