// Node's setInterval/setTimeout delay is a 32-bit signed integer of
// milliseconds. A larger delay overflows and is silently clamped to 1 ms,
// firing the callback continuously. Reject over-long timers at config load
// instead of letting them break at runtime.
export const MAX_TIMER_MS = 2_147_483_647

// Validate a parsed timer duration (in ms) for a named timer. Returns the value
// when valid; throws a clear error otherwise.
export const assertTimerWithinLimit = (
	name: string,
	ms: number,
): number => {
	if (!Number.isFinite(ms) || ms <= 0) {
		throw new Error(
			`Invalid duration for timers.${name}. ` +
			'Use a positive duration such as "6 hours" or "3 days".')
	}
	if (ms > MAX_TIMER_MS) {
		throw new Error(
			`timers.${name} is too long (${ms} ms). The maximum is ` +
			`${MAX_TIMER_MS} ms (about 24 days). Use a smaller interval.`)
	}
	return ms
}
