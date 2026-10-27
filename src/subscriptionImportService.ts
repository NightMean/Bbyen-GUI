import { createHash, randomUUID } from 'crypto'
import fs from 'fs/promises'
import { ChannelEntry, Config, buildChannelSettingsMap } from './config'
import { mergeChannelEntries, parseChannelLists } from './lib/channelConfig'
import { updateJsonFile } from './lib/jsonFile'
import {
	IMPORT_LISTS, ImportedLists, ParsedImport, parseSubscriptionImport,
} from './subscriptionImport'

const FIELDS = ['notify', 'notifyOnFirstScan', 'initialBacklog'] as const
const MAX_PREVIEWS = 10
const PREVIEW_LIFETIME_MS = 10 * 60_000

const currentLists = (value: unknown): ImportedLists => {
	const raw = parseChannelLists(value)
	const input = Object.fromEntries(IMPORT_LISTS.map(key => [key, raw[key]]))
	if (input.whitelistedChannelIds === undefined) {
		input.whitelistedChannelIds = []
	}
	const parsed = parseSubscriptionImport(input)
	if (parsed.problems.length) {
		throw new Error('Existing channel data is invalid.')
	}
	for (const key of IMPORT_LISTS) {
		// Preserve existing fields that this importer does not understand.
		parsed.lists[key] = raw[key] === undefined ? null :
			mergeChannelEntries(raw[key] ?? [])
	}
	return parsed.lists
}

const revision = (lists: ImportedLists): string => createHash('sha256')
	.update(JSON.stringify(lists)).digest('hex')

const effectiveSettings = (lists: ImportedLists): Map<string, ChannelEntry> =>
	new Map(mergeChannelEntries([...(lists.savedChannelSettings ?? []),
		...(lists.whitelistedChannelIds ?? []), ...(lists.manualChannelIds ?? []),
	]).map(entry => [entry.id, entry]))

interface Preview {
	input: ParsedImport,
	revision: string,
	expiresAt: number,
}

export class ImportChangedError extends Error {}
export class ImportConfirmationError extends Error {}

export class SubscriptionImportService {
	private readonly previews = new Map<string, Preview>()

	constructor(private readonly filename: string,
		private readonly config: Config,
		private readonly clock: () => number = Date.now) {}

	async preview(value: unknown) {
		const input = parseSubscriptionImport(value)
		const existing = currentLists(JSON.parse(await fs.readFile(this.filename,
			'utf8')))
		const conflicts: { list: string, channelId: string, field: string,
			existing: unknown, incoming: unknown }[] = []
		const changes: typeof conflicts = []
		const additions: { list: string, channelId: string }[] = []
		const effective = effectiveSettings(existing)
		const createdLists: string[] = []
		let added = 0
		let existingCount = 0
		for (const list of IMPORT_LISTS) {
			if (existing[list] === null && input.lists[list] !== null) {
				createdLists.push(list)
			}
			const previous = new Map((existing[list] ?? []).map(c => [c.id, c]))
			for (const entry of input.lists[list] ?? []) {
				const prior = previous.get(entry.id)
				if (!prior) { added++; additions.push({ list, channelId: entry.id }) }
				else existingCount++
				for (const field of FIELDS) {
					const current = prior?.[field] ?? (list === 'blacklistedChannelIds'
						? undefined : effective.get(entry.id)?.[field])
					if (entry[field] !== undefined &&
							JSON.stringify(entry[field]) !== JSON.stringify(current)) {
						changes.push({ list, channelId: entry.id, field,
							existing: current ?? null, incoming: entry[field] })
					}
					if (entry[field] !== undefined && current !== undefined &&
							JSON.stringify(entry[field]) !== JSON.stringify(current)) {
						conflicts.push({ list, channelId: entry.id, field,
							existing: current, incoming: entry[field] })
					}
				}
			}
		}
		for (const [id, preview] of this.previews) {
			if (preview.expiresAt <= this.clock()) this.previews.delete(id)
		}
		while (this.previews.size >= MAX_PREVIEWS) {
			const oldest = this.previews.keys().next().value as string
			this.previews.delete(oldest)
		}
		const id = randomUUID()
		this.previews.set(id, { input, revision: revision(existing),
			expiresAt: this.clock() + PREVIEW_LIFETIME_MS })
		return { id, added, existing: existingCount, additions, changes,
			conflicts, createdLists, problems: input.problems }
	}

	async apply(id: string, choice: 'keep' | 'replace', partial: boolean) {
		const preview = this.previews.get(id)
		if (!preview || preview.expiresAt <= this.clock()) {
			this.previews.delete(id)
			throw new ImportChangedError('Import preview expired.')
		}
		if (choice !== 'keep' && choice !== 'replace') {
			throw new ImportConfirmationError('Choose how to handle conflicts.')
		}
		if (preview.input.problems.length && partial !== true) {
			throw new ImportConfirmationError('Partial import must be confirmed.')
		}
		const updated = await updateJsonFile(this.filename, value => {
			const current = currentLists(value)
			if (revision(current) !== preview.revision) {
				throw new ImportChangedError('Channel data changed after preview.')
			}
			const result = { ...parseChannelLists(value) }
			const effective = effectiveSettings(current)
			for (const list of IMPORT_LISTS) {
				const incoming = preview.input.lists[list]
				if (!incoming) continue
				const merged = new Map((current[list] ?? []).map(c => [c.id, c]))
				for (const entry of incoming) {
					const prior = merged.get(entry.id)
					const next: ChannelEntry = prior ? { ...prior } : { id: entry.id }
					for (const field of FIELDS) {
						const previous = prior?.[field] ??
							(list === 'blacklistedChannelIds' ? undefined :
								effective.get(entry.id)?.[field])
						if (entry[field] !== undefined &&
								(choice === 'replace' || previous === undefined)) {
							// The field types differ; retain their checked values as a group.
							Object.assign(next, { [field]: entry[field] })
						}
					}
					merged.set(entry.id, next)
				}
				result[list] = [...merged.values()]
			}
			currentLists(result)
			return result
		})
		const lists = currentLists(updated)
		this.config.whitelistedChannelIds = lists.whitelistedChannelIds ?? undefined
		this.config.blacklistedChannelIds = lists.blacklistedChannelIds ?? undefined
		this.config.manualChannelIds = lists.manualChannelIds ?? undefined
		this.config.savedChannelSettings = lists.savedChannelSettings ?? undefined
		this.config.channelSettingsById = buildChannelSettingsMap(
			mergeChannelEntries([...(lists.savedChannelSettings ?? []),
				...(lists.whitelistedChannelIds ?? []),
				...(lists.manualChannelIds ?? []),
			]))
		this.previews.delete(id)
	}
}
