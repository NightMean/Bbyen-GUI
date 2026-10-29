import fs from 'fs'
import path from 'path'
import packageInfo from '../package.json'

export interface BuildIdentity {
	version: string,
	revision: string | null,
	dirty: boolean | null,
}

/** Read immutable image metadata; unpackaged development runs may omit it. */
export const readBuildIdentity = (filename = path.join(__dirname, '..',
	'build-metadata.json')): BuildIdentity => {
	let revision: unknown
	try {
		const data = fs.readFileSync(filename, 'utf8')
		revision = JSON.parse(data).revision
	} catch { /* The metadata file is optional outside a built image. */ }
	const valid = typeof revision === 'string' &&
		/^[a-f0-9]{7,40}(-dirty)?$/.test(revision)
	return { version: packageInfo.version,
		revision: valid ? (revision as string).replace(/-dirty$/, '') : null,
		dirty: valid ? (revision as string).endsWith('-dirty') : null }
}
