import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { Config } from './config'
import {
	parseGeneralSettings, readGeneralSettings, saveGeneralSettings,
} from './generalSettings'

test('saves defaults and retains unrelated settings', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-general-'))
	const file = path.join(dir, 'config.json')
	const config = { notifyOnFirstScan: false,
		logging: { level: 'info', emailOnError: true } } as Config
	const settings = { initialBacklog: { mode: 'newest', count: 2 },
		videoRetentionDays: 30, videoViewDays: 14,
		activityRetentionDays: null, emailOnError: false,
		confirmUnsubscribe: true,
		notifyTitleChanges: true, notifyChannelAdded: true,
		notifyFailureReminders: false, notifyRecoveries: false }
	try {
		await fs.writeFile(file,
			JSON.stringify({ logging: config.logging, other: 1 }))
		await saveGeneralSettings(file, config, settings)
		expect(readGeneralSettings(config)).toEqual(settings)
		const saved = JSON.parse(await fs.readFile(file, 'utf8'))
		expect(saved.logging.level).toBe('info')
		expect(saved.other).toBe(1)
		expect(() => parseGeneralSettings({ ...settings, videoRetentionDays: 0 }))
			.toThrow()
		expect(() => parseGeneralSettings({ ...settings, videoViewDays: 0 }))
			.toThrow()
		expect(() => parseGeneralSettings({ ...settings, videoViewDays: 3651 }))
			.toThrow()
		expect(() => parseGeneralSettings({ ...settings, emailOnError: 'yes' }))
			.toThrow()
	} finally { await fs.rm(dir, { recursive: true, force: true }) }
})
