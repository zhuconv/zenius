# Third-party sources

zenius's own code is under the MIT License (`LICENSE`). The parts below come
from others and keep their own licenses.

| Source | License | Where | Notes |
|---|---|---|---|
| [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) 0.10.16 | MPL-2.0 | `runtime/vendor/fx-autoconfig/` | Unmodified copy of the loader the user's Zen already runs. |
| [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) | MIT | `docs/reference/` (not in the public copy) and files headed "Portions adapted from citrolabs/ego-lite" | API contract, skill text, e2e cases; the SDK and CLI (`sdk/`), the usage guide and site learnings (`skill/`); page semantics and error texts, and `fetchInPage` verbatim (`runtime/JS/zenius/observe/`, `methods/{navigation,observe,io}.sys.mjs`, `content/{nav,evaluate}.sys.mjs`); page actions, selectors, actionability, fill and keyboard rules, and their e2e cases (`runtime/JS/zenius/content/{actions,actionability,resolve,keys}.sys.mjs`, `methods/actions.sys.mjs`, `tests/input/`). |
| [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) | MIT | `sdk/test/fixtures/ego-error-codes.ts` | The names of Ego's error codes, from its SDK and `docs/native-bindings-api.md`, which `sdk/test/errors.test.ts` checks the SDK's help entries against. `sdk/scripts/update-ego-codes.mjs` regenerates the file from a local `refs/ego-lite`. |
| [microsoft/playwright](https://github.com/microsoft/playwright) a018f24 | Apache-2.0 | `runtime/JS/zenius/content/snapshot/aria.js` | ARIA roles and accessible names: `packages/injected/src/domUtils.ts` and `roleUtils.ts`, types stripped and wrapped for a sandbox by `tests/snapshot/tools/port-playwright.mjs` (the CSS tokenizer is replaced, every DOM access goes through `content/snapshot/dom.js`, and secret fields' values are kept out of names). The file keeps Microsoft's notice and says what changed. |
| [microsoft/playwright](https://github.com/microsoft/playwright) | Apache-2.0 | `runtime/JS/zenius/content/keys.sys.mjs` | The US keyboard layout and chord rules, through Ego's `driver/page-keyboard.ts`, which follows Playwright's. The file carries Microsoft's notice. |
| [markedjs/marked](https://github.com/markedjs/marked) v18.1.1 | MIT | `runtime/JS/agent-sidebar/vendor/marked.esm.js` | The agent sidebar's Markdown parser for answers, the release's ESM build unchanged; its license is `vendor/marked.LICENSE`. The panel sanitizes marked's HTML (nsIParserUtils) before showing it. |
| [@agentclientprotocol/claude-agent-acp](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) 0.107.0, [@agentclientprotocol/codex-acp](https://www.npmjs.com/package/@agentclientprotocol/codex-acp) 2.6.0, and their dependencies | Apache-2.0; @anthropic-ai/claude-agent-sdk under its README's terms | not in the repo: `runtime/agents/package-lock.json` pins them | The ACP adapters that the agent sidebar's built-in agents run. zenius's installer installs them with npm in `~/.zenius/agents`, without the optional packages (the SDKs' bundled CLIs), and they run the user's own Claude Code and Codex. |
| [Zen Browser](https://github.com/zen-browser/desktop) | MPL-2.0; its icons are Nucleo's | nothing copied | zenius runs inside Zen and refers to its `chrome://` files at run time. Zen's icons are Nucleo icons, whose license forbids passing them on: zenius draws its own or reads the installed Zen's at run time, and `tests/ux/iconpaths.test.mjs` keeps their path data out of `runtime/`. |
| [Noto Sans](https://github.com/notofonts/latin-greek-cyrillic) | SIL Open Font License 1.1 | `docs/assets/logo/*/banner*.svg`, the PNGs drawn from them, and `docs/assets/logo/aqua-navy/social-preview.png` | The wordmark "zen(ius)" and its tagline are Noto Sans Regular and Bold glyph outlines, drawn as paths. No font file is included. |

## License texts

- **fx-autoconfig**: the MPL-2.0 text is `runtime/vendor/fx-autoconfig/LICENSE`.
- **marked**: `runtime/JS/agent-sidebar/vendor/marked.LICENSE`.
- **Playwright**: the Apache License 2.0 is `LICENSES/Apache-2.0.txt`.
  Playwright's NOTICE file reads:

  > Playwright
  > Copyright (c) Microsoft Corporation
  >
  > This software contains code derived from the Puppeteer project
  > (https://github.com/puppeteer/puppeteer), available under the Apache 2.0
  > license (https://github.com/puppeteer/puppeteer/blob/master/LICENSE).

- **Ego Lite**:

  > MIT License
  >
  > Copyright (c) 2026 CitroLabs
  >
  > Permission is hereby granted, free of charge, to any person obtaining a
  > copy of this software and associated documentation files (the
  > "Software"), to deal in the Software without restriction, including
  > without limitation the rights to use, copy, modify, merge, publish,
  > distribute, sublicense, and/or sell copies of the Software, and to permit
  > persons to whom the Software is furnished to do so, subject to the
  > following conditions:
  >
  > The above copyright notice and this permission notice shall be included
  > in all copies or substantial portions of the Software.
  >
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
  > OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  > MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
  > NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
  > DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
  > OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
  > USE OR OTHER DEALINGS IN THE SOFTWARE.

## Public pages in the test snapshots

`tests/golden/ego/` holds snapshots of public pages, taken on 2026-11-20 for
comparing zenius's page snapshots with Ego Lite's: each page's DOM (scripts
and session values removed, `dom/<slug>.html.gz`) and the snapshot text of
both. The text is the sites' own. Most of it is under an open license; five
snapshots, at the end of the table, are kept as test data though their text
isn't (the user's call, 2026-11-21):

| Snapshot | Page | Terms |
|---|---|---|
| `site-wikipedia-article`, `site-wikipedia-table` | en.wikipedia.org: "Firefox"; "List of countries and dependencies by population" | Wikipedia contributors, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `site-mdn-input`, `site-mdn-iframe` | developer.mozilla.org: the `<input>` and `<iframe>` references | Mozilla contributors, [CC BY-SA 2.5](https://creativecommons.org/licenses/by-sa/2.5/); code samples CC0 |
| `site-stackoverflow` | stackoverflow.com/questions/111102 | its authors, [CC BY-SA](https://stackoverflow.com/help/licensing) (the version each post names) |
| `site-react-dev` | react.dev/learn | Meta Platforms, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `site-gov-uk` | www.gov.uk | Crown copyright, [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) |
| `site-python-docs` | docs.python.org/3/library/asyncio.html | Python Software Foundation, PSF License Version 2; code samples Zero-Clause BSD |
| `site-w3c-apg-combobox` | w3.org's ARIA Authoring Practices combobox example | W3C, [W3C Software and Document License](https://www.w3.org/copyright/software-license/) |
| `site-github-repo` | github.com/citrolabs/ego-lite | the README is CitroLabs', MIT (above), in GitHub's page |
| `site-npm` | npmjs.com/package/playwright | the README is Microsoft's, Apache-2.0, in npm's page |
| `site-pypi` | pypi.org/project/requests | the README is the Requests project's, Apache-2.0, in PyPI's page |
| `site-arxiv` | arxiv.org/abs/1706.03762 | the title, authors and abstract are arXiv metadata, CC0 1.0 |
| `site-selenium-web-form` | selenium.dev's web form test page | the Selenium project, Apache-2.0 |
| `site-httpbin-form` | httpbin.org/forms/post | httpbin, ISC |
| `site-shoelace` | shoelace.style's button page | Shoelace, MIT |
| `site-material-web` | material-web.dev's button page | Material Web, Apache-2.0 |
| `site-the-internet-iframe`, `site-the-internet-nested-frames` | the-internet.herokuapp.com, a practice site for browser automation | a few words of placeholder text |
| `site-gnu-manuals` | gnu.org/manual/manual.html, the list of GNU manuals | Free Software Foundation |
| `site-example` | example.com | IANA's example page |
| `site-apple` | www.apple.com, the home page | Apple Inc.'s; not under an open license |
| `site-bbc-news` | www.bbc.com/news, the front page | the BBC's; not under an open license |
| `site-guardian` | www.theguardian.com/international, the front page | Guardian News & Media's; not under an open license |
| `site-bing-search` | www.bing.com, a search for "zen browser" | Microsoft's page, quoting the sites it lists; not under an open license |
| `site-hacker-news` | news.ycombinator.com, the front page | Y Combinator's page and its posters' titles; not under an open license |
