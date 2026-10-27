import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { secureCookieStorage } from './secureCookieStorage'

test('restricts database permissions and rejects in-memory cookie storage',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-permissions-'))
		const file = path.join(dir, 'database.sqlite')
		try {
			await fs.writeFile(file, '')
			await secureCookieStorage(file)
			if (process.platform !== 'win32') {
				expect((await fs.stat(file)).mode & 0o077).toBe(0)
			}
			await expect(secureCookieStorage(':memory:')).rejects.toThrow()
		} finally { await fs.rm(dir, { recursive: true, force: true }) }
	})
