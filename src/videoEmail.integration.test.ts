import net from 'net'
import { afterEach, expect, test, vi } from 'vitest'
import RSSParser from 'rss-parser'
import { init as initDatabase } from './database'
import { init as initMailer } from './email'
import { parseFeedsAndNotify } from './videos'
import { Config } from './config'
import { listActivity } from './dashboardActivity'
import { pruneVideoObservations } from './videoRetention'
import { pruneActivity } from './activityRetention'

vi.mock('./lib/logger', () => ({ default: async () => ({
	info: vi.fn(), verbose: vi.fn(), warn: vi.fn(), error: vi.fn(),
}) }))

afterEach(() => vi.restoreAllMocks())

test.each([
	['accept', 'sent'], ['reject', 'failed'], ['disconnect', 'uncertain'],
])('records %s from the real SMTP transport', async (response, expected) => {
	const sockets = new Set<net.Socket>()
	const server = net.createServer(socket => {
		sockets.add(socket)
		socket.on('close', () => sockets.delete(socket))
		socket.write('220 localhost ready\r\n')
		let buffer = ''
		let body = false
		socket.on('data', chunk => {
			buffer += chunk.toString()
			let end: number
			while ((end = buffer.indexOf('\r\n')) >= 0) {
				const line = buffer.slice(0, end)
				buffer = buffer.slice(end + 2)
				if (body) {
					if (line !== '.') continue
					body = false
					if (response === 'disconnect') socket.destroy()
					else socket.write(response === 'reject'
						? '550 Message rejected\r\n' : '250 Message accepted\r\n')
				} else if (line.startsWith('EHLO')) {
					socket.write('250-localhost\r\n250 AUTH PLAIN\r\n')
				} else if (line.startsWith('AUTH')) socket.write('235 Auth ok\r\n')
				else if (line === 'DATA') { body = true; socket.write('354 Go\r\n') }
				else if (line === 'QUIT') socket.end('221 Bye\r\n')
				else socket.write('250 OK\r\n')
			}
		})
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const port = (server.address() as net.AddressInfo).port
	const db = await initDatabase({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO subscriptions
			(channelId, channelTitle, channelThumbnail)
			VALUES ('UCfixture', 'Creator', 'avatar')`)
		vi.spyOn(RSSParser.prototype, 'parseURL').mockResolvedValue({ items: [{
			videoId: 'video', title: 'Video', isoDate: '2026-01-01T00:00:00Z',
		}] } as never)
		const mailer = await initMailer({ host: '127.0.0.1', port, secure: false,
			auth: { user: 'fixture', pass: 'fixture' },
			sendingContact: 'sender@example.com', destination: 'to@example.com' })
		const config = { mode: 'whitelist', notifyOnFirstScan: true,
			logging: { emailOnError: false } } as Config
		const args = { db, config, sendVideoEmail: mailer.sendVideoEmail,
			sendErrorEmail: vi.fn(), service: {} as never }
		await parseFeedsAndNotify(args)
		await parseFeedsAndNotify(args)
		expect(await db.get(`SELECT emailOutcome FROM video_observations
			WHERE videoId='video'`)).toEqual({ emailOutcome: expected })
		expect(await db.get('SELECT COUNT(*) AS count FROM videos'))
			.toEqual({ count: 1 })
		const activity = await listActivity(db, { limit: 30, offset: 0 })
		expect(activity.items.filter(item => item.kind === 'videoEmail'))
			.toHaveLength(expected === 'sent' ? 1 : 0)
		if (expected === 'sent') {
			await pruneVideoObservations(db, 1, new Date(Date.now() + 2 * 86400_000))
			expect((await listActivity(db, { limit: 30, offset: 0 })).items
				.filter(item => item.kind === 'videoEmail')).toHaveLength(1)
			await pruneActivity(db, 1, new Date(Date.now() + 2 * 86400_000))
			expect((await listActivity(db, { limit: 30, offset: 0 })).items
				.filter(item => item.kind === 'videoEmail')).toHaveLength(0)
		}
	} finally {
		await db.close()
		for (const socket of sockets) socket.destroy()
		await new Promise<void>((resolve, reject) => server.close(err =>
			err ? reject(err) : resolve()))
	}
})
