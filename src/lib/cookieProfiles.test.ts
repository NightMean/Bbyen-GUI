import { expect, test } from 'vitest'
import { discoverCookieProfiles } from './cookieProfiles'

test('resolves canonical profile IDs without using names', async () => {
	const result = await discoverCookieProfiles('SAPISID=synthetic-fixture', {
		list: async () => [
			{ accountName: 'Personal', channelHandle: '@personal', isSelected: true },
			{ accountName: 'Brand', channelHandle: '@brand', isSelected: false,
				pageId: 'brand-page' },
		],
		resolve: async handle => handle === '@personal'
			? 'UC0000000000000000000001' : 'UC0000000000000000000002',
	})
	expect(result.profiles.map(profile => ({ id: profile.channelId,
		selectable: profile.selectable }))).toEqual([
		{ id: 'UC0000000000000000000001', selectable: true },
		{ id: 'UC0000000000000000000002', selectable: true },
	])
})

test('does not select unresolved, ambiguous, or unselected primary profiles',
	async () => {
		const deps = { list: async () => [
			{ accountName: 'Selected', channelHandle: '@selected', isSelected: true },
			{ accountName: 'Other', channelHandle: '@other', isSelected: false },
		], resolve: async (handle: string) => handle === '@selected'
			? 'UC0000000000000000000001' : 'UC0000000000000000000002' }
		const result = await discoverCookieProfiles(
			'SAPISID=synthetic-fixture', deps)
		expect(result.profiles.map(profile => profile.selectable))
			.toEqual([true, false])
		await expect(discoverCookieProfiles('SAPISID=synthetic-fixture', {
			...deps, resolve: async () => 'UC0000000000000000000001',
		})).rejects.toThrow(/duplicate/i)
		await expect(discoverCookieProfiles('SID=synthetic-fixture', deps))
			.rejects.toThrow(/cookie/i)
	})
