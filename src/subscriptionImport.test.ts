import { expect, test } from 'vitest'
import { parseSubscriptionImport } from './subscriptionImport'

test('parses legacy lists and discards unrelated configuration', () => {
	const id = 'UCabcdefghijklmnopqrstuv'
	const parsed = parseSubscriptionImport({ whitelistedChannelIds: [id],
		blacklistedChannelIds: [{ id, notify: false,
			initialBacklog: { mode: 'newest', count: 2 } }],
		email: { auth: { pass: 'fixture-private' } }, cookies: 'fixture-private' })
	expect(parsed.lists.whitelistedChannelIds).toEqual([{ id }])
	expect(parsed.lists.blacklistedChannelIds?.[0].initialBacklog)
		.toEqual({ mode: 'newest', count: 2 })
	expect(parsed.problems).toEqual([])
	expect(JSON.stringify(parsed)).not.toContain('fixture-private')
})

test('reports invalid entries without retaining their contents', () => {
	const id = 'UCabcdefghijklmnopqrstuv'
	const parsed = parseSubscriptionImport({ whitelistedChannelIds: [
		id, id, { id: 'invalid-fixture-private' }, { id, notify: 'yes' },
	] })
	expect(parsed.lists.whitelistedChannelIds).toEqual([{ id }])
	expect(parsed.problems.map(problem => problem.index)).toEqual([1, 2, 3])
	expect(JSON.stringify(parsed)).not.toContain('fixture-private')
})

test('rejects invalid formats without treating absent lists as empty', () => {
	expect(() => parseSubscriptionImport({ formatVersion: 2,
		whitelistedChannelIds: [] })).toThrow()
	expect(() => parseSubscriptionImport({ whitelistedChannelIds: 'invalid' }))
		.toThrow()
	expect(parseSubscriptionImport({ formatVersion: 1,
		whitelistedChannelIds: [], blacklistedChannelIds: null }).lists)
		.toMatchObject({ whitelistedChannelIds: [], blacklistedChannelIds: null })
})
