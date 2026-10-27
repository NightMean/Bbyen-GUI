import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { Config } from './config'
import { saveUnsubscribePreference } from './unsubscribePreference'

test('saves and restores the confirmation preference without other changes',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-prompt-'))
		const file = path.join(dir, 'config.json')
		const config = {} as Config
		try {
			await fs.writeFile(file, JSON.stringify({ other: 'preserved' }))
			await saveUnsubscribePreference(file, config, false)
			expect(config.confirmUnsubscribe).toBe(false)
			expect(JSON.parse(await fs.readFile(file, 'utf8')))
				.toEqual({ other: 'preserved', confirmUnsubscribe: false })
			await saveUnsubscribePreference(file, config, true)
			expect(config.confirmUnsubscribe).toBe(true)
			expect(JSON.parse(await fs.readFile(file, 'utf8')).confirmUnsubscribe)
				.toBe(true)
		} finally { await fs.rm(dir, { recursive: true, force: true }) }
	})
