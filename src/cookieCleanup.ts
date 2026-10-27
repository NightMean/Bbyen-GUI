import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import * as sqlite from 'sqlite'

/** Compare the legacy cookie file without retaining its contents. */
export const legacyCookieHash = async (
	directory: string,
): Promise<string | null> => {
	const filename = path.join(directory, 'cookies.txt')
	try {
		const stat = await fs.stat(filename)
		if (!stat.isFile() || stat.size > 1024 * 1024) {
			throw new Error('Legacy cookie file cannot be checked.')
		}
		return createHash('sha256').update(await fs.readFile(filename))
			.digest('hex')
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw err
	}
}

/** Retry deferred deletion after a source switch, including after restart. */
export const recoverCookieCleanup = async (
	db: sqlite.Database, directory: string,
): Promise<boolean> => {
	const pending = await db.get(
		'SELECT legacyHash FROM cookie_cleanup WHERE id=1')
	if (!pending) return true
	if (pending.legacyHash) {
		const current = await legacyCookieHash(directory)
		if (current && current !== pending.legacyHash) return false
		if (current) {
			await fs.unlink(path.join(directory, 'cookies.txt')).catch(err => {
				if (err.code !== 'ENOENT') throw err
			})
		}
	}
	const journal = await db.get('PRAGMA journal_mode')
	if (String(journal?.journal_mode).toLowerCase() === 'wal') {
		const checkpoint = await db.get('PRAGMA wal_checkpoint(TRUNCATE)')
		if (checkpoint?.busy) return false
	}
	await db.run('DELETE FROM cookie_cleanup WHERE id=1')
	return true
}
