import { expect, test } from 'vitest'
import { compareConnectionIdentities } from './combinedIdentity'

const id = 'UCabcdefghijklmnopqrstuv'
const other = 'UC0000000000000000000000'

const fixture = () => {
	let generation = 'first'
	let revision = 'first'
	let apiId = id
	const options = {
		store: { read: async () => ({ generation,
			profile: { channelId: id, name: 'Cookie profile' } }) } as never,
		service: { channels: { list: async () => ({ data: { items: [
			{ id: apiId, snippet: { title: 'API profile' } },
		] } }) } } as never,
		loadAuth: async () => ({} as never),
		authRevision: async () => revision,
	}
	return { options, setGeneration: () => { generation = 'second' },
		setRevision: () => { revision = 'second' },
		setApiId: (value: string) => { apiId = value } }
}

test('compares canonical profile IDs, not names', async () => {
	const f = fixture()
	expect((await compareConnectionIdentities(f.options)).matches).toBe(true)
	f.setApiId(other)
	expect((await compareConnectionIdentities(f.options)).matches).toBe(false)
})

test('rejects a cookie or authorization changed during the network read',
	async () => {
		for (const change of ['cookie', 'auth']) {
			const f = fixture()
			f.options.loadAuth = async () => {
				if (change === 'cookie') f.setGeneration()
				else f.setRevision()
				return {} as never
			}
			await expect(compareConnectionIdentities(f.options))
				.rejects.toThrow(/changed/)
		}
	})

test('does not report a match when credentials or cookie are unavailable',
	async () => {
		const f = fixture()
		f.options.loadAuth = async () => { throw new Error('unavailable') }
		await expect(compareConnectionIdentities(f.options)).rejects.toThrow()
		const noCookie = { ...f.options,
			store: { read: async () => null } as never }
		await expect(compareConnectionIdentities(noCookie)).rejects.toThrow()
	})
