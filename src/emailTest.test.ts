import { AddressInfo, createServer } from 'net'
import { expect, test } from 'vitest'
import { init } from './database'
import * as mailer from './email'
import { sendTestEmail } from './emailTest'
import { initIncidentSchema } from './incidentSchema'

test('records SMTP test outcomes without replay', async () => {
	const messages: string[] = []
	const server = createServer(socket => {
		let buffer = ''
		let inData = false
		let message = ''
		socket.setEncoding('utf8')
		socket.write('220 fixture ESMTP\r\n')
		socket.on('data', chunk => {
			buffer += chunk
			let end: number
			while ((end = buffer.indexOf('\r\n')) >= 0) {
				const line = buffer.slice(0, end)
				buffer = buffer.slice(end + 2)
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
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const db = await init({ filename: ':memory:' })
	try {
		const email = await mailer.init({ host: '127.0.0.1', secure: false,
			port: (server.address() as AddressInfo).port,
			auth: { user: 'fixture', pass: 'fixture' },
			sendingContact: 'sender@example.test', destination: 'to@example.test' })
		expect(await sendTestEmail(db, email.sendTestEmail)).toBe('sent')
		expect(messages[0]).toContain('BBYEN test email')
		expect(await sendTestEmail(db, async () => { throw new Error('fixture') }))
			.toBe('uncertain')
		const rows = await db.all(
			'SELECT outcome FROM email_test_runs ORDER BY rowid')
		expect(rows.map(row => row.outcome)).toEqual(['sent', 'uncertain'])
		await db.run(`INSERT INTO email_test_runs (id, startedAt, outcome)
			VALUES ('interrupted', '2026-01-01', 'pending')`)
		await initIncidentSchema(db)
		expect((await db.get('SELECT outcome FROM email_test_runs WHERE id=?',
			'interrupted')).outcome).toBe('uncertain')
	} finally {
		await db.close()
		await new Promise<void>(resolve => server.close(() => resolve()))
	}
}, 15000)
