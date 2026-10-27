import { expect, test, vi } from 'vitest'
import { Config } from './config'
import { init } from './database'
import { CookieConnectionStore } from './cookieConnection'
import { CookieFileRecovery } from './cookieFileRecovery'

test('requests recovery for a changed file and bounds repeated attempts',
	async () => {
		const db = await init({ filename: ':memory:' })
		const store = new CookieConnectionStore(db)
		const config = { mode: 'cookie', cookieStale: true } as Config
		let now = 0
		let file = 'SAPISID=new-fixture'
		const refresh = vi.fn()
		try {
			await store.activate('SAPISID=old-fixture', { name: 'Profile',
				channelId: 'UC0000000000000000000001', selected: true,
				selectable: true }, [{ channelId: 'UC0000000000000000000002',
				title: 'Channel', notificationState: 'all', isAllNotifications: true }])
			const watcher = new CookieFileRecovery(config, store, async () => file,
				refresh, () => now)
			await watcher.check(); await watcher.check()
			expect(refresh).toHaveBeenCalledTimes(1)
			now += 30 * 60_000; await watcher.check()
			expect(refresh).toHaveBeenCalledTimes(2)
			file = 'SAPISID=another-fixture'; await watcher.check()
			expect(refresh).toHaveBeenCalledTimes(3)
			config.cookieStale = false; await watcher.check()
			expect(refresh).toHaveBeenCalledTimes(3)
		} finally { await db.close() }
	})
