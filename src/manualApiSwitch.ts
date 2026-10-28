import { createHash, randomUUID } from 'crypto'
import fs from 'fs/promises'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { OAuth2Client } from 'google-auth-library'
import { youtube_v3 } from 'googleapis'
import { Config, buildChannelSettingsMap } from './config'
import { normalizeApiChannelLists, applyApiChannelLists }
	from './apiChannelLists'
import { ApiChannel, ApiSubscriptionSnapshot, applyApiSnapshot }
	from './apiSubscriptions'
import { readAccountIdentity } from './google/accountIdentity'
import { withAuthorizationTimeout } from './google/desktopAuthorization'
import { isChannelId } from './lib/channelId'
import { mergeChannelEntries } from './lib/channelConfig'
import { updateJsonFile } from './lib/jsonFile'
import { withOAuthTokenLock } from './oauthCleanup'
import { makeEmailEligibility } from './emailPolicy'

const hash = (value: unknown) => createHash('sha256')
	.update(JSON.stringify(value)).digest('hex')
type Lists = Awaited<ReturnType<typeof normalizeApiChannelLists>>
interface Snapshot {
	config: unknown, lists: unknown, revision: string,
	identity: { channelId: string, title: string }, channels: ApiChannel[],
	tracked: { channelId: string, title: string, emailEnabled: boolean }[],
	manual: string[],
	terminated: string[], policy: 'allowlist' | 'blocklist',
}
interface Journal {
	configBefore: string, configAfter: string, channelsBefore: string,
	channelsAfter: string, trackedJson: string, authRevision: string,
}

/** Restore archived API membership and include newly added manual channels. */
export const listsForApi = async (value: unknown, tracked: string[])
	: Promise<Lists> => {
	const lists = await normalizeApiChannelLists(value)
	const all = mergeChannelEntries([...(lists.savedChannelSettings ?? []),
		...(lists.whitelistedChannelIds ?? []), ...(lists.manualChannelIds ?? [])])
	const byId = new Map(all.map(entry => [entry.id, entry]))
	const archived = all.some(entry => entry.apiAllowlisted !== undefined)
	const allowed = archived ?
		all.filter(entry => entry.apiAllowlisted === true) :
		(lists.whitelistedChannelIds ?? [])
	const additions = archived ? (lists.whitelistedChannelIds ?? [])
		.filter(entry => entry.apiAllowlisted === undefined) : []
	const manual = mergeChannelEntries([...(lists.manualChannelIds ?? []),
		...tracked.map(id => byId.get(id) ?? { id })])
	return { ...lists,
		whitelistedChannelIds: mergeChannelEntries([...allowed, ...additions]),
		manualChannelIds: manual }
}

const configForApi = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Configuration is invalid.')
	}
	const current = value as Record<string, unknown>
	const policy = current.emailSelectionPolicy ?? 'allowlist'
	if (policy !== 'allowlist' && policy !== 'blocklist') {
		throw new Error('API email selection policy is invalid.')
	}
	return { ...current, mode: 'youtube', emailSelectionPolicy: policy }
}

const recoverLocked = async (db: sqlite.Database, configFile: string,
	channelsFile: string, revision: () => Promise<string>,
): Promise<{ lists: Lists, policy: 'allowlist' | 'blocklist' } | null> => {
	const journal: Journal | undefined = await db.get(
		'SELECT * FROM manual_api_switch WHERE id=1')
	if (!journal) return null
	const hashes = [journal.configBefore, journal.configAfter,
		journal.channelsBefore, journal.channelsAfter, journal.authRevision]
	if (hashes.some(value => typeof value !== 'string' ||
			!/^[a-f0-9]{64}$/.test(value)) ||
			typeof journal.trackedJson !== 'string' ||
			journal.trackedJson.length > 400_000) {
		throw new Error('Saved source transition is invalid.')
	}
	const ids: unknown = JSON.parse(journal.trackedJson)
	if (!Array.isArray(ids) || ids.length > 10_000 ||
			ids.some(id => typeof id !== 'string' || !isChannelId(id)) ||
			new Set(ids).size !== ids.length) {
		throw new Error('Saved source transition has invalid channels.')
	}
	if (journal.authRevision !== await revision()) {
		throw new Error('Google authorization changed during source recovery.')
	}
	const lists = await updateJsonFile(channelsFile, async value => {
		if (hash(value) === journal.channelsAfter) {
			return normalizeApiChannelLists(value)
		}
		if (hash(value) !== journal.channelsBefore) {
			throw new Error('Channel settings changed during source recovery.')
		}
		const updated = await listsForApi(value, ids as string[])
		if (hash(updated) !== journal.channelsAfter) {
			throw new Error('Channel source recovery is inconsistent.')
		}
		return updated
	})
	const general = await updateJsonFile(configFile, value => {
		if (hash(value) === journal.configAfter) return configForApi(value)
		if (hash(value) !== journal.configBefore) {
			throw new Error('Configuration changed during source recovery.')
		}
		const updated = configForApi(value)
		if (hash(updated) !== journal.configAfter) {
			throw new Error('Configuration recovery is inconsistent.')
		}
		return updated
	})
	await db.run('DELETE FROM manual_api_switch WHERE id=1')
	return { lists,
		policy: general.emailSelectionPolicy as 'allowlist' | 'blocklist' }
}

