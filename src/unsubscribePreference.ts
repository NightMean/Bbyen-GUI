import fs from 'fs/promises'
import { Config } from './config'
import { updateJsonFile } from './lib/jsonFile'

/** Persist only the unsubscribe prompt setting, preserving concurrent edits. */
export const saveUnsubscribePreference = async (
	filename: string, config: Config, enabled: boolean,
): Promise<void> => {
	if (typeof enabled !== 'boolean') throw new Error('Expected a boolean.')
	try {
		await updateJsonFile(filename, value => {
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new Error('Configuration must be an object.')
			}
			return { ...value, confirmUnsubscribe: enabled }
		})
	} catch (err) {
		try {
			const saved = JSON.parse(await fs.readFile(filename, 'utf8'))
			if (saved.confirmUnsubscribe === enabled) {
				config.confirmUnsubscribe = enabled
			}
		} catch { /* Leave runtime unchanged when persistence is unverified. */ }
		throw err
	}
	config.confirmUnsubscribe = enabled
}
