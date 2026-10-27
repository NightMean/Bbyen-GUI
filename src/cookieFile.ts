import fs from 'fs/promises'
import path from 'path'

const MAX_BYTES = 256 * 1024

/** Read a bounded replacement export from the service config directory. */
export const readCookieFile = async (
	directory: string,
): Promise<string | null> => {
	let file: Awaited<ReturnType<typeof fs.open>>
	try { file = await fs.open(path.join(directory, 'cookies.txt'), 'r') }
	catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw err
	}
	try {
		const stat = await file.stat()
		if (!stat.isFile() || stat.size > MAX_BYTES) {
			throw new Error('Cookie file is not a supported regular file.')
		}
		const buffer = Buffer.alloc(MAX_BYTES + 1)
		let length = 0
		while (length < buffer.length) {
			const result = await file.read(buffer, length,
				buffer.length - length, null)
			if (!result.bytesRead) break
			length += result.bytesRead
		}
		if (length > MAX_BYTES) throw new Error('Cookie file is too large.')
		return buffer.subarray(0, length).toString('utf8')
	} finally { await file.close() }
}
