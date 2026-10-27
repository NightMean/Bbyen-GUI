import { spawn } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { AddressInfo, createServer } from 'net'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'
import axios from 'axios'
import { expect, test } from 'vitest'
import { init } from './database'
import { CookieConnectionStore } from './cookieConnection'

test('running service renews a stale cookie from a changed file', async () => {
	const probe = createServer()
	await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
	const port = (probe.address() as AddressInfo).port
	await new Promise<void>(resolve => probe.close(() => resolve()))
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-file-service-'))
	const filename = path.join(dir, 'database.sqlite')
	const config = JSON.parse(await fs.readFile('config.example.json', 'utf8'))
	config.mode = 'whitelist'; config.database.filename = filename
	config.kickoff = { videos: false, subscriptions: false }
	await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config))
	await fs.writeFile(path.join(dir, 'channels.json'),
		JSON.stringify({ whitelistedChannelIds: [] }))
	await fs.writeFile(path.join(dir, 'cookies.txt'), 'SAPISID=new-fixture')
	const db = await init({ filename })
	const store = new CookieConnectionStore(db)
	const generation = await store.activate('SAPISID=old-fixture', {
		name: 'Profile', channelId: 'UC0000000000000000000001',
		selected: true, selectable: true,
	}, [{ channelId: 'UC0000000000000000000002', title: 'Channel',
		notificationState: 'all', isAllNotifications: true }])
	await store.markStale(generation); await db.close()
	const bootstrap = path.join(dir, 'fixture.js')
	const discovery = JSON.stringify(path.resolve('src/lib/cookieDiscovery'))
	const errorModule = JSON.stringify(path.resolve('src/lib/cookieSessionError'))
	const expireMarker = JSON.stringify(path.join(dir, 'expire-fixture'))
	await fs.writeFile(bootstrap, `
		const fs = require('fs')
		const discovery = require(${discovery})
		const { CookieSessionError } = require(${errorModule})
		discovery.fetchCookieChannels = async options => {
			if (options.cookie === 'SAPISID=old-fixture' ||
				(options.cookie === 'SAPISID=new-fixture' &&
				 fs.existsSync(${expireMarker}))) {
				throw new CookieSessionError('expired fixture')
			}
			if (!['SAPISID=new-fixture', 'SAPISID=next-fixture']
				.includes(options.cookie) ||
				options.targetProfile.channelId !== 'UC0000000000000000000001') {
				throw new Error('Unexpected fixture profile')
			}
			return [{ channelId: 'UC0000000000000000000002', title: 'Channel',
				notificationState: 'all', isAllNotifications: true }]
		}
	`)
	const env: NodeJS.ProcessEnv = { ...process.env, CONFIG_DIR: dir,
		BBYEN_DASHBOARD_PORT: String(port) }
	delete env.BBYEN_EMAIL_USER; delete env.BBYEN_EMAIL_PASS
	const args = ['-r', 'ts-node/register/transpile-only', '-r', bootstrap,
		'src/index.ts']
	const child = spawn(process.execPath, args, {
		env, stdio: ['ignore', 'pipe', 'pipe'],
	})
	child.stdout.resume(); child.stderr.resume()
	const exited = new Promise<void>(resolve =>
		child.once('exit', () => resolve()))
	try {
		const deadline = Date.now() + 15000
		let renewed = false
		while (Date.now() < deadline && child.exitCode === null) {
			try {
				const status = (await axios.get(
					`http://127.0.0.1:${port}/api/cookies/status`)).data
				if (!status.connection?.stale) {
					const check = await sqlite.open({ filename,
						driver: sqlite3.Database })
					try {
						const row = await check.get(
							'SELECT cookieHeader FROM cookie_connection')
						renewed = row.cookieHeader === 'SAPISID=new-fixture'
					} finally { await check.close() }
					if (renewed) break
				}
			} catch { /* Service is starting or recovery is in progress. */ }
			await new Promise(resolve => setTimeout(resolve, 100))
		}
		expect(renewed).toBe(true)
		expect(child.exitCode).toBeNull()
		await fs.writeFile(path.join(dir, 'expire-fixture'), '')
		await fs.writeFile(path.join(dir, 'cookies.txt'), 'SAPISID=next-fixture')
		await axios.post(`http://127.0.0.1:${port}/api/refresh`,
			{ kind: 'subscriptions' })
		let replacedAgain = false
		while (Date.now() < deadline && child.exitCode === null) {
			const check = await sqlite.open({ filename, driver: sqlite3.Database })
			try {
				const row = await check.get(
					'SELECT cookieHeader FROM cookie_connection')
				replacedAgain = row.cookieHeader === 'SAPISID=next-fixture'
			} finally { await check.close() }
			if (replacedAgain) break
			await new Promise(resolve => setTimeout(resolve, 100))
		}
		expect(replacedAgain).toBe(true)
		expect(child.exitCode).toBeNull()
	} finally {
		child.kill(); await exited
		await fs.rm(dir, { recursive: true, force: true })
	}
}, 25000)
