// Pages for golden snapshots. Fixture paths are relative to the fixture
// server's base URL; sites are live public pages picked for varied structure.

/** Fixture server pages: Ego's e2e routes plus our /zoo/ pages. */
export const FIXTURE_PAGES = [
  { slug: "fixture-home", path: "/" },
  { slug: "fixture-frame", path: "/frame.html" },
  { slug: "fixture-nav-target", path: "/nav-target" },
  { slug: "fixture-same-origin-frame", path: "/same-origin-frame" },
  { slug: "fixture-visual", path: "/visual" },
  { slug: "fixture-pointer-workbench", path: "/pointer-workbench" },
  { slug: "fixture-media-workbench", path: "/media-workbench" },
  { slug: "fixture-snapshot-subtree-frame-host", path: "/snapshot-subtree-frame-host" },
  { slug: "fixture-snapshot-viewport-overflow", path: "/snapshot-viewport-overflow" },
  { slug: "fixture-click-below-fold", path: "/click-below-fold" },
  { slug: "fixture-wheel-trap", path: "/wheel-trap" },
  { slug: "fixture-download-entry", path: "/download-entry" },
  { slug: "zoo-forms", path: "/zoo/forms.html" },
  { slug: "zoo-aria", path: "/zoo/aria.html" },
  { slug: "zoo-semantics", path: "/zoo/semantics.html" },
  { slug: "zoo-shadow", path: "/zoo/shadow.html" },
  { slug: "zoo-frames", path: "/zoo/frames.html" },
  { slug: "zoo-long", path: "/zoo/long.html" },
];

/** Live sites. `why` says which structure the page stands for. */
export const SITE_PAGES = [
  { slug: "site-example", url: "https://example.com/", why: "trivial baseline" },
  { slug: "site-wikipedia-article", url: "https://en.wikipedia.org/wiki/Firefox", why: "long article, infobox, references" },
  { slug: "site-wikipedia-table", url: "https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population", why: "large sortable tables (large snapshot)" },
  { slug: "site-github-repo", url: "https://github.com/citrolabs/ego-lite", why: "GitHub repository page, React app" },
  { slug: "site-hacker-news", url: "https://news.ycombinator.com/", why: "table layout, dense links" },
  { slug: "site-mdn-input", url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input", why: "docs with sidebars and an interactive example iframe" },
  { slug: "site-mdn-iframe", url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe", why: "docs page with embedded live-example iframes" },
  { slug: "site-stackoverflow", url: "https://stackoverflow.com/questions/111102/how-do-javascript-closures-work", why: "Q&A with votes, comments, code" },
  { slug: "site-npm", url: "https://www.npmjs.com/package/playwright", why: "package page, tabs, README" },
  { slug: "site-arxiv", url: "https://arxiv.org/abs/1706.03762", why: "academic abstract page" },
  { slug: "site-python-docs", url: "https://docs.python.org/3/library/asyncio.html", why: "Sphinx docs" },
  { slug: "site-pypi", url: "https://pypi.org/project/requests/", why: "package page" },
  { slug: "site-bbc-news", url: "https://www.bbc.com/news", why: "news front page, cookie banner" },
  { slug: "site-guardian", url: "https://www.theguardian.com/international", why: "news front page, dense cards" },
  { slug: "site-selenium-web-form", url: "https://www.selenium.dev/selenium/web/web-form.html", why: "form-heavy: every input type" },
  { slug: "site-httpbin-form", url: "https://httpbin.org/forms/post", why: "classic server form" },
  { slug: "site-the-internet-iframe", url: "https://the-internet.herokuapp.com/iframe", why: "rich-text editor inside an iframe" },
  { slug: "site-the-internet-nested-frames", url: "https://the-internet.herokuapp.com/nested_frames", why: "frameset with nested frames" },
  { slug: "site-shoelace", url: "https://shoelace.style/components/button", why: "shadow-DOM web components" },
  { slug: "site-material-web", url: "https://material-web.dev/components/button/", why: "Lit shadow-DOM components" },
  // Not reddit.com: Ego Lite's profile is logged in there, and the page shows the account.
  { slug: "site-gov-uk", url: "https://www.gov.uk/", why: "accessible semantic markup" },
  { slug: "site-react-dev", url: "https://react.dev/learn", why: "SPA docs" },
  { slug: "site-w3c-apg-combobox", url: "https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/", why: "ARIA pattern example" },
  { slug: "site-gnu-manuals", url: "https://www.gnu.org/manual/manual.html", why: "huge plain link list (craigslist/about/sites asks for geolocation, which hands the space to the user)" },
  { slug: "site-apple", url: "https://www.apple.com/", why: "marketing page, heavy media" },
  { slug: "site-bing-search", url: "https://www.bing.com/search?q=zen+browser", why: "search results" },
];
