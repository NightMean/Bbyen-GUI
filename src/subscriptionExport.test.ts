import { expect, test } from 'vitest'
import { Config } from './config'
import { exportSubscriptions } from './subscriptionExport'
import { parseSubscriptionImport } from './subscriptionImport'

test('exports only supported settings and preserves absent lists', () => {
	const config = { whitelistedChannelIds: [{ id: 'channel', notify: false,
		manualPolicyExcluded: true, unrelated: 'fixture-private-value',
		initialBacklog: { mode: 'none' } }],
	blacklistedChannelIds: [], email: { auth: { pass: 'fixture-secret' } },
	} as unknown as Config
	const result = exportSubscriptions(config)
	expect(result).toEqual({ formatVersion: 1,
		whitelistedChannelIds: [{ id: 'channel', notify: false,
			manualPolicyExcluded: true, initialBacklog: { mode: 'none' } }],
		blacklistedChannelIds: [], manualChannelIds: null,
		savedChannelSettings: null })
	expect(JSON.stringify(result)).not.toContain('fixture')
})

test('preserves a manual email pause through export and import', () => {
	const id = 'UC0000000000000000000001'
	const exported = exportSubscriptions({ whitelistedChannelIds: [
		{ id, manualPolicyExcluded: true },
	] } as Config)
	const imported = parseSubscriptionImport(exported)
	expect(imported.problems).toEqual([])
	expect(imported.lists.whitelistedChannelIds?.[0])
		.toEqual({ id, manualPolicyExcluded: true })
})
