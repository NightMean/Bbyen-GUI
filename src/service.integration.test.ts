import { spawn } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createServer, AddressInfo } from 'net'
import axios from 'axios'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'
import { expect, test } from 'vitest'
import { init } from './database'
import { CookieConnectionStore } from './cookieConnection'

test('service startup recovers attempts and records jobs', async () => {
	const probe = createServer()
	await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
	const port = (probe.address() as AddressInfo).port
	await new Promise<void>(resolve => probe.close(() => resolve()))
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-service-'))
	const filename = path.join(directory, 'database.sqlite')
	const config = JSON.parse(await fs.readFile('config.example.json', 'utf8'))
	config.mode = 'whitelist'
	config.database.filename = filename
	config.kickoff = { videos: true, subscriptions: true }
	await fs.writeFile(path.join(directory, 'config.json'),
		JSON.stringify(config))
	await fs.writeFile(path.join(directory, 'channels.json'),
		JSON.stringify({ whitelistedChannelIds: [] }))
	const db = await init({ filename })
	await db.run(`INSERT INTO videos (videoId, channelId)
		VALUES ('pending-video', 'channel')`)
	await db.run(`INSERT INTO video_observations
		(videoId, channelId, emailOutcome)
		VALUES ('pending-video', 'channel', 'pending')`)
	await db.close()
	const child = spawn(process.execPath,
		['-r', 'ts-node/register/transpile-only', 'src/index.ts'], {
			env: { ...process.env, CONFIG_DIR: directory,
				BBYEN_DASHBOARD_PORT: String(port),
				BBYEN_EMAIL_USER: 'fixture', BBYEN_EMAIL_PASS: 'fixture' },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	let stderr = ''
	child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096) })
	child.stdout.resume()
	const exited = new Promise<void>(resolve =>
		child.once('exit', () => resolve()))
	try {
		const deadline = Date.now() + 15000
		let outcome: string | undefined
		let completed = 0
		while (Date.now() < deadline && child.exitCode === null) {
			const check = await sqlite.open({ filename, driver: sqlite3.Database })
			try {
				outcome = (await check.get(`SELECT emailOutcome
					FROM video_observations WHERE videoId='pending-video'`))?.emailOutcome
				completed = (await check.get(`SELECT COUNT(*) AS count FROM refresh_runs
					WHERE status='completed'`)).count
			} finally {
				await check.close()
			}
			if (outcome === 'uncertain' && completed === 2) break
			await new Promise(resolve => setTimeout(resolve, 100))
		}
		expect(outcome, `Service failed to recover; stderr: ${stderr}`)
			.toBe('uncertain')
		expect(completed).toBe(2)
		expect(child.exitCode).toBeNull()
		const page = await axios.get(`http://127.0.0.1:${port}/`)
		expect(page.data).toContain('/app.js')
		const strings = await axios.get(`http://127.0.0.1:${port}/en.json`)
		expect(strings.data.videos).toBe('Videos')
		const result = await axios.get(`http://127.0.0.1:${port}/api/videos`)
		expect(result.data.videos).toEqual([])
		const channelId = 'UCabcdefghijklmnopqrstuv'
		const preview = await axios.post(
			`http://127.0.0.1:${port}/api/channels/resolve`, { input: channelId })
		expect(preview.data.channelId).toBe(channelId)
		const added = await axios.post(`http://127.0.0.1:${port}/api/channels`,
			{ channelId, initialBacklog: { mode: 'newest', count: 3 } })
		expect(added.status).toBe(202)
		const saved = JSON.parse(await fs.readFile(
			path.join(directory, 'channels.json'), 'utf8'))
		const entry = { id: channelId,
			initialBacklog: { mode: 'newest', count: 3 } }
		expect(saved.whitelistedChannelIds).toEqual([entry])
		expect(saved.manualChannelIds).toEqual([entry])
	} finally {
		child.kill()
		await exited
		await fs.rm(directory, { recursive: true, force: true })
	}
}, 25000)

