import fs from 'fs/promises'
import { randomUUID } from 'crypto'
import { isDeepStrictEqual } from 'util'

/** Serialize cooperating writers and atomically replace complete files. */
export const updateJsonFile = async <T>(
	filename: string,
	update: (value: unknown) => T | Promise<T>,
	options: { createIfMissing?: boolean } = {},
): Promise<T> => {
	const lockPath = `${filename}.lock`
	const lock = await fs.open(lockPath, 'wx', 0o600).catch(err => {
		if (err.code === 'EEXIST') {
			throw new Error(`File is locked: ${filename}. Retry when the other ` +
				'editor finishes; after a crash verify its process has stopped ' +
				`before removing ${lockPath}.`)
		}
		throw err
	})
	const temporary = `${filename}.${randomUUID()}.tmp`
	let failed = false
	let failure: unknown
	let updated!: T
	try {
		await lock.writeFile(String(process.pid))
		let current: unknown = {}
		try {
			const text = await fs.readFile(filename, 'utf8')
			try {
				current = JSON.parse(text)
			} catch {
				throw new Error(`Invalid JSON in ${filename}; file was preserved.`)
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT' ||
					!options.createIfMissing) throw err
		}
		updated = await update(current)
		if (!isDeepStrictEqual(current, updated)) {
			await fs.writeFile(temporary, JSON.stringify(updated, null, '\t'), {
				flag: 'wx', mode: 0o600,
			})
			await fs.rename(temporary, filename)
		}
	} catch (err) {
		failed = true
		failure = err
	} finally {
		const cleanup = await Promise.allSettled([
			fs.unlink(temporary).catch(err => {
				if (err.code !== 'ENOENT') throw err
			}),
			lock.close(),
		])
		cleanup.push(...await Promise.allSettled([fs.unlink(lockPath)]))
		const error = cleanup.find(result => result.status === 'rejected')
		if (error?.status === 'rejected') {
			if (failed) {
				console.warn(`Could not clean update artifacts for ${filename}.`)
			} else {
				failed = true
				failure = error.reason
			}
		}
	}
	if (failed) throw failure
	return updated
}
