import { expect, test, vi } from 'vitest'
import { init } from './database'
import { TitleAlerts } from './titleAlerts'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'
import { initChannelSchema } from './channelSchema'

const id = 'UC0000000000000000000001'

test('upgrades old history without sending past name changes', async () => {
	const db = await sqlite.open({ filename: ':memory:',
		driver: sqlite3.Database })
	try {
		await db.exec(`CREATE TABLE subscriptions
			(channelId TEXT, channelTitle TEXT);
			CREATE TABLE channel_title_events (id INTEGER PRIMARY KEY,
				channelId TEXT, previousTitle TEXT, currentTitle TEXT, observedAt TEXT);
			INSERT INTO channel_title_events
				VALUES (1, 'fixture', 'Old', 'New', 'x');`)
		await initChannelSchema(db)
		const event = await db.get('SELECT emailState FROM channel_title_events')
		expect(event.emailState).toBe('historical')
	} finally { await db.close() }
})

test('delivers once and preserves uncertain outcomes', async () => {
	const db = await init({ filename: ':memory:' })
	const send = vi.fn().mockResolvedValueOnce(undefined)
		.mockRejectedValueOnce(new Error('connection lost'))
	const alerts = new TitleAlerts(db, async () => send, () => undefined)
	try {
		await db.run(`INSERT INTO subscriptions
			(channelId, channelTitle, channelThumbnail) VALUES (?, 'First', '')`, id)
		await db.run('UPDATE subscriptions SET channelTitle=\'Second\'')
		await db.run('UPDATE subscriptions SET channelTitle=\'Third\'')
		await alerts.run(true)
		await alerts.run(true)
		expect(send).toHaveBeenCalledTimes(2)
		expect(send).toHaveBeenNthCalledWith(1, { channelId: id,
			previousTitle: 'First', currentTitle: 'Second' })
		expect(await db.all('SELECT emailState FROM channel_title_events ' +
			'ORDER BY id'))
			.toEqual([{ emailState: 'sent' }, { emailState: 'uncertain' }])
	} finally { await db.close() }
})

test('suppresses disabled alerts and retains pending ones without SMTP',
	async () => {
		const db = await init({ filename: ':memory:' })
		const send = vi.fn()
		let available = false
		const alerts = new TitleAlerts(db, async () => {
			if (!available) throw new Error('no SMTP')
			return send
		}, () => undefined)
		try {
			await db.run(`INSERT INTO subscriptions
				(channelId, channelTitle, channelThumbnail)
				VALUES (?, 'First', '')`, id)
			await db.run('UPDATE subscriptions SET channelTitle=\'Second\'')
			await alerts.run(false)
			await db.run('UPDATE subscriptions SET channelTitle=\'Third\'')
			await alerts.run(true)
			expect(await db.all('SELECT emailState FROM channel_title_events ' +
				'ORDER BY id'))
				.toEqual([{ emailState: 'suppressed' }, { emailState: 'pending' }])
			available = true; await alerts.run(true)
			expect(send).toHaveBeenCalledTimes(1)
			await db.run(`UPDATE channel_title_events SET emailState='sending'
				WHERE currentTitle='Third'`)
			await alerts.recoverInterrupted()
			expect((await db.get(`SELECT emailState FROM channel_title_events
				WHERE currentTitle='Third'`)).emailState).toBe('uncertain')
		} finally { await db.close() }
	})
