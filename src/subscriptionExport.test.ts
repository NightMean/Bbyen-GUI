import { expect, test } from 'vitest'
import { Config } from './config'
import { exportSubscriptions } from './subscriptionExport'

test('exports only supported settings and preserves absent lists', () => {
	const config = { whitelistedChannelIds: [{ id: 'channel', notify: false,
		unrelated: 'fixture-private-value', initialBacklog: { mode: 'none' } }],
	blacklistedChannelIds: [], email: { auth: { pass: 'fixture-secret' } },
	} as unknown as Config
	const result = exportSubscriptions(config)
	expect(result).toEqual({ formatVersion: 1,
		whitelistedChannelIds: [{ id: 'channel', notify: false,
			initialBacklog: { mode: 'none' } }],
		blacklistedChannelIds: [], manualChannelIds: null,
		savedChannelSettings: null })
	expect(JSON.stringify(result)).not.toContain('fixture')
})
