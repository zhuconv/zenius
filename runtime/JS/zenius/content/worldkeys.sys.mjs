// The names the agent's world shares between the content and parent
// processes (zen-observe; docs/research/isolated-world.md). They have a
// module of their own, so the parent needn't evaluate content/agentworld.sys.mjs
// (its setup source and tables) to read them.

/** sharedData: the documents (innerWindowId) the agent's world wrote into. */
export const WRITTEN_DOCS_KEY = "zenius:writtenDocs";
/** sharedData: the top documents (innerWindowId) the agent made, from data: or blob:. */
export const MADE_DOCS_KEY = "zenius:madeDocs";

/** The file name of the agent's code in its world: its frames are known on any stack by it. */
export const WORLD_URL = "zenius://agent-world";
