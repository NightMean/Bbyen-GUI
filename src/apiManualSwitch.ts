import { createHash, randomUUID } from 'crypto'
import fs from 'fs/promises'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { Config } from './config'
import { normalizeApiChannelLists, applyApiChannelLists }
	from './apiChannelLists'
import { isChannelId } from './lib/channelId'
import { mergeChannelEntries } from './lib/channelConfig'
import { updateJsonFile } from './lib/jsonFile'
import { makeEmailEligibility } from './emailPolicy'
import {
	oauthTokenHash, recordOAuthCleanup, recoverOAuthCleanup, withOAuthTokenLock,
} from './oauthCleanup'

const hash = (value: unknown) => createHash('sha256')
	.update(JSON.stringify(value)).digest('hex')
type Lists = Awaited<ReturnType<typeof normalizeApiChannelLists>>
interface ManualChannel { channelId: string, title: string,
	manualPolicyExcluded: boolean }
interface Snapshot {
	config: unknown, lists: unknown, tracked: ManualChannel[],
	revision: string, tokenHash: string | null,
}
interface Journal {
	configBefore: string, configAfter: string, channelsBefore: string,
	channelsAfter: string, channelsJson: string, tokenHash: string | null,
}

const manualLists = async (value: unknown,
	tracked: { channelId: string, manualPolicyExcluded: boolean }[],
): Promise<Lists> => {
	const lists = await normalizeApiChannelLists(value)
	const all = mergeChannelEntries([...(lists.savedChannelSettings ?? []),
		...(lists.whitelistedChannelIds ?? []), ...(lists.manualChannelIds ?? [])])
	const allowlisted = new Set(lists.whitelistedChannelIds?.map(entry =>
		entry.id))
	const saved = all.map(entry => ({ ...entry,
		apiAllowlisted: allowlisted.has(entry.id) }))
	const byId = new Map(saved.map(entry => [entry.id, entry]))
	const selected = tracked.map(item => ({
		...(byId.get(item.channelId) ?? { id: item.channelId }),
		apiAllowlisted: allowlisted.has(item.channelId),
		manualPolicyExcluded: item.manualPolicyExcluded,
	}))
	return { ...lists, whitelistedChannelIds: selected,
		manualChannelIds: selected, savedChannelSettings: saved }
}

const configForManual = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Configuration is invalid.')
	}
	return { ...value, mode: 'whitelist' }
}

/** Recover a confirmed switch without overwriting later file edits. */
const recoverLocked = async (db: sqlite.Database, configFile: string,
	channelsFile: string): Promise<Lists | null> => {
	const journal: Journal | undefined = await db.get(
		'SELECT * FROM api_manual_switch WHERE id=1')
	if (!journal) return null
	const hashes = [journal.configBefore, journal.configAfter,
		journal.channelsBefore, journal.channelsAfter]
	if (hashes.some(value => typeof value !== 'string' ||
			!/^[a-f0-9]{64}$/.test(value)) ||
			(journal.tokenHash !== null &&
				!/^[a-f0-9]{64}$/.test(journal.tokenHash)) ||
			typeof journal.channelsJson !== 'string' ||
			journal.channelsJson.length > 1_000_000) {
		throw new Error('Saved source transition is invalid.')
	}
	const channels: unknown = JSON.parse(journal.channelsJson)
	if (!Array.isArray(channels) || channels.length > 10_000 ||
			channels.some(item => !item || typeof item !== 'object' ||
				typeof item.channelId !== 'string' || !isChannelId(item.channelId) ||
				typeof item.manualPolicyExcluded !== 'boolean') ||
			new Set(channels.map(item => item.channelId)).size !== channels.length) {
		throw new Error('Saved source transition has invalid channels.')
	}
	const lists = await updateJsonFile(channelsFile, async value => {
		if (hash(value) === journal.channelsAfter) {
			return normalizeApiChannelLists(value)
		}
		if (hash(value) !== journal.channelsBefore) {
			throw new Error('Channel settings changed during source recovery.')
		}
		const updated = await manualLists(value, channels)
		if (hash(updated) !== journal.channelsAfter) {
			throw new Error('Channel source recovery is inconsistent.')
		}
		return updated
	})
	await updateJsonFile(configFile, value => {
		if (hash(value) === journal.configAfter) return value
		if (hash(value) !== journal.configBefore) {
			throw new Error('Configuration changed during source recovery.')
		}
		const updated = configForManual(value)
		if (hash(updated) !== journal.configAfter) {
			throw new Error('Configuration recovery is inconsistent.')
		}
		return updated
	})
	await db.exec('BEGIN IMMEDIATE')
	try {
		if (journal.tokenHash) await recordOAuthCleanup(db, journal.tokenHash)
		await db.run('DELETE FROM api_manual_switch WHERE id=1')
		await db.exec('COMMIT')
	} catch (error) { await db.exec('ROLLBACK'); throw error }
	return lists
}

