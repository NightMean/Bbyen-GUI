import { expect, test } from 'vitest'
import { init } from './database'
import { Config } from './config'
import { ApiPolicyPreview } from './apiPolicyPreview'

test('reviews changes and refuses a stale or expired review', async () => {
	const db = await init({ filename: ':memory:' })
	const first = 'UC0000000000000000000001'
	const muted = 'UC0000000000000000000002'
	const manual = 'UC0000000000000000000003'
	const config = { mode: 'youtube', emailSelectionPolicy: 'allowlist',
		whitelistedChannelIds: [], blacklistedChannelIds: [],
		channelSettingsById: new Map([[muted, { id: muted, notify: false }]])
	} as unknown as Config
	let now = 0
	const preview = new ApiPolicyPreview(db, config, () => now)
	try {
		for (const id of [first, muted, manual]) {
			await db.run('INSERT INTO subscriptions ' +
				'(channelId, channelTitle, channelThumbnail) VALUES (?, ?, ?)',
			id, id, '')
		}
		await db.run('INSERT INTO channel_sources ' +
			'(channelId, manual, apiSubscribed) VALUES (?, 1, 0)', manual)
		const reviewed = await preview.review('blocklist')
		expect(reviewed.changes).toEqual([{ channelId: first, title: first,
			before: 'excluded', after: 'eligible' }])
		config.blacklistedChannelIds = [{ id: first }]
		await expect(preview.confirm(reviewed.previewId, 'blocklist'))
			.rejects.toThrow(/changed/)
		config.blacklistedChannelIds = []
		const valid = await preview.review('blocklist')
		await preview.confirm(valid.previewId, 'blocklist')
		await expect(preview.confirm(valid.previewId, 'blocklist'))
			.rejects.toThrow()
		const expired = await preview.review('blocklist')
		now += 10 * 60_000
		await expect(preview.confirm(expired.previewId, 'blocklist'))
			.rejects.toThrow()
	} finally { await db.close() }
})
