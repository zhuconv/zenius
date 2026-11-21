// Small JSON state file with coalesced writes, for state that must survive a
// browser restart (~/.zenius/state/<instance>/).

import { ensurePrivateDir, log, writePrivateJSON } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";

export class JsonStore {
  #path;
  #dir;
  #pending = null;
  #dirty = false;
  #snapshot;

  /**
   * @param {string} dir
   * @param {string} file
   * @param {() => object} snapshot  returns the data to write
   */
  constructor(dir, file, snapshot) {
    this.#dir = dir;
    this.#path = PathUtils.join(dir, file);
    this.#snapshot = snapshot;
  }

  get path() {
    return this.#path;
  }

  async load() {
    try {
      return await IOUtils.readJSON(this.#path);
    } catch (e) {
      if (e.name !== "NotFoundError") {
        log(`could not read ${this.#path}: ${e.message}; starting empty`);
      }
      return null;
    }
  }

  /** Schedule a write; several changes in one tick become one write. */
  save() {
    this.#dirty = true;
    this.#pending ??= Promise.resolve().then(() => this.#flush());
    return this.#pending;
  }

  async #flush() {
    try {
      while (this.#dirty) {
        this.#dirty = false;
        await ensurePrivateDir(this.#dir);
        await writePrivateJSON(this.#path, this.#snapshot());
      }
    } catch (e) {
      log(`could not write ${this.#path}: ${e.message}`);
    } finally {
      this.#pending = null;
    }
  }

  /** Write now (shutdown). */
  async flush() {
    this.#dirty = true;
    await (this.#pending ?? this.#flush());
  }
}
