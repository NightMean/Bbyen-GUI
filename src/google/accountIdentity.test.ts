import { expect, test, vi } from 'vitest'
import { readAccountIdentity, sameAccount } from './accountIdentity'

const id = 'UCabcdefghijklmnopqrstuv'

test('resolves and compares only canonical YouTube channel IDs', async () => {
	const list = vi.fn().mockResolvedValue({ data: { items: [
		{ id, snippet: { title: 'Profile' } },
	] } })
	const service = { channels: { list } } as never
	const identity = await readAccountIdentity(service, {} as never)
	expect(identity).toEqual({ channelId: id, title: 'Profile' })
	expect(list).toHaveBeenCalledWith(expect.objectContaining({ mine: true }))
	expect(sameAccount(id, id)).toBe(true)
	expect(sameAccount(id, 'Brand page ID')).toBe(false)
	expect(sameAccount(id, 'UC0000000000000000000000')).toBe(false)
})

test('refuses missing, malformed, ambiguous, or paginated identities',
	async () => {
		for (const data of [ { items: [] }, { items: [{ id: 'bad' }] },
			{ items: [{ id }, { id }] },
			{ items: [{ id }], nextPageToken: 'next' } ]) {
			const service = { channels: { list: async () => ({ data }) } } as never
			await expect(readAccountIdentity(service, {} as never)).rejects.toThrow()
		}
	})
