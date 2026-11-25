// Writes the skill's references about zenius itself,
// skill/zenius/references/<topic>.md, from src/docs.ts, which builds them
// from zenius's sources. After changing an error's words, a limit or a path
// rule, run it and commit what it wrote:
//
//   node sdk/scripts/write-references.ts
//
// test/docs.test.ts fails while a reference differs from what this writes.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DOC_TOPICS, referenceText } from "../src/docs.ts";

const folder = new URL("../../skill/zenius/references/", import.meta.url);
for (const { name } of DOC_TOPICS) {
  const file = new URL(`${name}.md`, folder);
  writeFileSync(file, referenceText(name));
  console.log(`wrote ${fileURLToPath(file)}`);
}
