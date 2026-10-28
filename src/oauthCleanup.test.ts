import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { init } from './database'
import {
	oauthTokenHash, recordOAuthCleanup, recoverOAuthCleanup,
} from './oauthCleanup'

test('recovers a committed cleanup after reopening the database', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-oauth-cleanup-'))
	const file = path.join(dir, '.google-auth-token.json')
	const dbFile = path.join(dir, 'database.sqlite')
	let db = await init({ filename: dbFile })
	try {
		await fs.writeFile(file, 'old-token-fixture')
		const hash = await oauthTokenHash(dir)
		await recordOAuthCleanup(db, hash!)
		const row = await db.get('SELECT tokenHash FROM oauth_cleanup')
		expect(JSON.stringify(row)).not.toContain('old-token-fixture')
		await db.close()
		db = await init({ filename: dbFile })
		expect(await recoverOAuthCleanup(db, dir)).toBe(true)
		await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
		expect(await db.get('SELECT id FROM oauth_cleanup')).toBeUndefined()
	} finally {
		await db.close()
		await fs.unlink(dbFile)
		await fs.rmdir(dir)
	}
})

test('preserves a replacement grant and leaves cleanup pending', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-oauth-cleanup-'))
	const file = path.join(dir, '.google-auth-token.json')
	const db = await init({ filename: ':memory:' })
	try {
		await fs.writeFile(file, 'old-fixture')
		await recordOAuthCleanup(db, (await oauthTokenHash(dir))!)
		await fs.writeFile(file, 'replacement-fixture')
		expect(await recoverOAuthCleanup(db, dir)).toBe(false)
		expect(await fs.readFile(file, 'utf8')).toBe('replacement-fixture')
		expect(await db.get('SELECT id FROM oauth_cleanup')).toEqual({ id: 1 })
		await fs.unlink(file)
		expect(await recoverOAuthCleanup(db, dir)).toBe(true)
	} finally { await db.close(); await fs.rmdir(dir) }
})

test('waits for an active configuration writer before deleting a grant',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-oauth-cleanup-'))
		const file = path.join(dir, '.google-auth-token.json')
		const db = await init({ filename: ':memory:' })
		try {
			await fs.writeFile(file, 'fixture')
			await recordOAuthCleanup(db, (await oauthTokenHash(dir))!)
			await fs.writeFile(`${file}.lock`, 'other-writer', { flag: 'wx' })
			expect(await recoverOAuthCleanup(db, dir)).toBe(false)
			expect(await fs.readFile(file, 'utf8')).toBe('fixture')
			await fs.unlink(`${file}.lock`)
			expect(await recoverOAuthCleanup(db, dir)).toBe(true)
		} finally { await db.close(); await fs.rmdir(dir) }
	})
