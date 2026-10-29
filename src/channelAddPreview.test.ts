import axios from 'axios'
import { expect, test, vi } from 'vitest'
import { init } from './database'
import { Config } from './config'
import { channelAddPreview, readPublicChannelTitle } from './channelAddPreview'

const id = 'UC0000000000000000000001'

test('reports known tracking and saved email preferences', async () => {
	const db = await init({ filename: ':memory:' })
	const config = { mode: 'whitelist', whitelistedChannelIds: [{ id }],
		channelSettingsById: new Map([[id, { id, notify: false }]]) } as Config
	try {
		expect(await channelAddPreview(db, config, id)).toEqual({ channelId: id,
			tracked: true, emailEnabled: false, title: null })
		await db.run(`INSERT INTO subscriptions
			(channelId, channelTitle, channelThumbnail) VALUES (?, 'Creator', '')`,
		id)
		expect((await channelAddPreview(db, config, id)).title).toBe('Creator')
		await db.run(`UPDATE subscriptions SET deleted=1,
			deletedReason='terminated' WHERE channelId=?`, id)
		expect((await channelAddPreview(db, config, id)).tracked).toBe(false)
	} finally { await db.close() }
})

test('reads a bounded public feed and tolerates failure', async () => {
	const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({ data:
		'<rss version="2.0"><channel><title>Creator</title></channel></rss>' })
		.mockRejectedValueOnce(new Error('unavailable'))
	try {
		expect(await readPublicChannelTitle(id)).toBe('Creator')
		expect(get.mock.calls[0][0]).toBe(
			`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`)
		expect(get.mock.calls[0][1]).toMatchObject({ timeout: 8000,
			maxRedirects: 0, maxContentLength: 1024 * 1024 })
		expect(await readPublicChannelTitle(id)).toBeNull()
		await expect(readPublicChannelTitle('invalid')).rejects.toThrow()
	} finally { get.mockRestore() }
})
