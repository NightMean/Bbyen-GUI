import type { ChannelEntry, RawChannelEntry } from '../config'
import { parseBacklogPolicy } from '../initialBacklog'

export interface ChannelLists {
	whitelistedChannelIds?: RawChannelEntry[],
	blacklistedChannelIds?: RawChannelEntry[],
	manualChannelIds?: RawChannelEntry[],
	savedChannelSettings?: RawChannelEntry[],
	[key: string]: unknown,
}

export const parseChannelLists = (value: unknown): ChannelLists => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Channel configuration must be a JSON object.')
	}
	for (const key of [
		'whitelistedChannelIds', 'blacklistedChannelIds', 'manualChannelIds',
		'savedChannelSettings',
	]) {
		const entries = (value as Record<string, unknown>)[key]
		if (entries === undefined) continue
		if (!Array.isArray(entries)) throw new Error(`${key} must be an array.`)
		for (const entry of entries) {
			const id = typeof entry === 'string' ? entry : entry?.id
			if (typeof id !== 'string' || !id.trim()) {
				throw new Error(`${key} entries need a nonempty string ID.`)
			}
			for (const flag of ['notify', 'notifyOnFirstScan']) {
				if (typeof entry === 'object' && entry[flag] !== undefined &&
						typeof entry[flag] !== 'boolean') {
					throw new Error(`${key}.${flag} must be a boolean.`)
				}
			}
			if (typeof entry === 'object' && entry.initialBacklog !== undefined) {
				parseBacklogPolicy(entry.initialBacklog, `${key}.initialBacklog`)
			}
		}
	}
	return value as ChannelLists
}

// Later explicit flags override earlier flags; adding a plain ID never
// overwrites existing preferences. Keep stable order for readable diffs.
export const mergeChannelEntries = (
	entries: RawChannelEntry[],
): ChannelEntry[] => {
	const merged = new Map<string, ChannelEntry>()
	for (const raw of entries) {
		const entry = typeof raw === 'string' ? { id: raw } : raw
		merged.set(entry.id, { ...merged.get(entry.id), ...entry })
	}
	return [...merged.values()]
}
