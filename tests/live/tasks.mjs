// Rubric C's live-site tasks (docs/eval/live-tasks.md), as data for
// tests/live/run.mjs. Each rubric item is one of:
//   fixed       checked by script against the final answer (`check`)
//   trajectory  checked by script against the URLs the run visited (`visited`)
//   live        graded by the judge against the run's own page reads
// Answer keys come from a reference pass on the sites before the runs
// (docs/eval/live-pilot.md says when and how).
// T2, T8 and T13 are the pilot's, unchanged; the other twelve follow
// live-tasks.md word for word in their prompts.

export const COMMON_TAIL =
  "Use the browser skill. Do not sign in, post, buy or submit anything except search and filter forms. " +
  "When done, end your task and give the answer in one short paragraph.";

/** A number in the answer within `window` characters after `label`. */
function near(label, value, window = 60) {
  const v = String(value).replace(".", "\\.");
  return new RegExp(`${label}[^\\n]{0,${window}}?(?<![\\d.])${v}(?![\\d])`, "i");
}

/** Text compared as a reader would: case, quote shapes and spacing don't count. */
const plain = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** The answer says `text`, word for word. */
const says = (a, text) => plain(a).includes(plain(text));

/** The answer has the number `x` ("1233", "1232.7"), with or without thousands separators, either decimal mark. */
function number(a, x) {
  const [int, frac] = String(x).split(".");
  const groups = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ").split(" ");
  const sep = "[,.\\s\\u00a0\\u202f']?";
  const pattern = groups.join(sep) + (frac ? `[.,]${frac}` : "");
  return new RegExp(`(?<![\\d.,])${pattern}(?![\\d]|[.,]\\d)`).test(a);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** The answer gives the date `iso` (YYYY-MM-DD) in any common English or ISO form. */
function date(a, iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const month = MONTHS[m - 1];
  const mon = `(?:${month}|${month.slice(0, 3)}\\.?)`;
  const day = `0?${d}(?:st|nd|rd|th)?`;
  return [
    new RegExp(`${y}-0?${m}-0?${d}(?!\\d)`),
    new RegExp(`${mon}\\s+${day},?\\s+${y}`, "i"),
    new RegExp(`(?<!\\d)${day}\\s+${mon},?\\s+${y}`, "i"),
  ].some((r) => r.test(a));
}

/** Every one of `names` (each a name or a list of its spellings) is in the answer. */
const all = (a, names) => names.every((n) => [n].flat().some((s) => new RegExp(`\\b${s}\\b`, "i").test(a)));
/** None of `names` is in the answer. */
const none = (a, names) => !names.some((n) => new RegExp(`\\b${n}\\b`, "i").test(a));

export const TASKS = {
  T1: {
    title: "Wikipedia: infobox and language menu",
    sites: ["en.wikipedia.org", "de.wikipedia.org"],
    prompt:
      "Open the English Wikipedia article on the Rhine. Report the river's length and the countries listed in its " +
      "infobox. Then use the article's language menu to open the German article, and report the length it gives.",
    rubric: [
      { id: "en_length", type: "fixed", text: "English length as in the infobox.", check: (a, key) => number(a, key.en_length) },
      {
        id: "countries",
        type: "fixed",
        text: "Every country in the infobox, no extra ones.",
        check: (a, key) => all(a, key.countries) && none(a, key.not_countries),
      },
      { id: "de_page", type: "trajectory", text: "Reached the German article (de.wikipedia.org, \"Rhein\").", visited: /de\.wikipedia\.org\/wiki\/Rhein(?![\w%])/i },
      { id: "de_length", type: "fixed", text: "German length as in its infobox.", check: (a, key) => number(a, key.de_length) },
    ],
  },
  T2: {
    title: "MDN: browser-compatibility table",
    sites: ["developer.mozilla.org"],
    prompt:
      "On MDN, find the reference page for Array.prototype.findLast(). From its browser compatibility table, " +
      "report the first version of Chrome, Firefox and Safari that supports it.",
    rubric: [
      { id: "page", type: "trajectory", text: "Reached the findLast() reference page.", visited: /developer\.mozilla\.org\/[a-z-]+\/docs\/Web\/JavaScript\/Reference\/Global_Objects\/Array\/findLast\b/i },
      { id: "chrome", type: "fixed", text: "Chrome version.", check: (a, key) => near("Chrome(?! Android)", key.chrome).test(a) },
      { id: "firefox", type: "fixed", text: "Firefox version.", check: (a, key) => near("Firefox(?! for Android)", key.firefox).test(a) },
      { id: "safari", type: "fixed", text: "Safari version.", check: (a, key) => near("Safari(?! on iOS)", key.safari).test(a) },
    ],
  },
  T3: {
    title: "Python docs: version menu and search",
    sites: ["docs.python.org"],
    prompt:
      "On docs.python.org, switch the documentation to Python 3.9 with its version menu. Then find str.removeprefix() " +
      "and report the version note shown under it, word for word, and the URL of the page.",
    rubric: [
      { id: "docs_39", type: "trajectory", text: "The page is the 3.9 documentation.", visited: /docs\.python\.org\/3\.9\//i },
      { id: "found", type: "trajectory", text: "Found str.removeprefix().", visited: /docs\.python\.org\/3\.9\/library\/stdtypes\.html/i },
      { id: "note", type: "fixed", text: "The version note, word for word.", check: (a, key) => says(a, key.note) },
      { id: "url", type: "fixed", text: "The page URL (with or without the anchor).", check: (a, key) => a.includes(key.url) },
    ],
  },
  T4: {
    title: "arXiv: advanced search form",
    sites: ["arxiv.org"],
    prompt:
      // Since round 2, "the exact phrase": round 1's "whose title contains 'speculative decoding'" read two
      // ways, the words (50 results) or the phrase (47), and its key had only the first (docs/eval/live-round1.md).
      "Use arXiv's Advanced Search to find papers with the exact phrase 'speculative decoding' in the title, in Computer Science, " +
      "submitted from 2024-01-01 to 2024-12-31. Sort the results oldest first. Report the number of results and the " +
      "title of the first one.",
    rubric: [
      {
        id: "title_term",
        type: "trajectory",
        text: "Title-only search term.",
        visited: /arxiv\.org\/search\/advanced\?(?=\S*terms-0-term=(?:"|%22)?speculative(?:\+|%20)decoding)(?=\S*terms-0-field=title\b)/i,
      },
      {
        id: "filters",
        type: "trajectory",
        text: "Computer Science and the 2024 date range applied.",
        visited: /arxiv\.org\/search\/advanced\?(?=\S*classification-computer_science=y)(?=\S*date-from_date=2024-01-01)(?=\S*date-to_date=2024-12-31)/i,
      },
      { id: "count", type: "fixed", text: "Result count.", check: (a, key) => number(a, key.count) },
      { id: "first_title", type: "fixed", text: "Title of the oldest result.", check: (a, key) => says(a, key.first_title) },
    ],
  },
  T5: {
    title: "PyPI: project page and release history",
    sites: ["pypi.org"],
    prompt:
      "On pypi.org, open the page of the 'requests' project. Report its latest version and that version's release " +
      "date. Then open its release history and report the oldest release and its date.",
    rubric: [
      { id: "latest", type: "live", text: "Latest version as the run's read of the project page showed it." },
      { id: "latest_date", type: "live", text: "That version's release date, as that read showed it." },
      { id: "oldest", type: "fixed", text: "Oldest release.", check: (a, key) => new RegExp(`(?<![\\d.])${key.oldest.replace(/\./g, "\\.")}(?![\\d.]*\\d)`).test(a) },
      { id: "oldest_date", type: "fixed", text: "Its date.", check: (a, key) => date(a, key.oldest_date) },
    ],
  },
  T6: {
    title: "OpenStreetMap: search and feature tags",
    sites: ["www.openstreetmap.org"],
    prompt:
      "On openstreetmap.org, search for 'Eiffel Tower' and open the tower itself (not a stop or shop nearby). Report " +
      "its OSM object type and id, and its 'height' and 'wikidata' tags.",
    rubric: [
      {
        id: "object",
        type: "fixed",
        text: "The tower's object (type and id).",
        check: (a, key) => new RegExp(`\\b${key.type}\\b`, "i").test(a) && number(a, key.id),
      },
      { id: "height", type: "fixed", text: "height tag.", check: (a, key) => near("height", key.height, 40).test(a) },
      { id: "wikidata", type: "fixed", text: "wikidata tag.", check: (a, key) => new RegExp(`\\b${key.wikidata}\\b`).test(a) },
    ],
  },
  T7: {
    title: "Can I use: live search",
    sites: ["caniuse.com"],
    prompt:
      "On caniuse.com, look up the CSS :has() selector. Report the global percentage of users with full support, as " +
      "shown, and the first Firefox version that supports it.",
    rubric: [
      { id: "feature", type: "trajectory", text: "Reached the :has() feature.", visited: /caniuse\.com\/(?:css-has\b|\?search=\S*has)/i },
      { id: "global", type: "live", text: "Global full-support percentage as the run's read of the page showed it." },
      { id: "firefox", type: "fixed", text: "First Firefox version.", check: (a, key) => near("Firefox", key.firefox).test(a) },
    ],
  },
  T8: {
    title: "timeanddate.com: date calculator",
    sites: ["www.timeanddate.com"],
    prompt:
      "Use timeanddate.com's Date Duration calculator (days between two dates). Count the days from 15 January 2026 " +
      "to 20 November 2026, end date not included. Then count them again with weekends excluded. Report both numbers.",
    rubric: [
      { id: "calculator", type: "live", text: "Used timeanddate.com's calculator with both dates (not computed by hand)." },
      { id: "days", type: "fixed", text: "Day count.", check: (a, key) => new RegExp(`(?<![\\d,])${key.days}(?![\\d])`).test(a) },
      { id: "weekdays", type: "fixed", text: "Weekend-excluded day count.", check: (a, key) => new RegExp(`(?<![\\d,])${key.weekdays}(?![\\d])`).test(a) },
    ],
  },
  T9: {
    title: "Project Gutenberg: a download",
    sites: ["www.gutenberg.org"],
    prompt:
      "On gutenberg.org, find Pride and Prejudice by Jane Austen and download its 'Plain Text UTF-8' file through the " +
      "browser. Report the file's size in bytes and the title line it starts with, then delete the file.",
    rubric: [
      { id: "downloaded", type: "live", text: "Downloaded through the browser (the browser's download, not a fetch of the file's URL)." },
      { id: "size", type: "fixed", text: "Size in bytes.", check: (a, key) => number(a, key.bytes) },
      { id: "title_line", type: "fixed", text: "Title line.", check: (a, key) => says(a, key.title_line) },
      { id: "deleted", type: "live", text: "Deleted the downloaded file." },
    ],
  },
  T10: {
    title: "A PDF in the browser's viewer",
    sites: ["arxiv.org"],
    prompt:
      "Open the PDF of arXiv paper 1706.03762 ('Attention Is All You Need') in the browser, without downloading it. " +
      "From the paper's Table 2, report the EN-DE BLEU score of 'Transformer (big)'.",
    rubric: [
      { id: "viewer", type: "trajectory", text: "Opened the PDF in the viewer.", visited: /arxiv\.org\/pdf\/1706\.03762/i },
      { id: "table2", type: "live", text: "Found Table 2 in the PDF." },
      { id: "bleu", type: "fixed", text: "The BLEU score.", check: (a, key) => number(a, key.bleu) },
    ],
  },
  T11: {
    title: "Shoelace docs: a dialog in shadow DOM",
    sites: ["shoelace.style"],
    prompt:
      "On the Shoelace documentation site, open the Dialog component's page. In its first example, open the dialog and " +
      "report its title and body text, then close it with its own Close button and confirm it closed.",
    rubric: [
      { id: "opened", type: "live", text: "Opened the first example's dialog." },
      { id: "text", type: "fixed", text: "Title and body text.", check: (a, key) => says(a, key.title) && says(a, key.body) },
      { id: "closed", type: "live", text: "Closed it with the dialog's own Close button." },
      { id: "confirmed", type: "live", text: "Confirmed from the page that it closed." },
    ],
  },
  T12: {
    title: "W3Schools Tryit: frames and a code editor",
    sites: ["www.w3schools.com"],
    prompt:
      "Open the 'Try it Yourself' editor of the first example on W3Schools' HTML <select> tag page. In the result " +
      "pane, choose 'Audi' and report what was selected before. Then in the code, rename the option 'Volvo' to 'Zen', " +
      "run it, and report the dropdown's options from the result pane.",
    rubric: [
      { id: "before", type: "live", text: "The option selected before 'Audi', as the run's read of the result pane showed it." },
      { id: "audi", type: "live", text: "Chose 'Audi' in the result pane." },
      { id: "edited", type: "live", text: "Renamed 'Volvo' to 'Zen' in the code and ran it." },
      { id: "options", type: "fixed", text: "The new option list.", check: (a, key) => all(a, key.options) },
    ],
  },
  T13: {
    title: "Hacker News: front page and comments",
    sites: ["news.ycombinator.com"],
    prompt:
      "On news.ycombinator.com, find the story ranked #10 on the front page right now. Report its title, points and " +
      "number of comments. Then open its comments page and report the username of the first top-level comment's author.",
    rubric: [
      { id: "title", type: "live", text: "The #10 story's title, as the run's own read of the front page shows it." },
      { id: "counts", type: "live", text: "Its points and comment count, as that read shows them." },
      { id: "commenter", type: "live", text: "The username of the first top-level comment's author on its comments page." },
    ],
  },
  T14: {
    title: "dev.to: infinite scroll",
    sites: ["dev.to"],
    prompt:
      "On dev.to, search for 'webassembly' and sort by most recent. Scroll until at least 30 posts have loaded. Report " +
      "the title and date of the 30th post.",
    rubric: [
      { id: "search_sort", type: "trajectory", text: "Search and sort applied.", visited: /dev\.to\/search\?(?=\S*q=webassembly)(?=\S*sort_by=published_at)/i },
      { id: "loaded", type: "live", text: "At least 30 posts loaded, as the run's reads show." },
      { id: "post30", type: "live", text: "The 30th post's title and date, as those reads show them." },
    ],
  },
  T15: {
    title: "Two Pages: Firefox and Chrome releases",
    sites: ["www.mozilla.org", "chromereleases.googleblog.com"],
    prompt:
      "In one task, open Firefox's release notes on mozilla.org in one page and the Chrome Releases blog in another. " +
      "Report the current stable version of each and its release date, and say which was released more recently.",
    rubric: [
      { id: "firefox", type: "live", text: "Firefox's stable version and its date, as the run's read of mozilla.org showed them." },
      { id: "chrome", type: "live", text: "Chrome's stable version and date, from the newest 'Stable Channel Update for Desktop' post the run read." },
      { id: "two_pages", type: "live", text: "Both read in one task, in two pages." },
      { id: "comparison", type: "live", text: "The right comparison of the two dates." },
    ],
  },
};
