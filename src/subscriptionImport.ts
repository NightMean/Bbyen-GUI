import { ChannelEntry } from './config'
import { parseBacklogPolicy } from './initialBacklog'
import { isChannelId } from './lib/channelId'

export const IMPORT_LISTS = [
	'whitelistedChannelIds', 'blacklistedChannelIds', 'manualChannelIds',
	'savedChannelSettings',
] as const
export type ImportList = typeof IMPORT_LISTS[number]
export type ImportedLists = Record<ImportList, ChannelEntry[] | null>
export interface ImportProblem {
	list: ImportList, index: number, reason: string,
}
export interface ParsedImport {
	lists: ImportedLists, problems: ImportProblem[],
}

/** Drop unrelated configuration and secrets before keeping a preview. */
export const parseSubscriptionImport = (value: unknown): ParsedImport => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Import must be a JSON object.')
	}
	const input = value as Record<string, unknown>
	if (input.formatVersion !== undefined && input.formatVersion !== 1) {
		throw new Error('Unsupported subscription export version.')
	}
	const lists: ImportedLists = { whitelistedChannelIds: null,
		blacklistedChannelIds: null, manualChannelIds: null,
		savedChannelSettings: null }
	const problems: ImportProblem[] = []
	let hasList = false
	for (const key of IMPORT_LISTS) {
		const raw = input[key]
		if (raw === undefined || raw === null) continue
		if (!Array.isArray(raw) || raw.length > 10_000) {
			throw new Error(`${key} must be a list of at most 10000 entries.`)
		}
		hasList = true
		const seen = new Set<string>()
		const entries: ChannelEntry[] = []
		for (const [index, item] of raw.entries()) {
			try {
				const data = typeof item === 'string' ? { id: item } : item
				if (!data || typeof data !== 'object' || Array.isArray(data) ||
						typeof data.id !== 'string' || !isChannelId(data.id)) {
					throw new Error('Invalid channel ID.')
				}
				if (seen.has(data.id)) throw new Error('Duplicate channel ID.')
				const entry: ChannelEntry = { id: data.id }
				for (const field of ['notify', 'notifyOnFirstScan',
					'manualPolicyExcluded', 'apiAllowlisted'] as const) {
					if (data[field] !== undefined) {
						if (typeof data[field] !== 'boolean') {
							throw new Error('Invalid notification setting.')
						}
						entry[field] = data[field]
					}
				}
				if (data.initialBacklog !== undefined) {
					entry.initialBacklog = parseBacklogPolicy(
						data.initialBacklog, 'initialBacklog')
				}
				seen.add(data.id); entries.push(entry)
			} catch {
				problems.push({ list: key, index,
					reason: 'Invalid or duplicate entry.' })
			}
		}
		lists[key] = entries
	}
	if (!hasList) throw new Error('Import contains no subscription lists.')
	return { lists, problems }
}
