import { spawn } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'
import { expect, test } from 'vitest'
import { init } from './database'

test('service startup recovers interrupted email attempts', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-service-'))
	const filename = path.join(directory, 'database.sqlite')
	const config = JSON.parse(await fs.readFile('config.example.json', 'utf8'))
	config.mode = 'whitelist'
	config.database.filename = filename
	config.kickoff = { videos: false, subscriptions: false }
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
		while (Date.now() < deadline && child.exitCode === null) {
			const check = await sqlite.open({ filename, driver: sqlite3.Database })
			try {
				outcome = (await check.get(`SELECT emailOutcome
					FROM video_observations WHERE videoId='pending-video'`))?.emailOutcome
			} finally {
				await check.close()
			}
			if (outcome === 'uncertain') break
			await new Promise(resolve => setTimeout(resolve, 100))
		}
		expect(outcome, `Service failed to recover; stderr: ${stderr}`)
			.toBe('uncertain')
		expect(child.exitCode).toBeNull()
	} finally {
		child.kill()
		await exited
		await fs.rm(directory, { recursive: true, force: true })
	}
}, 15000)
