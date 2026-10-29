import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import packageInfo from '../package.json'
import { readBuildIdentity } from './buildIdentity'

test('reports validated build metadata and unknown development builds',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-build-'))
		const file = path.join(dir, 'metadata.json')
		try {
			expect(readBuildIdentity(file)).toEqual({ version: packageInfo.version,
				revision: null, dirty: null })
			await fs.writeFile(file, JSON.stringify({ revision: 'abcdef123-dirty' }))
			expect(readBuildIdentity(file)).toEqual({ version: packageInfo.version,
				revision: 'abcdef123', dirty: true })
			await fs.writeFile(file, JSON.stringify({ revision: 'unsafe value' }))
			expect(readBuildIdentity(file).revision).toBeNull()
		} finally { await fs.rm(dir, { recursive: true, force: true }) }
	})
