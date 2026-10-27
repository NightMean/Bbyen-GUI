import axios from 'axios'
import { expect, test, vi } from 'vitest'
import { fetchCookieChannels } from './cookieDiscovery'
import { discoverCookieProfiles } from './cookieProfiles'

vi.mock('axios')
vi.mock('./cookieProfiles', () => ({ discoverCookieProfiles: vi.fn() }))

test('revalidates a brand identity and delegates its request', async () => {
	const profile = { name: 'Brand', pageId: 'brand-page', selected: false,
		channelId: 'UC0000000000000000000001', selectable: true }
	vi.mocked(discoverCookieProfiles).mockResolvedValue({ cookieHeader: 'fixture',
		profiles: [profile] })
	vi.mocked(axios.post).mockResolvedValue({ data: { channelRenderer: {
		channelId: 'UC0000000000000000000002', title: { simpleText: 'Channel' },
		subscriptionButton: { subscriptionNotificationToggleButtonRenderer: {
			currentStateId: 2, states: [{ stateId: 2, state: { buttonRenderer: {
				icon: { iconType: 'NOTIFICATIONS_ACTIVE' },
			} } }],
		} },
	} } } as any)
	const result = await fetchCookieChannels({
		cookie: 'SAPISID=synthetic-fixture',
		targetProfile: profile, onProgress: () => undefined })
	expect(result).toHaveLength(1)
	const [, body, request] = vi.mocked(axios.post).mock.calls[0]
	expect((body as any).context.user.onBehalfOfUser).toBe('brand-page')
	expect((request as any).headers['X-Goog-PageId']).toBe('brand-page')
})

test('rejects a changed profile before fetching subscriptions', async () => {
	vi.mocked(axios.post).mockClear()
	vi.mocked(discoverCookieProfiles).mockResolvedValue({ cookieHeader: 'fixture',
		profiles: [] })
	await expect(fetchCookieChannels({ cookie: 'SAPISID=synthetic-fixture',
		targetProfile: { name: 'Brand', pageId: 'old', selected: false,
			channelId: 'UC0000000000000000000001', selectable: true },
		onProgress: () => undefined })).rejects.toThrow(/profile changed/i)
	expect(axios.post).not.toHaveBeenCalled()
})
