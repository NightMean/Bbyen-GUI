import { spawn } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { AddressInfo, createServer } from 'net'
import axios from 'axios'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'
import { expect, test } from 'vitest'
import { init } from './database'

test('running service sends a pending name alert through SMTP', async () => {
	const messages: string[] = []
	const smtp = createServer(socket => {
		let buffer = '', message = '', inData = false
		socket.setEncoding('utf8'); socket.write('220 fixture ESMTP\r\n')
		socket.on('data', chunk => {
			buffer += chunk
			let end: number
			while ((end = buffer.indexOf('\r\n')) >= 0) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
				if (inData) {
					if (line === '.') {
						inData = false; messages.push(message); socket.write('250 ok\r\n')
					} else message += `${line}\n`
				} else if (line.startsWith('EHLO')) {
					socket.write('250-fixture\r\n250 AUTH PLAIN\r\n')
				} else if (line.startsWith('AUTH')) socket.write('235 ok\r\n')
				else if (line === 'DATA') { inData = true; socket.write('354 go\r\n') }
				else if (line === 'QUIT') socket.end('221 bye\r\n')
				else socket.write('250 ok\r\n')
			}
		})
	})
	await new Promise<void>(resolve => smtp.listen(0, '127.0.0.1', resolve))
	const probe = createServer()
	await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
	const port = (probe.address() as AddressInfo).port
	await new Promise<void>(resolve => probe.close(() => resolve()))
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-title-alert-'))
	const filename = path.join(dir, 'database.sqlite')
	const config = JSON.parse(await fs.readFile('config.example.json', 'utf8'))
	config.mode = 'whitelist'; config.database.filename = filename
	config.kickoff = { videos: false, subscriptions: false }
	config.email = { host: '127.0.0.1',
		port: (smtp.address() as AddressInfo).port,
		secure: false, sendingContact: 'sender@example.test',
		destination: 'to@example.test' }
	await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config))
	await fs.writeFile(path.join(dir, 'channels.json'),
		JSON.stringify({ whitelistedChannelIds: [] }))
	const db = await init({ filename })
	await db.run(`INSERT INTO subscriptions
		(channelId, channelTitle, channelThumbnail)
		VALUES ('UC0000000000000000000001', 'Old', '')`)
	await db.run('UPDATE subscriptions SET channelTitle=?', 'New')
	await db.close()
	const child = spawn(process.execPath,
		['-r', 'ts-node/register/transpile-only', 'src/index.ts'], {
			env: { ...process.env, CONFIG_DIR: dir,
				BBYEN_DASHBOARD_PORT: String(port), BBYEN_EMAIL_USER: 'fixture',
				BBYEN_EMAIL_PASS: 'fixture' }, stdio: ['ignore', 'pipe', 'pipe'],
		})
	child.stdout.resume(); child.stderr.resume()
	const exited = new Promise<void>(resolve =>
		child.once('exit', () => resolve()))
	try {
		const deadline = Date.now() + 15000
		let events: any[] = []
		while (Date.now() < deadline && child.exitCode === null) {
			try {
				events = (await axios.get(`http://127.0.0.1:${port}/api/title-events`))
					.data.events
				if (events[0]?.emailState === 'sent') break
			} catch { /* Service is still starting. */ }
			await new Promise(resolve => setTimeout(resolve, 100))
		}
		expect(events[0]?.emailState).toBe('sent')
		expect(messages).toHaveLength(1)
		expect(messages[0]).toContain('Previous name: Old')
		expect(messages[0]).toContain('Current name: New')
		const base = `http://127.0.0.1:${port}`
		const settings = (await axios.get(`${base}/api/settings`)).data.settings
		await axios.post(`${base}/api/settings`, { settings: { ...settings,
			notifyTitleChanges: false } })
		const connection = await sqlite.open({ filename, driver: sqlite3.Database })
		try {
			await connection.run('UPDATE subscriptions SET channelTitle=?', 'Next')
		}
		finally { await connection.close() }
		await axios.post(`${base}/api/settings`, { settings: { ...settings,
			notifyTitleChanges: true } })
		const recent = (await axios.get(`${base}/api/title-events`)).data.events
		const next = recent.find((event: any) => event.currentTitle === 'Next')
		expect(next.emailState).toBe('suppressed')
		expect(messages).toHaveLength(1)
	} finally {
		child.kill(); await exited
		await new Promise<void>(resolve => smtp.close(() => resolve()))
		await fs.rm(dir, { recursive: true, force: true })
	}
}, 25000)
