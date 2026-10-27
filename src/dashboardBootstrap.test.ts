import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createServer } from 'http'
import { AddressInfo } from 'net'
import axios from 'axios'
import { expect, test } from 'vitest'
import {
	createBootstrapHandler, createInitialFiles, missingConfiguration,
} from './dashboardBootstrap'

test('creates missing files without overwriting existing config', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-first-run-'))
	const config = path.join(directory, 'config.json')
	const channels = path.join(directory, 'channels.json')
	const original = JSON.stringify({ mode: 'youtube', custom: 'preserved' })
	try {
		await fs.writeFile(config, original)
		expect(await missingConfiguration(config, channels))
			.toEqual({ config: false, channels: true })
		await createInitialFiles(config, channels, directory)
		await createInitialFiles(config, channels, directory)
		expect(await fs.readFile(config, 'utf8')).toBe(original)
		expect(JSON.parse(await fs.readFile(channels, 'utf8')))
			.toEqual({ whitelistedChannelIds: [], blacklistedChannelIds: [] })
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('retries setup without replacing files after startup fails', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-retry-'))
	const config = path.join(directory, 'config.json')
	const channels = path.join(directory, 'channels.json')
	let attempts = 0
	const handler = createBootstrapHandler({ config, channels, directory,
		start: async () => { if (++attempts === 1) throw new Error('fixture') },
	})
	const server = createServer(handler)
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	try {
		const first = await axios.post(`${url}/api/setup/manual`, {},
			{ validateStatus: () => true })
		expect(first.status).toBe(500)
		const original = await fs.readFile(config, 'utf8')
		const second = await axios.post(`${url}/api/setup/manual`, {})
		expect(second.data.ready).toBe(true)
		expect(await fs.readFile(config, 'utf8')).toBe(original)
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()))
		await fs.rm(directory, { recursive: true, force: true })
	}
})
