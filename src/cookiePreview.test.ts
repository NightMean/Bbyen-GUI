import { expect, test } from 'vitest'
import { init } from './database'
import { CookiePreviewService } from './cookiePreview'
import { ChannelBellState } from './lib/innertubeChannels'

const first = 'UC0000000000000000000001'
const second = 'UC0000000000000000000002'
const third = 'UC0000000000000000000003'
const profile = { name: 'Profile', selected: true, channelId: third,
	selectable: true }
const channel = (
	channelId: string, state: 'all' | 'personalized' | 'unknown',
) =>
	({ channelId, title: channelId, notificationState: state,
		isAllNotifications: state === 'all' })

test('previews tracking changes without exposing cookies', async () => {
	const db = await init({ filename: ':memory:' })
	let channels: ChannelBellState[] = [channel(first, 'unknown'),
		channel(second, 'all')]
	await db.run(`INSERT INTO subscriptions (channelId, channelTitle,
		channelThumbnail) VALUES (?, ?, 'image')`, first, 'First')
	const service = new CookiePreviewService(db, {
		discover: async () => ({ cookieHeader: 'fixture-private',
			profiles: [profile] }),
		fetch: async () => channels,
	})
	try {
		const candidate = await service.inspect('fixture')
		expect(JSON.stringify(candidate)).not.toContain('fixture-private')
		const preview = await service.compare(candidate.candidateId,
			candidate.profiles[0].profileId)
		expect(preview.start.map(item => item.channelId)).toEqual([second])
		expect(preview.continuing[0]).toMatchObject({ channelId: first,
			unconfirmed: true })
		channels = [channel(first, 'personalized'), channel(second, 'all')]
		await expect(service.confirm(candidate.candidateId, preview.previewId))
			.rejects.toThrow(/preview again/i)
		const refreshed = await service.compare(candidate.candidateId,
			candidate.profiles[0].profileId)
		expect(refreshed.stop.map(item => item.channelId)).toEqual([first])
		const confirmed = await service.confirm(candidate.candidateId,
			refreshed.previewId)
		expect(confirmed.profile.channelId).toBe(third)
		await expect(service.compare(candidate.candidateId,
			candidate.profiles[0].profileId)).rejects.toThrow(/expired/i)
	} finally { service.dispose(); await db.close() }
})

test('expires candidates before they can be confirmed', async () => {
	const db = await init({ filename: ':memory:' })
	let now = 0
	const service = new CookiePreviewService(db, {
		discover: async () => ({ cookieHeader: 'fixture', profiles: [profile] }),
		fetch: async () => [channel(first, 'all')],
	}, () => now)
	try {
		const candidate = await service.inspect('fixture')
		now = 600_001
		await expect(service.compare(candidate.candidateId,
			candidate.profiles[0].profileId)).rejects.toThrow(/expired/i)
	} finally { service.dispose(); await db.close() }
})
