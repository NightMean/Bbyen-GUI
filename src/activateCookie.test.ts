import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { Config } from './config'
import { init } from './database'
import { CookieConnectionStore } from './cookieConnection'
import { CookiePreviewService } from './cookiePreview'
import { activateConfirmedCookie } from './activateCookie'

test('activates a confirmed profile in the real database store', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-activate-'))
	const filename = path.join(dir, 'database.sqlite')
	const db = await init({ filename })
	const config = { mode: 'whitelist', database: { filename } } as Config
	const store = new CookieConnectionStore(db)
	const previews = new CookiePreviewService(db, {
		discover: async () => ({ cookieHeader: 'SAPISID=synthetic-fixture',
			profiles: [{ name: 'Profile', channelId: 'UC0000000000000000000001',
				selected: true, selectable: true }] }),
		fetch: async () => [{ channelId: 'UC0000000000000000000002',
			title: 'Channel', notificationState: 'all', isAllNotifications: true }],
	})
	try {
		const candidate = await previews.inspect('fixture')
		const preview = await previews.compare(candidate.candidateId,
			candidate.profiles[0].profileId)
		await activateConfirmedCookie(config, store, previews,
			candidate.candidateId, preview.previewId)
		expect(config.mode).toBe('cookie')
		expect((await store.status())?.channelId).toBe('UC0000000000000000000001')
		expect((await db.get('SELECT deleted FROM subscriptions')).deleted).toBe(0)
	} finally {
		previews.dispose(); await db.close()
		await fs.rm(dir, { recursive: true, force: true })
	}
})
