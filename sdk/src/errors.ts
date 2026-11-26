// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Error shapes seen by agent scripts. The runtime sends `{code, message, data}`;
// the SDK turns that into a ZeniusError carrying the same code. For the two
// codes an agent must stop on, the SDK owns the wording (as Ego does), because
// the agent has to act on the guidance, not just report it.

import { CODE_GUIDE, withNextStep } from "./error-guide.ts";
import { markHardStop } from "./output.ts";

export type WireError = { code?: unknown; message?: unknown; data?: unknown };

/**
 * Codes the runtime or the SDK can raise, each with what to do next
 * (error-guide.ts, help("errors")). Unknown future codes pass through.
 */
export const ZEN_ERROR_CODES: readonly string[] = Object.keys(CODE_GUIDE);

export class ZeniusError extends Error {
  readonly code: string;
  /** Ego scripts branch on `error_code`; keep it as an alias of `code`. */
  readonly error_code: string;
  readonly data?: Record<string, unknown>;

  constructor(code: string, message: string, data?: Record<string, unknown>, options?: ErrorOptions) {
    // What happened, then what to do next, unless the message already says it.
    super(withNextStep(code, message, data), options);
    this.name = "ZeniusError";
    this.code = code;
    this.error_code = code;
    if (data && typeof data === "object") {
      this.data = data;
      // Ego exposes details such as executionStopped and mayHaveLateEffects as
      // fields on the error itself, so scripts can read them directly.
      for (const [key, value] of Object.entries(data)) {
        if (!(key in this)) Object.defineProperty(this, key, { value, enumerable: true });
      }
    }
  }
}

const INACTIVE_GUIDANCE = [
  "This task space is no longer assigned to the agent: its task has ended, either through task.finish() or by the user, so browser commands are paused.",
  "This is a hard stop, not an obstacle to route around — do not retry and do not take ownership back on your own. takeOverTaskSpace() cannot resume an ended task.",
  "Wait until the user explicitly asks you to continue in this space, then claim it and resume:",
  "  const task = await claimTaskSpace(spaceId)",
  "",
  `Offer the user choices like "Continue" or "Done" if your harness supports it; otherwise tell them: "This task has ended and the space is yours. Reply 'continue' if you want me to resume in it."`,
].join("\n");

// The user's Stop in Zen's panel or sidebar (the core's data.reason "stopped"):
// zenius lists every task there, whoever drives it, and it ends at their word.
const STOPPED_GUIDANCE = [
  "The user stopped this task in Zen. This is a hard stop, not an obstacle to route around: don't retry, and don't start another task for the same goal.",
  "Tell the user what you finished before the stop. Continue only if they ask, by claiming the space:",
  "  const task = await claimTaskSpace(spaceId)",
].join("\n");

// A terminal agent whose harness tells it when a background command exits
// leaves `zenius wait` running (wait.ts) and goes on at the user's Resume
// agent; skill/guide.md says the same after a hand-off. hardStopGuidance puts
// in the task's id.
const BACKGROUND_WAIT =
  "If your harness tells you when a background command exits, run `zenius wait <spaceId>` as one and end your turn: it exits once the user gives the task back, and says what to do next.";

const USER_CONTROL_GUIDANCE = [
  "Control of this task space is with the user, either through task.handOff() or a takeover in the browser, so browser commands are paused.",
  "This is a hard stop, not an obstacle to route around — do not retry and do not take control back on your own.",
  `${BACKGROUND_WAIT} Tell the user to press Resume agent in Zen when they're done.`,
  "Otherwise wait until the user explicitly asks you to continue, then take control back and resume:",
  "  const task = await takeOverTaskSpace(spaceId)",
  "",
  `Without that wait, offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
].join("\n");

// A step marked secret, by handOff({ secret: true }) or by the user in Zen,
// stays the user's until their Resume agent: the core refuses takeOver and
// claim until then (data.secret, with no retryAfterMs).
const SECRET_STEP_GUIDANCE = [
  "The user's step in this task space shows a secret (your handOff() said so, or the user marked it in Zen), so the task stays theirs until they press Resume agent, which clears the page: takeOverTaskSpace() and claimTaskSpace() are refused until then.",
  "This is a hard stop, not an obstacle to route around: don't retry.",
  `${BACKGROUND_WAIT} Tell the user to press Resume agent in Zen once they've copied what they need.`,
  "Otherwise end the round: ask the user to press Resume agent when they're done, then resume with takeOverTaskSpace(spaceId) once they say they have.",
].join("\n");

function userPromptGuidance(firstLine: string): string {
  return [
    firstLine,
    "The user now controls this task space. Wait for the user to handle the prompt.",
    `${BACKGROUND_WAIT} Answering the prompt gives it back.`,
    "Otherwise resume only after the user confirms, using takeOverTaskSpace(spaceId).",
  ].join("\n");
}

const permissionPrompt = (access: string) =>
  userPromptGuidance(`A browser permission prompt for ${access} has appeared.`);

