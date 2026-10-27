import { expect, test } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { init } from './database'
import { IncidentStore } from './incidents'

const channelId = 'UC0000000000000000000001'

test('coalesces incidents and keeps channels independent', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const store = new IncidentStore(db)
		const first = await store.record({ source: 'videos', category: 'other',
			channelId, emailEnabled: true })
		const repeated = await store.record({ source: 'videos', category: 'other',
			channelId, emailEnabled: true })
		await store.record({ source: 'videos', category: 'other',
			channelId: 'UC0000000000000000000002', emailEnabled: true })
		expect(repeated.id).toBe(first.id)
		expect(repeated.occurrences).toBe(2)
		expect(await db.get('SELECT COUNT(*) AS count FROM incidents'))
			.toEqual({ count: 2 })
	} finally { await db.close() }
})

test('recovery closes an incident and recurrence creates another', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const store = new IncidentStore(db)
		const first = await store.record({ source: 'subscriptions',
			category: 'auth', emailEnabled: true })
		await store.resolve('subscriptions', ['auth'])
		const again = await store.record({ source: 'subscriptions',
			category: 'auth', emailEnabled: true })
		expect(again.id).not.toBe(first.id)
		expect(await db.get('SELECT resolvedAt FROM incidents WHERE id=?',
			first.id))
			.toEqual({ resolvedAt: expect.any(String) })
	} finally { await db.close() }
})

test('concurrent reports share one active incident', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const store = new IncidentStore(db)
		await Promise.all(Array.from({ length: 10 }, () => store.record({
			source: 'videos', category: 'other', channelId, emailEnabled: true,
		})))
		expect(await db.get('SELECT COUNT(*) AS count, SUM(occurrences) AS total ' +
			'FROM incidents')).toEqual({ count: 1, total: 10 })
	} finally { await db.close() }
})

test('rejects unsafe context and does not persist error text', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const store = new IncidentStore(db)
		await expect(store.record({ source: 'videos', category: 'other',
			channelId: 'secret fixture', emailEnabled: true }))
			.rejects.toThrow('channel ID')
		expect(await db.get('SELECT COUNT(*) AS count FROM incidents'))
			.toEqual({ count: 0 })
	} finally { await db.close() }
})

test('active incidents survive reopening the database', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-incident-'))
	const filename = path.join(directory, 'data.sqlite')
	let db = await init({ filename })
	try {
		const first = await new IncidentStore(db).record({ source: 'videos',
			category: 'other', channelId, emailEnabled: true })
		await db.close()
		db = await init({ filename })
		const second = await new IncidentStore(db).record({ source: 'videos',
			category: 'other', channelId, emailEnabled: true })
		expect(second.id).toBe(first.id)
		expect(second.occurrences).toBe(2)
	} finally {
		await db.close()
		await fs.unlink(filename)
		await fs.rmdir(directory)
	}
})
