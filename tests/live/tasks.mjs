// Rubric C's live-site tasks (docs/eval/live-tasks.md), as data for
// tests/live/run.mjs. Each rubric item is one of:
//   fixed       checked by script against the final answer (`check`)
//   trajectory  checked by script against the URLs the run visited (`visited`)
//   live        graded by the judge against the run's own page reads
// Answer keys come from a reference pass on the sites before the runs
// (docs/eval/live-pilot.md says when and how); zen-manager reviews them.

export const COMMON_TAIL =
  "Use the browser skill. Do not sign in, post, buy or submit anything except search and filter forms. " +
  "When done, end your task and give the answer in one short paragraph.";

/** A number in the answer within `window` characters after `label`. */
function near(label, value, window = 60) {
  const v = String(value).replace(".", "\\.");
  return new RegExp(`${label}[^\\n]{0,${window}}?(?<![\\d.])${v}(?![\\d])`, "i");
}

export const TASKS = {
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
};