export const recoverApiManualSwitch = async (db: sqlite.Database,
	directory: string, configFile: string, channelsFile: string,
): Promise<Lists | null> => {
	if (!await db.get('SELECT id FROM api_manual_switch WHERE id=1')) return null
	return withOAuthTokenLock(directory, () =>
		recoverLocked(db, configFile, channelsFile))
}

/** Snapshot the currently monitored API channels into the manual whitelist. */
export class ApiManualSwitch {
	private preview?: { id: string, fingerprint: string, expiresAt: number }
	constructor(private readonly db: sqlite.Database,
		private readonly config: Config, private readonly directory: string,
		private readonly configFile: string, private readonly channelsFile: string,
		private readonly revision: () => Promise<string>,
		private readonly clock: () => number = Date.now,
		private readonly onPending: () => Promise<void> = async () => {}) {}

	private async snapshot(): Promise<Snapshot> {
		if (this.config.mode !== 'youtube' || this.config.manualTransitionPending ||
				await this.db.get('SELECT id FROM api_manual_switch WHERE id=1') ||
				await this.db.get('SELECT id FROM oauth_cleanup WHERE id=1')) {
			throw new Error('API tracking is unavailable for switching.')
		}
		const revision = await this.revision()
		const general = JSON.parse(await fs.readFile(this.configFile, 'utf8'))
		const lists: unknown = JSON.parse(
			await fs.readFile(this.channelsFile, 'utf8'))
		await normalizeApiChannelLists(lists)
		const rows = await this.db.all(`SELECT channelId, channelTitle AS title
			FROM subscriptions WHERE deleted=0 ORDER BY channelId LIMIT 10001`)
		if (rows.length > 10_000 ||
				rows.some(item => !isChannelId(item.channelId))) {
			throw new Error('Tracked channels are invalid.')
		}
		const manualRows = await this.db.all(`SELECT channelId FROM channel_sources
			WHERE manual=1 AND apiSubscribed=0`)
		const eligibility = makeEmailEligibility(this.config,
			new Set(manualRows.map(row => row.channelId as string)))
		const tracked: ManualChannel[] = rows.map(row => ({ ...row,
			manualPolicyExcluded: eligibility(row.channelId,
				this.config.channelSettingsById?.get(row.channelId)) === 'excluded' }))
		const tokenHash = await oauthTokenHash(this.directory)
		if (revision !== await this.revision() || this.config.mode !== 'youtube') {
			throw new Error('Authorization changed; review again.')
		}
		return { config: general, lists, tracked, revision, tokenHash }
	}

	async review() {
		const snapshot = await this.snapshot()
		const id = randomUUID()
		this.preview = { id, fingerprint: hash(snapshot),
			expiresAt: this.clock() + 10 * 60_000 }
		return { previewId: id, continuing: snapshot.tracked }
	}

	async apply(id: string): Promise<{
		pending: boolean, cleanupPending: boolean,
	}> {
		const preview = this.preview
		if (!preview || preview.id !== id || preview.expiresAt <= this.clock()) {
			throw new Error('Manual switch preview expired.')
		}
		const snapshot = await this.snapshot()
		if (hash(snapshot) !== preview.fingerprint) {
			throw new Error('Source changed; review again.')
		}
		let lists: Lists | null = null
		try { await withOAuthTokenLock(this.directory, async () => {
			const latest = await this.snapshot()
			if (hash(latest) !== preview.fingerprint) {
				throw new Error('Source changed; review again.')
			}
			const channels = snapshot.tracked.map(item => ({
				channelId: item.channelId,
				manualPolicyExcluded: item.manualPolicyExcluded }))
			const next = await manualLists(snapshot.lists, channels)
			await this.db.run(SQL`INSERT INTO api_manual_switch
				(id, configBefore, configAfter, channelsBefore, channelsAfter,
					channelsJson, tokenHash)
				VALUES (1, ${hash(snapshot.config)},
					${hash(configForManual(snapshot.config))},
					${hash(snapshot.lists)}, ${hash(next)}, ${JSON.stringify(channels)},
					${snapshot.tokenHash});`)
			this.config.manualTransitionPending = true
			this.preview = undefined
			try { lists = await recoverLocked(this.db, this.configFile,
				this.channelsFile) } catch {
				// The confirmed transition remains journaled for the retry worker.
			}
		}) } catch (error) {
			if (!lists && !this.config.manualTransitionPending) throw error
		}
		if (!lists) {
			try { await this.onPending() } catch {
				// Diagnostics cannot replace the confirmed transition outcome.
			}
			return { pending: true, cleanupPending: false }
		}
		this.finishRuntime(lists)
		try { await recoverOAuthCleanup(this.db, this.directory) } catch {
			// Credential cleanup remains journaled for retry.
		}
		return { pending: false,
			cleanupPending: !!await this.db.get('SELECT id FROM oauth_cleanup') }
	}

	finishRuntime(lists: Lists): void {
		applyApiChannelLists(this.config, lists)
		this.config.mode = 'whitelist'
		this.config.manualTransitionPending = false
	}
}
