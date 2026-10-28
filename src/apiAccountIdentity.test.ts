import { expect, test } from 'vitest'
import { init } from './database'
import { Config } from './config'
import { ApiAccountIdentity } from './apiAccountIdentity'

test('binds the verified API account and rejects replacements', async () => {
	const db = await init({ filename: ':memory:' })
	let account = 'UC0000000000000000000001'
	let revision = 'first'
	const service = { channels: { list: async () => ({ data: { items: [
		{ id: account, snippet: { title: 'Fixture' } },
	] } }) } } as never
	const config = { mode: 'youtube' } as Config
	const identity = new ApiAccountIdentity(db, config, service,
		async () => ({} as never), async () => revision)
	try {
		expect(await identity.expected()).toBe(account)
		account = 'UC0000000000000000000002'
		await expect(identity.verify({} as never)).rejects.toThrow(/match/)
		expect(await identity.expected()).toBe('UC0000000000000000000001')
		revision = 'second'
		config.mode = 'whitelist'
		await expect(identity.verify({} as never)).rejects.toThrow(/mode/)
	} finally { await db.close() }
})

test('does not bind an identity when authorization changes during the read',
	async () => {
		const db = await init({ filename: ':memory:' })
		let revision = 'first'
		const service = { channels: { list: async () => {
			revision = 'second'
			return { data: { items: [{ id: 'UC0000000000000000000001' }] } }
		} } } as never
		const identity = new ApiAccountIdentity(db, { mode: 'youtube' } as Config,
			service, async () => ({} as never), async () => revision)
		try {
			await expect(identity.expected()).rejects.toThrow(/changed/)
			expect(await identity.stored()).toBeNull()
		} finally { await db.close() }
	})
