// Ego's process-wide knobs, under Ego's names so that Ego's cases and
// runners configure zenius the same way. They're read lazily, at each call,
// as Ego's page model reads them: a script may set process.env before its
// first call, as Ego's own e2e cases do.

/** EGO_BROWSER_RESPONSE_TIMEOUT_MS: a positive integer, else the runtime's default. */
export function configuredResponseTimeout(): number | undefined {
  return positiveInteger(process.env.EGO_BROWSER_RESPONSE_TIMEOUT_MS);
}

/**
 * EGO_BROWSER_PAGE_BUDGET: how many managed Pages a task space may hold.
 * Parsed as Ego parses it; anything but a positive integer leaves the
 * runtime's default, Ego's 8.
 */
export function configuredPageBudget(): number | undefined {
  return positiveInteger(process.env.EGO_BROWSER_PAGE_BUDGET);
}

function positiveInteger(value: string | undefined): number | undefined {
  const configured = Number(value);
  return Number.isInteger(configured) && configured > 0 ? configured : undefined;
}
