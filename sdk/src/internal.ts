// Symbol-keyed hooks shared by the SDK's own classes. Symbols keep them out of
// the agent-visible surface: help(), the alignment test and Object.keys() only
// see the documented API.

export const REQUEST = Symbol("zenius.request");
export const NOTE_ENTRY = Symbol("zenius.noteEntry");
export const EXPLAIN_PAGE_ERROR = Symbol("zenius.explainPageError");
export const CONSTRUCT = Symbol("zenius.construct");
export const SEED_PAGES = Symbol("zenius.seedPages");