export const recoverManualApiSwitch = async (db: sqlite.Database,
	directory: string, configFile: string, channelsFile: string,
	revision: () => Promise<string>,
) => {
	if (!await db.get('SELECT id FROM manual_api_switch WHERE id=1')) return null
	return withOAuthTokenLock(directory, () =>
		recoverLocked(db, configFile, channelsFile, revision))
}

/** Confirm an API snapshot while retaining channels manually tracked today. */
export class ManualApiSwitch {
	private preview?: { id: string, fingerprint: string, expiresAt: number }
	constructor(private readonly db: sqlite.Database,
		private readonly config: Config, private readonly directory: string,
		private readonly configFile: string, private readonly channelsFile: string,
		private readonly service: youtube_v3.Youtube,
		private readonly loadAuth: () => Promise<OAuth2Client>,
		private readonly revision: () => Promise<string>,
		private readonly clock: () => number = Date.now,
		private readonly onPending: () => Promise<void> = async () => {}) {}

	private async snapshot(): Promise<Snapshot> {
		if (this.config.mode !== 'whitelist' ||
				this.config.manualTransitionPending ||
				await this.db.get('SELECT id FROM api_manual_switch WHERE id=1') ||
				await this.db.get('SELECT id FROM manual_api_switch WHERE id=1') ||
				await this.db.get('SELECT id FROM oauth_cleanup WHERE id=1')) {
			throw new Error('Manual tracking is unavailable for switching.')
		}
		const revision = await this.revision()
		const auth = await this.loadAuth()
		const identity = await withAuthorizationTimeout(
			readAccountIdentity(this.service, auth))
		const source = new ApiSubscriptionSnapshot()
		await source.read(this.service, auth)
		const general: unknown = JSON.parse(
			await fs.readFile(this.configFile, 'utf8'))
		const policy = configForApi(general).emailSelectionPolicy as
			'allowlist' | 'blocklist'
		const lists: unknown = JSON.parse(
			await fs.readFile(this.channelsFile, 'utf8'))
		const normalized = await normalizeApiChannelLists(lists)
		const rows = await this.db.all(`SELECT channelId, channelTitle AS title
			FROM subscriptions WHERE deleted=0 ORDER BY channelId LIMIT 10001`)
		if (rows.length > 10_000 || rows.some(row => !isChannelId(row.channelId))) {
			throw new Error('Tracked channels are invalid.')
		}
		const currentEmail = makeEmailEligibility(this.config)
		const tracked = rows.map(row => ({ ...row,
			emailEnabled: currentEmail(row.channelId,
				this.config.channelSettingsById?.get(row.channelId)) === 'eligible' }))
		const manual = [...new Set([
			...(normalized.manualChannelIds ?? []).map(c => c.id),
			...tracked.map(row => row.channelId as string)])].sort()
		if (manual.length > 10_000) throw new Error('Too many manual channels.')
		const terminated = (await this.db.all(`SELECT channelId FROM subscriptions
			WHERE deletedReason='terminated' ORDER BY channelId`))
			.map(row => row.channelId as string)
		if (revision !== await this.revision() ||
				this.config.mode !== 'whitelist') {
			throw new Error('Authorization changed; review again.')
		}
		return { config: general, lists, revision, identity,
			channels: source.channels(),
			tracked, manual, terminated, policy }
	}

