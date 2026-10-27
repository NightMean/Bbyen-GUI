import { expect, test, vi } from 'vitest'
import RSSParser from 'rss-parser'
import { init } from './database'
import { IncidentReporter } from './incidentReporter'
import { parseFeedsAndNotify } from './videos'
import { Config } from './config'

vi.mock('./lib/logger', () => ({ default: async () => ({
	info: vi.fn(), verbose: vi.fn(), warn: vi.fn(), error: vi.fn(),
}) }))

test('video recovery resolves only the affected channel incident', async () => {
	const db = await init({ filename: ':memory:' })
	const first = 'UC0000000000000000000001'
	const second = 'UC0000000000000000000002'
	try {
		for (const id of [first, second]) {
			await db.run(`INSERT INTO subscriptions
				(channelId, channelTitle, channelThumbnail) VALUES (?, ?, 'image')`,
			id, id)
		}
		const sendErrorEmail = vi.fn().mockResolvedValue(undefined)
		const alerts = new IncidentReporter(db, { warn: vi.fn() })
		const config = { mode: 'whitelist', notifyOnFirstScan: false,
			logging: { emailOnError: true } } as Config
		const args = { db, alerts, config, service: {} as never,
			sendErrorEmail, sendVideoEmail: vi.fn() }
		const parse = vi.spyOn(RSSParser.prototype, 'parseURL')
			.mockRejectedValue(new Error('private fixture'))
		await parseFeedsAndNotify(args)
		expect(sendErrorEmail).toHaveBeenCalledTimes(2)
		parse.mockImplementation(async url => {
			if (String(url).includes(second)) throw new Error('still failed')
			return { items: [] } as never
		})
		await parseFeedsAndNotify(args)
		const rows = await db.all(`SELECT channelId, resolvedAt FROM incidents
			WHERE source='videos' ORDER BY channelId`)
		expect(rows).toEqual([
			{ channelId: first, resolvedAt: expect.any(String) },
			{ channelId: second, resolvedAt: null },
		])
		expect(sendErrorEmail).toHaveBeenCalledTimes(2)
		await db.run('UPDATE subscriptions SET deleted=1')
		await parseFeedsAndNotify(args)
		expect(await db.get(`SELECT resolvedAt FROM incidents
			WHERE source='videos' AND channelId=?`, second))
			.toEqual({ resolvedAt: null })
	} finally {
		vi.restoreAllMocks()
		await db.close()
	}
})
