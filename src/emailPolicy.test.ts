import { expect, test } from 'vitest'
import { makeEmailEligibility, parseEmailSelectionPolicy } from './emailPolicy'

test('allowlist, blocklist, and mute have independent effects', () => {
	const base = { mode: 'youtube' as const,
		whitelistedChannelIds: [{ id: 'allowed' }, { id: 'both' }],
		blacklistedChannelIds: [{ id: 'blocked' }, { id: 'both' }] }
	const allow = makeEmailEligibility({ ...base,
		emailSelectionPolicy: 'allowlist' })
	const block = makeEmailEligibility({ ...base,
		emailSelectionPolicy: 'blocklist' })
	expect(['allowed', 'blocked', 'both', 'other'].map(id => allow(id)))
		.toEqual(['eligible', 'excluded', 'excluded', 'excluded'])
	expect(['allowed', 'blocked', 'both', 'other'].map(id => block(id)))
		.toEqual(['eligible', 'excluded', 'excluded', 'eligible'])
	expect(block('allowed', { id: 'allowed', notify: false })).toBe('muted')
	expect(makeEmailEligibility({ ...base, mode: 'whitelist',
		emailSelectionPolicy: 'allowlist' })('other')).toBe('eligible')
	expect(makeEmailEligibility({ ...base, whitelistedChannelIds: [],
		emailSelectionPolicy: 'allowlist' })('other')).toBe('excluded')
	expect(makeEmailEligibility({ ...base, blacklistedChannelIds: [],
		emailSelectionPolicy: 'blocklist' })('other')).toBe('eligible')
})

test('invalid policies are rejected', () => {
	for (const value of [null, 'all', 1, {}]) {
		expect(() => parseEmailSelectionPolicy(value))
			.toThrow('emailSelectionPolicy')
	}
})