	async review() {
		const snapshot = await this.snapshot()
		const terminated = new Set(snapshot.terminated)
		const old = new Set(snapshot.tracked.map(item => item.channelId))
		const next = new Map(snapshot.channels.map(item => [item.channelId,
			{ channelId: item.channelId, title: item.title }]))
		for (const channelId of snapshot.manual) {
			if (!next.has(channelId)) {
				next.set(channelId, { channelId, title: channelId })
			}
		}
		const start = [...next.values()].filter(item => !old.has(item.channelId) &&
			!terminated.has(item.channelId))
		const lists = await listsForApi(snapshot.lists,
			snapshot.tracked.map(item => item.channelId))
		const settings = buildChannelSettingsMap(mergeChannelEntries([
			...(lists.savedChannelSettings ?? []),
			...(lists.whitelistedChannelIds ?? []),
			...(lists.manualChannelIds ?? []),
		]))
		const apiIds = new Set(snapshot.channels.map(item => item.channelId))
		const manualOnly = new Set(snapshot.manual.filter(id => !apiIds.has(id)))
		const eligibility = makeEmailEligibility({ ...this.config, mode: 'youtube',
			emailSelectionPolicy: snapshot.policy,
			whitelistedChannelIds: lists.whitelistedChannelIds,
			blacklistedChannelIds: lists.blacklistedChannelIds }, manualOnly)
		const emailChanges = snapshot.tracked.map(item => ({ ...item,
			after: eligibility(item.channelId, settings.get(item.channelId)) ===
				'eligible',
		})).filter(item => item.emailEnabled !== item.after)
		const id = randomUUID()
		this.preview = { id, fingerprint: hash(snapshot),
			expiresAt: this.clock() + 10 * 60_000 }
		return { previewId: id, profile: snapshot.identity, start, emailChanges,
			continuing: snapshot.tracked, stop: [] }
	}

	async apply(id: string): Promise<{ pending: boolean }> {
		const preview = this.preview
		if (!preview || preview.id !== id || preview.expiresAt <= this.clock()) {
			throw new Error('API switch preview expired.')
		}
		const snapshot = await this.snapshot()
		if (hash(snapshot) !== preview.fingerprint) {
			throw new Error('Source changed; review again.')
		}
		let recovered: Awaited<ReturnType<typeof recoverLocked>> = null
		let committed = false
		try {
			await withOAuthTokenLock(this.directory, async () => {
				if (this.config.mode !== 'whitelist' ||
						await this.revision() !== snapshot.revision) {
					throw new Error('Authorization changed; review again.')
				}
				const ids = snapshot.tracked.map(item => item.channelId)
				const next = await listsForApi(snapshot.lists, ids)
				await this.db.exec('BEGIN IMMEDIATE')
				try {
					await applyApiSnapshot(this.db, snapshot)
					await this.db.run(SQL`INSERT INTO api_account_identity (id, channelId)
						VALUES (1, ${snapshot.identity.channelId})
						ON CONFLICT(id) DO UPDATE SET channelId=excluded.channelId;`)
					await this.db.run(SQL`INSERT INTO manual_api_switch
						(id, configBefore, configAfter, channelsBefore, channelsAfter,
							trackedJson, authRevision)
						VALUES (1, ${hash(snapshot.config)},
							${hash(configForApi(snapshot.config))}, ${hash(snapshot.lists)},
							${hash(next)}, ${JSON.stringify(ids)}, ${snapshot.revision});`)
					// A lost COMMIT acknowledgement leaves the database outcome unknown.
					// Pause work until recovery can establish the durable state.
					this.config.manualTransitionPending = true
					committed = true
					await this.db.exec('COMMIT')
					committed = true
				} catch (error) {
					try { await this.db.exec('ROLLBACK') } catch { /* Preserve error. */ }
					try {
						committed = !!await this.db.get('SELECT id FROM manual_api_switch')
					} catch { /* An unknown outcome remains paused for recovery. */ }
					if (!committed) {
						this.config.manualTransitionPending = false
						throw error
					}
				}
				this.config.manualTransitionPending = true
				this.preview = undefined
				try { recovered = await recoverLocked(this.db, this.configFile,
					this.channelsFile, this.revision) } catch {
					// The committed snapshot remains journaled for the retry worker.
				}
			})
		} catch (error) { if (!committed) throw error }
		if (!recovered) {
			try { await this.onPending() } catch { /* Keep the outcome. */ }
			return { pending: true }
		}
		this.finishRuntime(recovered)
		return { pending: false }
	}

	finishRuntime(result: { lists: Lists, policy: 'allowlist' | 'blocklist' }) {
		applyApiChannelLists(this.config, result.lists)
		this.config.mode = 'youtube'
		this.config.emailSelectionPolicy = result.policy
		this.config.manualTransitionPending = false
	}
}
