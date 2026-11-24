/* Agent Sidebar: pins in All tasks, and the sidebar's own names for the
 * tasks other programs drive, so a right-click on any task offers at least
 * Pin and Rename (the menu is directory.sys.mjs's).
 *
 * A pinned task shows in Pinned, at the top of All tasks, until the user
 * unpins or archives it, and PIN_CAP is the most there can be. The 60-task
 * cap (AgentService.pruneTasks) never takes a pinned task.
 *
 * The sidebar's own tasks keep their pin on the task (conv.pinnedAt, in
 * TASKS_FILE with the task). A task another program drives
 * (external.sys.mjs) is made again from zenius's feed, so its pin and the
 * name the user gave it in the sidebar are kept here, by the task's id and
 * its start (the feed's createdAt): a new task that zenius gives the same id
 * later takes neither. They show while the feed keeps the task, as its
 * archive does (AgentService.archivedAtOf), and TASKS_FILE keeps them
 * across a restart. Its program keeps its own name for it: zenius's strip,
 * its tabs' tags and a script's taskSpace go by that.
 */

export const PIN_CAP = 20;

// Marks of tasks the feed may have dropped since stay too, the newest this
// many: a pinned task the feed keeps is always among them.
const KEPT = 100;
const LABEL_MAX = 80;

function plainMark(mark, extra) {
  if (!Number.isSafeInteger(mark?.space) || !Number.isFinite(mark?.createdAt)) {
    return null;
  }
  const value = extra(mark);
  return value === null ? null : { space: mark.space, createdAt: mark.createdAt, ...value };
}

const pinOf = mark => plainMark(mark, m => (Number.isFinite(m.at) ? { at: m.at } : null));
// AgentService.labelTask cuts a name at LABEL_MAX characters (oneLine's code
// points), so count those, not UTF-16 units: a name of emoji has twice as
// many.
const labelOf = mark =>
  plainMark(mark, m => (typeof m.label === "string" && m.label && Array.from(m.label).length <= LABEL_MAX ? { label: m.label } : null));

/** The pins and names of the tasks other programs drive (AgentService.marks). */
export class ExternalMarks {
  /** @type {{space: number, createdAt: number, at: number}[]} */
  pins = [];
  /** @type {{space: number, createdAt: number, label: string}[]} */
  labels = [];

  /** When the user pinned the task with this id and start, else null. */
  pinnedAtOf(space, createdAt) {
    return this.pins.findLast(p => p.space === space && p.createdAt === createdAt)?.at ?? null;
  }

  /** The sidebar's name for the task with this id and start, else null. */
  labelOf(space, createdAt) {
    return this.labels.findLast(l => l.space === space && l.createdAt === createdAt)?.label ?? null;
  }

  pin(space, createdAt, at) {
    this.unpin(space, createdAt);
    const mark = pinOf({ space, createdAt, at });
    if (mark) {
      this.pins = [...this.pins, mark].slice(-KEPT);
    }
  }

  unpin(space, createdAt) {
    this.pins = this.pins.filter(p => !(p.space === space && p.createdAt === createdAt));
  }

  /** The sidebar's name for the task, or none (null: its program's name again). */
  label(space, createdAt, label) {
    this.labels = this.labels.filter(l => !(l.space === space && l.createdAt === createdAt));
    const mark = label ? labelOf({ space, createdAt, label }) : null;
    if (mark) {
      this.labels = [...this.labels, mark].slice(-KEPT);
    }
  }

  /** For TASKS_FILE. */
  toJSON() {
    return { pinned: this.pins.slice(-KEPT), labels: this.labels.slice(-KEPT) };
  }

  /**
   * TASKS_FILE's marks, before the ones made since the runtime started. A
   * file from before pins has none, and loads as it was.
   */
  restore(data) {
    const list = (value, of) => (Array.isArray(value) ? value.map(of).filter(Boolean) : []);
    this.pins = [...list(data?.pinned, pinOf), ...this.pins].slice(-KEPT);
    this.labels = [...list(data?.labels, labelOf), ...this.labels].slice(-KEPT);
  }
}
