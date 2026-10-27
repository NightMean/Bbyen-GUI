import { expect, test } from 'vitest'
import { init } from './database'

test('records title changes but not placeholders or repeated observations',
	async () => {
		const db = await init({ filename: ':memory:' })
		const id = 'UC0000000000000000000001'
		try {
			await db.run(`INSERT INTO subscriptions
				(channelId, channelTitle, channelThumbnail) VALUES (?, ?, '')`, id, id)
			for (const title of ['First', 'First', id, 'Second', 'Third']) {
				await db.run('UPDATE subscriptions SET channelTitle=? ' +
					'WHERE channelId=?', title, id)
			}
			expect(await db.all(`SELECT previousTitle, currentTitle
				FROM channel_title_events`)).toEqual([
				{ previousTitle: 'Second', currentTitle: 'Third' },
			])
		} finally { await db.close() }
	})