test('service stays up without SMTP credentials and recovers without restart',
	async () => {
		const probe = createServer()
		await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
		const port = (probe.address() as AddressInfo).port
		await new Promise<void>(resolve => probe.close(() => resolve()))
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-setup-'))
		const filename = path.join(directory, 'database.sqlite')
		const config = JSON.parse(await fs.readFile('config.example.json', 'utf8'))
		config.mode = 'whitelist'
		config.database.filename = filename
		config.timers.videos = '250 ms'
		config.kickoff = { videos: true, subscriptions: true }
		await fs.writeFile(path.join(directory, 'config.json'),
			JSON.stringify(config))
		await fs.writeFile(path.join(directory, 'channels.json'),
			JSON.stringify({ whitelistedChannelIds: [] }))
		const db = await init({ filename })
		await db.close()
		const env: NodeJS.ProcessEnv = { ...process.env, CONFIG_DIR: directory,
			BBYEN_DASHBOARD_PORT: String(port) }
		delete env.BBYEN_EMAIL_USER
		delete env.BBYEN_EMAIL_PASS
		const child = spawn(process.execPath,
			['-r', 'ts-node/register/transpile-only', 'src/index.ts'], {
				env, stdio: ['ignore', 'pipe', 'pipe'],
			})
		let stderr = ''
		child.stderr.on('data', chunk => {
			stderr = (stderr + chunk).slice(-4096)
		})
		child.stdout.resume()
		const exited = new Promise<void>(resolve =>
			child.once('exit', () => resolve()))
		try {
			const deadline = Date.now() + 15000
			let addedCredentials = false
			let recovered = false
			let smtpRecovered = false
			while (Date.now() < deadline && child.exitCode === null) {
				const check = await sqlite.open({ filename, driver: sqlite3.Database })
				let rows: { resultJson: string }[]
				try {
					rows = await check.all(`SELECT resultJson FROM refresh_runs
						WHERE kind='videos' AND status='completed'`)
					smtpRecovered = !!(await check.get(`SELECT id FROM incidents
						WHERE source='smtp' AND resolvedAt IS NOT NULL`))
				} finally { await check.close() }
				const states = rows.map(row => JSON.parse(row.resultJson).status)
				if (!addedCredentials && states.includes('failed')) {
					const url = `http://127.0.0.1:${port}/api/email`
					const settings = await axios.get(`${url}/settings`)
					expect(settings.data.settings.auth).toBeUndefined()
					const test = await axios.post(`${url}/test`, {})
					expect(test.data.outcome).toBe('uncertain')
					expect((await axios.get(`${url}/tests`)).data.tests[0].outcome)
						.toBe('uncertain')
					settings.data.settings.host = 'smtp.example.test'
					await axios.post(`${url}/settings`,
						{ settings: settings.data.settings })
					expect((await axios.get(`${url}/settings`)).data.settings.host)
						.toBe('smtp.example.test')
					await axios.post(`${url}/credentials`, { credentials: {
						user: 'fixture', pass: 'fixture',
					} })
					addedCredentials = true
				}
				if (addedCredentials && states.includes('success') && smtpRecovered) {
					recovered = true
					break
				}
				await new Promise(resolve => setTimeout(resolve, 100))
			}
			expect(recovered, `Service did not recover; stderr: ${stderr}`).toBe(true)
			expect(smtpRecovered).toBe(true)
			expect(child.exitCode).toBeNull()
		} finally {
			child.kill()
			await exited
			await fs.rm(directory, { recursive: true, force: true })
		}
	}, 25000)

