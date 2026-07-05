import { expect, describe, test } from 'vitest'

import { MAX_TIMER_MS, assertTimerWithinLimit } from './timerLimit'

describe('assertTimerWithinLimit', () => {
	test('returns the value when within the limit', () => {
		expect(assertTimerWithinLimit('videos', 60_000)).toBe(60_000)
	})

	test('allows exactly the maximum', () => {
		expect(assertTimerWithinLimit('videos', MAX_TIMER_MS)).toBe(MAX_TIMER_MS)
	})

	test('throws when the value exceeds the limit', () => {
		// "1 month" ~ 2,629,800,000 ms, well over the 32-bit limit.
		expect(() => assertTimerWithinLimit('videos', 2_629_800_000))
			.toThrowError(/videos/)
	})

	test('throws on a non-finite value (unparseable duration)', () => {
		expect(() => assertTimerWithinLimit('subscriptions', NaN))
			.toThrowError(/subscriptions/)
	})
})
