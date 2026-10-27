import fs from 'fs/promises'
import path from 'path'

/** Restrict access before a cookie is first persisted in the database. */
export const secureCookieStorage = async (filename: string): Promise<void> => {
	if (filename === ':memory:') {
		throw new Error('Cookie tracking requires persistent database storage.')
	}
	const resolved = path.resolve(__dirname, '../', filename)
	await fs.chmod(resolved, 0o600)
}