test('service remains up when OAuth credentials are missing', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-auth-'))
	const filename = path.join(directory, 'database.sqlite')
	const config = JSON.parse(await fs.readFile('config.example.json', 'utf8'))
	config.mode = 'youtube'
	config.database.filename = filename
	config.logging.emailOnError = false
	config.kickoff = { videos: true, subscriptions: true }
	await fs.writeFile(path.join(directory, 'config.json'),
		JSON.stringify(config))
	await fs.writeFile(path.join(directory, 'channels.json'),
		JSON.stringify({ whitelistedChannelIds: [] }))
	const db = await init({ filename })
	await db.close()
	const child = spawn(process.execPath,
		['-r', 'ts-node/register/transpile-only', 'src/index.ts'], {
			env: { ...process.env, CONFIG_DIR: directory, BBYEN_DASHBOARD_PORT: '0',
				BBYEN_EMAIL_USER: 'fixture', BBYEN_EMAIL_PASS: 'fixture' },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	child.stdout.resume()
	child.stderr.resume()
	const exited = new Promise<void>(resolve =>
		child.once('exit', () => resolve()))
	try {
		const deadline = Date.now() + 15000
		let failures = 0
		while (Date.now() < deadline && child.exitCode === null) {
			const check = await sqlite.open({ filename, driver: sqlite3.Database })
			try {
				failures = (await check.get(`SELECT COUNT(*) AS count FROM refresh_runs
					WHERE status='completed' AND
					json_extract(resultJson, '$.errorCategory')='auth'`)).count
			} finally { await check.close() }
			if (failures === 2) break
			await new Promise(resolve => setTimeout(resolve, 100))
		}
		expect(failures).toBe(2)
		expect(child.exitCode).toBeNull()
	} finally {
		child.kill()
		await exited
		await fs.rm(directory, { recursive: true, force: true })
	}
}, 25000)

test('dashboard updates manual notification settings in the running service',
	async () => {
		const probe = createServer()
		await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
		const port = (probe.address() as AddressInfo).port
		await new Promise<void>(resolve => probe.close(() => resolve()))
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-dashboard-'))
		const config = JSON.parse(await fs.readFile('config.example.json', 'utf8'))
		config.mode = 'whitelist'
		config.database.filename = path.join(dir, 'database.sqlite')
		config.kickoff = { videos: false, subscriptions: false }
		const id = 'UCabcdefghijklmnopqrstuv'
		await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config))
		await fs.writeFile(path.join(dir, 'channels.json'), JSON.stringify({
			whitelistedChannelIds: [id],
		}))
		const child = spawn(process.execPath,
			['-r', 'ts-node/register/transpile-only', 'src/index.ts'], {
				env: { ...process.env, CONFIG_DIR: dir,
					BBYEN_DASHBOARD_PORT: String(port),
					BBYEN_EMAIL_USER: 'fixture', BBYEN_EMAIL_PASS: 'fixture' },
				stdio: ['ignore', 'pipe', 'pipe'],
			})
		child.stdout.resume(); child.stderr.resume()
		const exited = new Promise<void>(resolve =>
			child.once('exit', () => resolve()))
		try {
			const deadline = Date.now() + 15000
			let ready = false
			while (Date.now() < deadline && child.exitCode === null) {
				try { await axios.get(`http://127.0.0.1:${port}/api/health`)
					ready = true; break
				} catch { await new Promise(resolve => setTimeout(resolve, 100)) }
			}
			expect(ready).toBe(true)
			await axios.post(`http://127.0.0.1:${port}/api/channels/notify`,
				{ channelId: id, notify: false })
			const saved = JSON.parse(await fs.readFile(
				path.join(dir, 'channels.json'), 'utf8'))
			expect(saved.whitelistedChannelIds[0].notify).toBe(false)
			await axios.post(`http://127.0.0.1:${port}/api/channels/remove`,
				{ channelId: id })
			const removed = JSON.parse(await fs.readFile(
				path.join(dir, 'channels.json'), 'utf8'))
			expect(removed.whitelistedChannelIds).toEqual([])
			expect(removed.savedChannelSettings[0].notify).toBe(false)
			await axios.post(`http://127.0.0.1:${port}/api/schedule`, {
				intervals: { subscriptions: '1 day', videos: '200 ms' },
			})
			let scheduled = false
			const scheduleDeadline = Date.now() + 5000
			while (Date.now() < scheduleDeadline) {
				const check = await sqlite.open({ filename: config.database.filename,
					driver: sqlite3.Database })
				try { scheduled = !!(await check.get(`SELECT id FROM refresh_runs
					WHERE kind='videos' AND status='completed'`)) } finally {
					await check.close()
				}
				if (scheduled) break
				await new Promise(resolve => setTimeout(resolve, 100))
			}
			expect(scheduled).toBe(true)
		} finally {
			child.kill(); await exited
			await fs.rm(dir, { recursive: true, force: true })
		}
	}, 25000)

