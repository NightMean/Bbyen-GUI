import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { Config } from './config'
import { parseEmailSettings, publicEmailSettings, saveEmailCredentials,
	saveEmailSettings } from './emailSettings'

test('saves email settings without returning credentials', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-email-'))
	const filename = path.join(directory, 'config.json')
	const config = { email: { host: 'old', port: 25, secure: false,
		sendingContact: 'from', destination: 'to', auth: { pass: 'fixture' } },
	} as Config
	const settings = { host: 'mail.example.test', port: 465, secure: true,
		sendingContact: 'sender@example.test', destination: 'to@example.test' }
	try {
		await fs.writeFile(filename,
			JSON.stringify({ email: config.email, other: 1 }))
		await saveEmailSettings(filename, config, settings)
		expect(publicEmailSettings(config)).toEqual(settings)
		const saved = JSON.parse(await fs.readFile(filename, 'utf8'))
		expect(saved.other).toBe(1)
		expect(saved.email.auth.pass).toBe('fixture')
		expect(() => parseEmailSettings({ ...settings, port: 0 })).toThrow()
		expect(() => parseEmailSettings({ ...settings, host: 'bad\nhost' }))
			.toThrow()
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('preserves secrets and respects environment ownership', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-secret-'))
	const filename = path.join(directory, 'secrets.json')
	try {
		await saveEmailCredentials(filename, { user: 'fixture-user',
			pass: ' fixture-pass ' }, {})
		await saveEmailCredentials(filename, { user: 'replacement-user' }, {})
		const saved = JSON.parse(await fs.readFile(filename, 'utf8'))
		expect(saved.email.auth.pass).toBe(' fixture-pass ')
		await expect(saveEmailCredentials(filename, { user: 'another' },
			{ BBYEN_EMAIL_USER: 'environment' })).rejects.toThrow()
		expect(JSON.parse(await fs.readFile(filename, 'utf8'))).toEqual(saved)
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
})
