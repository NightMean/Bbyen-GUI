import { expect, test } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { init } from './database'
import { CookieConnectionStore } from './cookieConnection'

const id = 'UC0000000000000000000001'
const channel = 'UC0000000000000000000002'
const profile = { name: 'Profile', selected: true, channelId: id,
	selectable: true }
const channels = [{ channelId: channel, title: 'Channel',
	notificationState: 'all' as const, isAllNotifications: true }]

test('stores the connection and tracking snapshot atomically', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	try {
		const old = await store.activate('SAPISID=synthetic-fixture',
			profile, channels)
		expect((await store.status())?.channelId).toBe(id)
		expect(JSON.stringify(await store.status()))
			.not.toContain('synthetic-fixture')
		const next = await store.activate('SAPISID=synthetic-fixture-2',
			profile, channels)
		await store.markStale(old)
		expect((await store.status())?.stale).toBe(false)
		await store.markStale(next)
		expect((await store.status())?.stale).toBe(true)
		expect(await db.get('SELECT deleted FROM subscriptions WHERE channelId=?',
			channel)).toEqual({ deleted: 0 })
	} finally { await db.close() }
})

test('restores the confirmed connection after opening the database again',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-cookie-'))
		const filename = path.join(dir, 'database.sqlite')
		try {
			const first = await init({ filename })
			await new CookieConnectionStore(first).activate(
				'SAPISID=synthetic-fixture', profile, channels)
			await first.close()
			const second = await init({ filename })
			try {
				const restored = await new CookieConnectionStore(second).read()
				expect(restored?.profile.channelId).toBe(id)
			} finally { await second.close() }
		} finally { await fs.rm(dir, { recursive: true, force: true }) }
	})

test('rolls back credentials and reconciliation on failure', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	try {
		await db.exec(`CREATE TRIGGER reject_cookie BEFORE INSERT
			ON cookie_connection
			BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
		await expect(store.activate('SAPISID=synthetic-fixture', profile, channels))
			.rejects.toThrow()
		expect(await store.status()).toBeNull()
		expect((await db.get('SELECT COUNT(*) AS count FROM subscriptions')).count)
			.toBe(0)
	} finally { await db.close() }
})
