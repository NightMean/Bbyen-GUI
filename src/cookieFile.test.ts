import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { readCookieFile } from './cookieFile'

test('reads a replacement file with a strict size bound', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-cookie-file-'))
	const file = path.join(dir, 'cookies.txt')
	try {
		expect(await readCookieFile(dir)).toBeNull()
		await fs.writeFile(file, 'synthetic-fixture')
		expect(await readCookieFile(dir)).toBe('synthetic-fixture')
		await fs.writeFile(file, Buffer.alloc(256 * 1024 + 1))
		await expect(readCookieFile(dir)).rejects.toThrow(/regular file|large/i)
	} finally { await fs.rm(dir, { recursive: true, force: true }) }
})