test('first-run setup starts the service without restarting', async () => {
	const probe = createServer()
	await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
	const port = (probe.address() as AddressInfo).port
	await new Promise<void>(resolve => probe.close(() => resolve()))
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-first-start-'))
	const env: NodeJS.ProcessEnv = { ...process.env, CONFIG_DIR: dir,
		BBYEN_DASHBOARD_PORT: String(port) }
	delete env.BBYEN_EMAIL_USER; delete env.BBYEN_EMAIL_PASS
	const child = spawn(process.execPath,
		['-r', 'ts-node/register/transpile-only', 'src/index.ts'], {
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	child.stdout.resume(); child.stderr.resume()
	const exited = new Promise<void>(resolve =>
		child.once('exit', () => resolve()))
	try {
		const url = `http://127.0.0.1:${port}`
		const deadline = Date.now() + 15000
		let ready = false
		while (Date.now() < deadline && child.exitCode === null) {
			try { await axios.get(`${url}/api/setup`); ready = true; break }
			catch { await new Promise(resolve => setTimeout(resolve, 100)) }
		}
		expect(ready).toBe(true)
		expect((await axios.get(`${url}/`)).data).toContain('/setup.js')
		const setup = await axios.post(`${url}/api/setup/manual`, {})
		expect(setup.data.ready).toBe(true)
		expect((await axios.get(`${url}/api/health`)).data.status).toBe('running')
		expect((await axios.get(`${url}/`)).data).toContain('/app.js')
		const config = JSON.parse(await fs.readFile(path.join(dir, 'config.json'),
			'utf8'))
		expect(config.mode).toBe('whitelist')
		expect(config.notifyOnFirstScan).toBe(false)
		expect(config.database.filename).toBe(path.join(dir, 'database.sqlite'))
		await axios.post(`${url}/api/settings`, { settings: {
			initialBacklog: { mode: 'all' }, videoRetentionDays: 30,
			emailOnError: false,
		} })
		const savedSettings = (await axios.get(`${url}/api/settings`)).data.settings
		expect(savedSettings).toEqual({ initialBacklog: { mode: 'all' },
			videoRetentionDays: 30, emailOnError: false, confirmUnsubscribe: true,
			notifyTitleChanges: true })
		await axios.post(`${url}/api/unsubscribe-confirmation`,
			{ confirmUnsubscribe: false })
		expect((await axios.get(`${url}/api/settings`)).data.settings
			.confirmUnsubscribe).toBe(false)
		expect((await axios.get(`${url}/api/channels`)).data.confirmUnsubscribe)
			.toBe(false)
		const legacySettings = await axios.post(`${url}/api/settings`, { settings: {
			initialBacklog: { mode: 'all' }, videoRetentionDays: 30,
			emailOnError: false,
		} })
		expect(legacySettings.data.settings.confirmUnsubscribe).toBe(false)
		const importedId = 'UCabcdefghijklmnopqrstuv'
		const preview = await axios.post(
			`${url}/api/subscriptions/import/preview`, {
				importData: { whitelistedChannelIds: [importedId, 'invalid'],
					email: { auth: { pass: 'fixture-private' } } },
			})
		expect(preview.data.problems).toHaveLength(1)
		expect(JSON.stringify(preview.data)).not.toContain('fixture-private')
		const refused = await axios.post(`${url}/api/subscriptions/import/apply`, {
			previewId: preview.data.id, conflictChoice: 'keep', acceptPartial: false,
		}, { validateStatus: () => true })
		expect(refused.status).toBe(400)
		await axios.post(`${url}/api/subscriptions/import/apply`, {
			previewId: preview.data.id, conflictChoice: 'keep', acceptPartial: true,
		})
		const imported = JSON.parse(await fs.readFile(
			path.join(dir, 'channels.json'), 'utf8'))
		expect(imported.whitelistedChannelIds).toEqual([{ id: importedId }])
		expect(JSON.stringify(imported)).not.toContain('fixture-private')
		expect(child.exitCode).toBeNull()
	} finally {
		child.kill(); await exited
		await fs.rm(dir, { recursive: true, force: true })
	}
}, 25000)

test('restores cookie tracking mode from the persistent database', async () => {
	const probe = createServer()
	await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
	const port = (probe.address() as AddressInfo).port
	await new Promise<void>(resolve => probe.close(() => resolve()))
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-cookie-service-'))
	const config = JSON.parse(await fs.readFile('config.example.json', 'utf8'))
	config.mode = 'whitelist'
	config.database.filename = path.join(dir, 'database.sqlite')
	config.kickoff = { videos: false, subscriptions: false }
	await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config))
	await fs.writeFile(path.join(dir, 'channels.json'),
		JSON.stringify({ whitelistedChannelIds: [] }))
	await fs.writeFile(path.join(dir, 'cookies.txt'), 'synthetic-file-fixture')
	const db = await init(config.database)
	await new CookieConnectionStore(db).activate('SAPISID=synthetic-fixture', {
		name: 'Profile', selected: true, selectable: true,
		channelId: 'UC0000000000000000000001',
	}, [{ channelId: 'UC0000000000000000000002', title: 'Channel',
		notificationState: 'all', isAllNotifications: true }])
	await db.close()
	const child = spawn(process.execPath,
		['-r', 'ts-node/register/transpile-only', 'src/index.ts'], {
			env: { ...process.env, CONFIG_DIR: dir,
				BBYEN_DASHBOARD_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
		})
	child.stdout.resume(); child.stderr.resume()
	const exited = new Promise<void>(resolve =>
		child.once('exit', () => resolve()))
	try {
		const deadline = Date.now() + 15000
		let result: any
		while (Date.now() < deadline && child.exitCode === null) {
			try { result = (await axios.get(`http://127.0.0.1:${port}/api/channels`))
				.data; break
			} catch { await new Promise(resolve => setTimeout(resolve, 100)) }
		}
		expect(result?.manualMode).toBe(false)
		expect(result?.channels[0].channelId).toBe('UC0000000000000000000002')
		expect(JSON.stringify(result)).not.toContain('synthetic-fixture')
		const base = `http://127.0.0.1:${port}`
		const preview = (await axios.post(`${base}/api/cookies/manual/preview`, {}))
			.data
		expect(preview.continuing).toHaveLength(1)
		expect(preview.legacyCookieFile).toBe(true)
		const switched = await axios.post(`${base}/api/cookies/manual/apply`,
			{ previewId: preview.previewId })
		expect(switched.data).toEqual({ switched: true, cleanupPending: false })
		expect((await axios.get(`${base}/api/cookies/status`)).data.mode)
			.toBe('whitelist')
		await expect(fs.stat(path.join(dir, 'cookies.txt')))
			.rejects.toMatchObject({ code: 'ENOENT' })
		expect((await axios.get(`${base}/api/channels`)).data.manualMode).toBe(true)
	} finally {
		child.kill(); await exited
		await fs.rm(dir, { recursive: true, force: true })
	}
}, 25000)