const USER_CONTROL_REASONS: Record<string, string> = {
  notifications: permissionPrompt("notifications"),
  location: permissionPrompt("location access"),
  camera: permissionPrompt("camera access"),
  microphone: permissionPrompt("microphone access"),
  pan_tilt_zoom_microphone: permissionPrompt("camera control and microphone access"),
  midi: permissionPrompt("MIDI device access"),
  bluetooth: userPromptGuidance("A browser device chooser for Bluetooth has appeared."),
  usb: userPromptGuidance("A browser device chooser for USB has appeared."),
  serial: userPromptGuidance("A browser port chooser for serial access has appeared."),
  hid: userPromptGuidance("A browser device chooser for HID has appeared."),
  protocol_handler: permissionPrompt("protocol handler registration"),
  clipboard: permissionPrompt("clipboard access"),
  local_network_access: permissionPrompt("local network access"),
  storage_access: permissionPrompt("storage access"),
  window_management: permissionPrompt("window management"),
  local_fonts: permissionPrompt("local font access"),
  permission_prompt: userPromptGuidance("A browser permission prompt or device chooser has appeared."),
  manual_takeover: USER_CONTROL_GUIDANCE,
};

/**
 * takeOver, or a claim, of a task handed to the user, refused because the user
 * used its tabs under 10 s ago (data.retryAfterMs). It ends by itself, so
 * unlike the user's control it is no hard stop.
 */
export function isUserInputWait(code: unknown, data?: Record<string, unknown>): boolean {
  return code === "ZEN_TASK_SPACE_USER_IN_CONTROL" && typeof data?.retryAfterMs === "number";
}

export function isHardStopCode(code: unknown, data?: Record<string, unknown>): boolean {
  if (isUserInputWait(code, data)) return false;
  return code === "ZEN_TASK_SPACE_USER_IN_CONTROL" || code === "ZEN_TASK_SPACE_INACTIVE";
}

/** The owned guidance for a hard-stop code, or undefined for any other code. */
export function hardStopGuidance(code: unknown, data?: Record<string, unknown>): string | undefined {
  if (code === "ZEN_TASK_SPACE_INACTIVE") return data?.reason === "stopped" ? STOPPED_GUIDANCE : INACTIVE_GUIDANCE;
  if (code !== "ZEN_TASK_SPACE_USER_IN_CONTROL" || isUserInputWait(code, data)) return undefined;
  const reason = typeof data?.reason === "string" ? data.reason : undefined;
  const guidance =
    data?.secret === true
      ? SECRET_STEP_GUIDANCE
      : (reason && Object.hasOwn(USER_CONTROL_REASONS, reason) && USER_CONTROL_REASONS[reason]) || USER_CONTROL_GUIDANCE;
  return Number.isInteger(data?.space) ? guidance.replaceAll("zenius wait <spaceId>", `zenius wait ${data!.space}`) : guidance;
}

/**
 * Build the error a script sees for a failed request. `op` is the public call
 * (`page.click`) and prefixes the message, so the agent knows which line failed
 * when a script makes many calls.
 */
export function fromWireError(error: WireError, op: string, recordHardStop = true, space?: number): Error {
  const code = typeof error?.code === "string" && error.code ? error.code : "ZEN_INTERNAL";
  const data =
    error?.data && typeof error.data === "object" && !Array.isArray(error.data)
      ? (error.data as Record<string, unknown>)
      : undefined;
  const guidance = hardStopGuidance(code, data);
  if (guidance) {
    // Recorded here, at the single birthplace of runtime errors, so the
    // guidance still reaches the agent when its own try/catch swallows the throw.
    if (recordHardStop) markHardStop(guidance, space);
    return new ZeniusError(code, `${op}: ${guidance}`, data);
  }
  const text = typeof error?.message === "string" && error.message ? error.message : code;
  // Where Ego throws a plain Error with no code (page exceptions in evaluate,
  // navigation and wait timeouts, fetch and download failures), the runtime
  // still sends a code for its own logs and marks the error plain; scripts
  // see exactly Ego's error, message included.
  if (data?.plain === true) return new Error(withNextStep(code, text, data));
  const message = text.startsWith(`${op}`) ? text : `${op}: ${text}`;
  return new ZeniusError(code, message, data);
}

export function unsupportedCdpError(api: "page.cdp" | "task.cdp"): ZeniusError {
  return new ZeniusError(
    "ZEN_UNSUPPORTED",
    `${api}() is not supported: zenius drives Zen through its own runtime, not the Chrome DevTools Protocol. ` +
      "Use the documented Page methods (click, fill, press, mouse.*, keyboard.*, waitFor*, fetch, screenshot) " +
      "or page.evaluate() for page-level work. page.events() always has the console messages (Runtime.consoleAPICalled), " +
      "dialogs, downloads and network events, with no CDP setup. Run help() for the full list.",
  );
}
