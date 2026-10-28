import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'

const TOKEN_NAME = '.google-auth-token.json'
const MAX_TOKEN_BYTES = 1024 * 1024

/** Identify an app-managed grant without retaining its contents. */
export const oauthTokenHash = async (
	directory: string,
): Promise<string | null> => {
	const filename = path.join(directory, TOKEN_NAME)
	try {
		const stat = await fs.stat(filename)
		if (!stat.isFile() || stat.size > MAX_TOKEN_BYTES) {
			throw new Error('YouTube authorization file cannot be checked.')
		}
		const data = await fs.readFile(filename)
		if (data.length > MAX_TOKEN_BYTES) {
			throw new Error('YouTube authorization file cannot be checked.')
		}
		return createHash('sha256').update(data).digest('hex')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
}

/** Call inside the same database transaction as the source transition. */
export const recordOAuthCleanup = async (db: sqlite.Database, hash: string) => {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid token generation.')
	await db.run(SQL`INSERT INTO oauth_cleanup (id, tokenHash)
		VALUES (1, ${hash});`)
}

/** Serialize with token writers while checking or deleting a generation. */
export const withOAuthTokenLock = async <T>(
	directory: string, work: () => Promise<T>,
): Promise<T> => {
	const lockPath = `${path.join(directory, TOKEN_NAME)}.lock`
	const lock = await fs.open(lockPath, 'wx', 0o600)
	let result!: T
	let failure: unknown
	try {
		await lock.writeFile(String(process.pid))
		result = await work()
	} catch (error) {
		failure = error
	} finally {
		try { await lock.close() } catch (error) { failure ??= error }
		try { await fs.unlink(lockPath) } catch (error) { failure ??= error }
	}
	if (failure) throw failure
	return result
}

/** Delete only the recorded generation while holding the shared writer lock. */
export const recoverOAuthCleanup = async (
	db: sqlite.Database, directory: string,
): Promise<boolean> => {
	const pending = await db.get('SELECT tokenHash FROM oauth_cleanup WHERE id=1')
	if (!pending) return true
	if (typeof pending.tokenHash !== 'string' ||
			!/^[a-f0-9]{64}$/.test(pending.tokenHash)) {
		throw new Error('Stored authorization cleanup is invalid.')
	}
	try {
		return await withOAuthTokenLock(directory, async () => {
			const latest = await db.get(
				'SELECT tokenHash FROM oauth_cleanup WHERE id=1')
			if (latest?.tokenHash !== pending.tokenHash) return false
			const current = await oauthTokenHash(directory)
			if (current !== null && current !== pending.tokenHash) return false
			if (current !== null) await fs.unlink(path.join(directory, TOKEN_NAME))
			const removed = await db.run(SQL`DELETE FROM oauth_cleanup WHERE id=1
				AND tokenHash=${pending.tokenHash};`)
			return !!removed.changes
		})
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
		throw error
	}
}
