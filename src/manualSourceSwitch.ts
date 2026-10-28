import { createHash, randomUUID } from 'crypto'
import fs from 'fs/promises'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import {
	Config, buildChannelSettingsMap, normalizeChannelEntries,
} from './config'
import { CookiePreviewService } from './cookiePreview'
import { legacyCookieHash, recoverCookieCleanup } from './cookieCleanup'
import { assertChannelId } from './lib/channelId'
import { mergeChannelEntries, parseChannelLists } from './lib/channelConfig'
import { updateJsonFile } from './lib/jsonFile'

const hash = (value: unknown) => createHash('sha256')
	.update(JSON.stringify(value)).digest('hex')

interface Snapshot {
	generation: string,
	channels: { channelId: string, title: string }[],
	configHash: string,
	channelsHash: string,
	legacyHash: string | null,
}

/** Preview and apply a cookie-to-manual transition, retaining preferences. */
export class ManualSourceSwitch {
	private previews = new Map<string, {
		snapshot: Snapshot, expiresAt: number,
	}>()
	constructor(private readonly db: sqlite.Database,
		private readonly config: Config,
		private readonly configFile: string, private readonly channelsFile: string,
		private readonly directory: string,
		private readonly cookies: CookiePreviewService,
		private readonly clock: () => number = Date.now) {}

	private async snapshot(): Promise<Snapshot> {
		const connection = await this.db.get(
			'SELECT generation FROM cookie_connection WHERE id=1')
		if (!connection || this.config.mode !== 'cookie' ||
				this.config.apiEnrichment) {
			throw new Error('Cookie mode is not active.')
		}
		const rows = await this.db.all(`SELECT channelId, channelTitle
			FROM subscriptions WHERE deleted=0 ORDER BY channelId LIMIT 10001`)
		if (rows.length > 10_000) throw new Error('Too many tracked channels.')
		const channels = rows.map(row => ({
			channelId: assertChannelId(row.channelId), title: row.channelTitle }))
		const general = JSON.parse(await fs.readFile(this.configFile, 'utf8'))
		const lists = JSON.parse(await fs.readFile(this.channelsFile, 'utf8'))
		parseChannelLists(lists)
		return { generation: connection.generation, channels,
			configHash: hash(general), channelsHash: hash(lists),
			legacyHash: await legacyCookieHash(this.directory) }
	}

	async preview() {
		const snapshot = await this.snapshot()
		const id = randomUUID()
		this.previews.clear()
		this.previews.set(id, { snapshot, expiresAt: this.clock() + 10 * 60_000 })
		return { previewId: id, continuing: snapshot.channels,
			legacyCookieFile: snapshot.legacyHash !== null,
			environmentCookie: process.env.YOUTUBE_COOKIE !== undefined }
	}

	async apply(id: string): Promise<{ cleanupPending: boolean }> {
		const preview = this.previews.get(id)
		if (!preview || preview.expiresAt <= this.clock()) {
			throw new Error('Manual switch preview expired.')
		}
		await this.db.exec('PRAGMA secure_delete=ON')
		await this.db.exec('BEGIN IMMEDIATE')
		let changedLists: Awaited<ReturnType<typeof normalizeLists>> | undefined
		try {
			const current = await this.snapshot()
			if (hash(current) !== hash(preview.snapshot)) {
				throw new Error('Source data changed; preview again.')
			}
			await updateJsonFile(this.configFile, value => {
				if (hash(value) !== preview.snapshot.configHash || !value ||
						typeof value !== 'object' || Array.isArray(value)) {
					throw new Error('Configuration changed; preview again.')
				}
				return { ...value, mode: 'whitelist' }
			})
			changedLists = await updateJsonFile(this.channelsFile, async value => {
				if (hash(value) !== preview.snapshot.channelsHash) {
					throw new Error('Channel lists changed; preview again.')
				}
				const lists = await normalizeLists(value)
				const all = mergeChannelEntries([...(lists.savedChannelSettings ?? []),
					...(lists.whitelistedChannelIds ?? []),
					...(lists.manualChannelIds ?? []),
				])
				const settings = new Map(all.map(entry => [entry.id, entry]))
				const tracked = current.channels.map(item => {
					const entry = settings.get(item.channelId) ?? { id: item.channelId }
					return entry.manualPolicyExcluded ? { ...entry,
						manualPolicyExcluded: false } : entry
				})
				return { ...lists, whitelistedChannelIds: tracked,
					manualChannelIds: tracked, savedChannelSettings: all }
			})
			await this.db.run(SQL`INSERT INTO cookie_cleanup (id, legacyHash)
				VALUES (1, ${current.legacyHash}) ON CONFLICT(id) DO UPDATE SET
				legacyHash=excluded.legacyHash;`)
			const removed = await this.db.run(SQL`DELETE FROM cookie_connection
				WHERE id=1 AND generation=${current.generation};`)
			if (!removed.changes) throw new Error('Cookie connection changed.')
			await this.db.exec('COMMIT')
		} catch (err) {
			try { await this.db.exec('ROLLBACK') } catch {
				console.warn('Could not roll back the source switch.')
			}
			try {
				const active = await this.db.get('SELECT id FROM cookie_connection')
				if (!active && changedLists) this.applyRuntime(changedLists)
			} catch {
				this.config.cookieStale = true
				console.warn('Could not verify the source switch outcome.')
			}
			throw err
		}
		this.applyRuntime(changedLists!)
		let cleaned = false
		try {
			cleaned = await recoverCookieCleanup(this.db, this.directory)
		} catch {
			console.warn('Cookie cleanup is pending.')
		}
		return { cleanupPending: !cleaned }
	}

	private applyRuntime(
		changedLists: Awaited<ReturnType<typeof normalizeLists>>,
	) {
		this.config.mode = 'whitelist'
		this.config.cookieStale = false
		this.config.whitelistedChannelIds = changedLists.whitelistedChannelIds
		this.config.blacklistedChannelIds = changedLists.blacklistedChannelIds
		this.config.manualChannelIds = changedLists.manualChannelIds
		this.config.savedChannelSettings = changedLists.savedChannelSettings
		this.config.channelSettingsById = buildChannelSettingsMap(
			mergeChannelEntries([...(changedLists.savedChannelSettings ?? []),
				...(changedLists.whitelistedChannelIds ?? []),
				...(changedLists.manualChannelIds ?? []),
			]))
		this.cookies.dispose()
		this.previews.clear()
	}
}

const normalizeLists = async (value: unknown) => {
	const lists = parseChannelLists(value)
	const normalize = async (id: string) => assertChannelId(id)
	return { ...lists,
		whitelistedChannelIds: await normalizeChannelEntries(normalize,
			lists.whitelistedChannelIds),
		blacklistedChannelIds: await normalizeChannelEntries(normalize,
			lists.blacklistedChannelIds),
		manualChannelIds: await normalizeChannelEntries(normalize,
			lists.manualChannelIds),
		savedChannelSettings: await normalizeChannelEntries(normalize,
			lists.savedChannelSettings),
	}
}
