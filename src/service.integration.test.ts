import { spawn } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'
import { expect, test } from 'vitest'
import { init } from './database'

test('service startup recovers attempts and records jobs', async () => {
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
				BBYEN_EMAIL_USER: 'fixture', BBYEN_EMAIL_PASS: 'fixture' },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	let stderr = ''
	child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096) })
	child.stdout.resume()
	const exited = new Promise<void>(resolve =>
		child.once('exit', () => resolve()))
	try {
		const deadline = Date.now() + 8000
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
	} finally {
		child.kill()
		await exited
		await fs.rm(directory, { recursive: true, force: true })
	}
}, 15000)

test('service stays up without SMTP credentials and recovers without restart',
	async () => {
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
		const env: NodeJS.ProcessEnv = { ...process.env, CONFIG_DIR: directory }
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
			const deadline = Date.now() + 10000
			let addedCredentials = false
			let recovered = false
			while (Date.now() < deadline && child.exitCode === null) {
				const check = await sqlite.open({ filename, driver: sqlite3.Database })
				let rows: { resultJson: string }[]
				try {
					rows = await check.all(`SELECT resultJson FROM refresh_runs
						WHERE kind='videos' AND status='completed'`)
				} finally { await check.close() }
				const states = rows.map(row => JSON.parse(row.resultJson).status)
				if (!addedCredentials && states.includes('failed')) {
					await fs.writeFile(path.join(directory, 'secrets.json'),
						JSON.stringify({ email: { auth: {
							user: 'fixture', pass: 'fixture',
						} } }))
					addedCredentials = true
				}
				if (addedCredentials && states.includes('success')) {
					recovered = true
					break
				}
				await new Promise(resolve => setTimeout(resolve, 100))
			}
			expect(recovered, `Service did not recover; stderr: ${stderr}`).toBe(true)
			expect(child.exitCode).toBeNull()
		} finally {
			child.kill()
			await exited
			await fs.rm(directory, { recursive: true, force: true })
		}
	}, 15000)

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
			env: { ...process.env, CONFIG_DIR: directory,
				BBYEN_EMAIL_USER: 'fixture', BBYEN_EMAIL_PASS: 'fixture' },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	child.stdout.resume()
	child.stderr.resume()
	const exited = new Promise<void>(resolve =>
		child.once('exit', () => resolve()))
	try {
		const deadline = Date.now() + 8000
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
}, 15000)
