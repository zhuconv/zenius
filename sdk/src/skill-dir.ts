// Where the zenius Skill lives: skill/zenius in the repository, with the
// references, agent metadata and site learnings agents read.

import { url } from "./node.ts";

/**
 * The Skill directory. This module sits one level below sdk/ both as source
 * (src/) and inside the bundle (dist/zenius.mjs), so one relative URL serves
 * both.
 */
export function skillDir(): string {
  return url.fileURLToPath(new URL("../../skill/zenius/", import.meta.url));
}
