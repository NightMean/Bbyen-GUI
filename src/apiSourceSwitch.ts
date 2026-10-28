import { createHash, randomUUID } from 'crypto'
import fs from 'fs/promises'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { OAuth2Client } from 'google-auth-library'
import { youtube_v3 } from 'googleapis'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { CookiePreviewService } from './cookiePreview'
import { compareConnectionIdentities } from './combinedIdentity'
import { legacyCookieHash, recoverCookieCleanup } from './cookieCleanup'
import { ApiChannel, ApiSubscriptionSnapshot, applyApiSnapshot }
	from './apiSubscriptions'
import { isChannelId } from './lib/channelId'
import { updateJsonFile } from './lib/jsonFile'
import { withOAuthTokenLock } from './oauthCleanup'

interface Snapshot {
	profileId: string,
	generation: string, revision: string, configHash: string,
	legacyHash: string | null, channels: ApiChannel[],
	manual: string[], terminated: string[],
	tracked: { channelId: string, title: string }[],
}
const hash = (value: unknown) => createHash('sha256')
	.update(JSON.stringify(value)).digest('hex')

/** The API omitted subscriptions independently confirmed by the cookie. */
export class IncompleteApiSnapshot extends Error {}
export class UnconfirmedCookieSnapshot extends Error {}

/** Switch from cookie authority to a reviewed, complete API snapshot. */
export class ApiSourceSwitch {
	private preview?: { id: string, fingerprint: string, expiresAt: number }
	constructor(private readonly db: sqlite.Database,
		private readonly config: Config,
		private readonly store: CookieConnectionStore,
		private readonly cookies: CookiePreviewService,
		private readonly service: youtube_v3.Youtube,
		private readonly loadAuth: () => Promise<OAuth2Client>,
		private readonly revision: () => Promise<string>,
		private readonly directory: string, private readonly configFile: string,
		private readonly clock: () => number = Date.now) {}

	private async snapshot(): Promise<Snapshot> {
		if (this.config.mode !== 'cookie' || await this.store.cleanupPending()) {
			throw new Error('Cookie connection is unavailable.')
		}
		const cookie = await this.store.read()
		if (!cookie?.profile.channelId || cookie.stale) {
			throw new UnconfirmedCookieSnapshot('Cookie snapshot is unconfirmed.')
		}
		const revision = await this.revision()
		const comparison = await compareConnectionIdentities({ store: this.store,
			service: this.service, loadAuth: this.loadAuth,
			authRevision: this.revision })
		if (!comparison.matches) throw new Error('YouTube profiles differ.')
		const auth = await this.loadAuth()
		const entries = new ApiSubscriptionSnapshot()
		await entries.read(this.service, auth)
		const cookieRows = await this.db.all(SQL`SELECT channelId
			FROM cookie_channel_state WHERE profileKey=${cookie.profile.channelId}
			AND subscribed=1 ORDER BY channelId LIMIT 10001;`)
		if (!cookieRows.length || cookieRows.length > 10_000 ||
				cookieRows.some(row => !isChannelId(row.channelId))) {
			throw new Error('Cookie subscription list is invalid.')
		}
		if (!await entries.verifyKnown(this.service, auth,
			cookieRows.map(row => row.channelId as string))) {
			throw new IncompleteApiSnapshot('API snapshot is incomplete.')
		}
		const manual = (this.config.manualChannelIds ?? []).map(item => item.id)
		if (manual.some(id => !isChannelId(id))) {
			throw new Error('Manual channel list is invalid.')
		}
		const tracked = await this.db.all(`SELECT channelId, channelTitle AS title
			FROM subscriptions WHERE deleted=0 ORDER BY channelId LIMIT 10001`)
		if (tracked.length > 10_000) throw new Error('Too many tracked channels.')
		const terminated = (await this.db.all(`SELECT channelId FROM subscriptions
			WHERE deletedReason='terminated' ORDER BY channelId`))
			.map(row => row.channelId as string)
		const general = JSON.parse(await fs.readFile(this.configFile, 'utf8'))
		const legacyHash = await legacyCookieHash(this.directory)
		if ((await this.store.read())?.generation !== cookie.generation ||
				revision !== await this.revision() || this.config.mode !== 'cookie') {
			throw new Error('Connections changed; review again.')
		}
		return { profileId: cookie.profile.channelId,
			generation: cookie.generation, revision, configHash: hash(general),
			legacyHash, channels: entries.channels(), manual: [...manual].sort(),
			tracked, terminated }
	}

	async review() {
		const snapshot = await this.snapshot()
		const terminated = new Set(snapshot.terminated)
		const next = new Map(snapshot.channels.filter(item =>
			!terminated.has(item.channelId)).map(item => [item.channelId,
			{ channelId: item.channelId, title: item.title }]))
		for (const id of snapshot.manual) {
			if (!next.has(id) && !terminated.has(id)) {
				next.set(id, { channelId: id, title: id })
			}
		}
		const old = new Set(snapshot.tracked.map(item => item.channelId))
		const continuing = [...next.values()].filter(item =>
			old.has(item.channelId))
		const start = [...next.values()].filter(item => !old.has(item.channelId))
		const stop = snapshot.tracked.filter(item => !next.has(item.channelId))
		const id = randomUUID()
		this.preview = { id, fingerprint: hash(snapshot),
			expiresAt: this.clock() + 10 * 60_000 }
		return { previewId: id, start, stop, continuing,
			legacyCookieFile: snapshot.legacyHash !== null,
			environmentCookie: process.env.YOUTUBE_COOKIE !== undefined }
	}

	async apply(id: string): Promise<{ cleanupPending: boolean }> {
		const preview = this.preview
		if (!preview || preview.id !== id || preview.expiresAt <= this.clock()) {
			throw new Error('API source preview expired.')
		}
		const snapshot = await this.snapshot()
		if (hash(snapshot) !== preview.fingerprint) {
			throw new Error('Source changed; review again.')
		}
		await this.db.exec('PRAGMA secure_delete=ON')
		let committed = false
		try {
			await withOAuthTokenLock(this.directory, async () => {
				committed = await this.commitSnapshot(snapshot)
			})
		} catch (error) {
			if (!committed) throw error
		} finally {
			if (committed) {
				this.config.mode = 'youtube'
				this.config.apiEnrichment = false
				this.config.cookieStale = false
				this.config.emailSelectionPolicy ??= 'allowlist'
				this.cookies.dispose()
				this.preview = undefined
			}
		}
		try { await recoverCookieCleanup(this.db, this.directory) } catch {
			// The cleanup journal is retried by the service after restart.
		}
		return { cleanupPending: await this.store.cleanupPending() }
	}

	private async commitSnapshot(snapshot: Snapshot): Promise<boolean> {
		await this.db.exec('BEGIN IMMEDIATE')
		try {
			if (this.config.mode !== 'cookie' ||
					(await this.store.read())?.generation !== snapshot.generation ||
					await this.revision() !== snapshot.revision) {
				throw new Error('Connections changed; review again.')
			}
			await updateJsonFile(this.configFile, value => {
				if (hash(value) !== snapshot.configHash || !value ||
						typeof value !== 'object' || Array.isArray(value)) {
					throw new Error('Configuration changed; review again.')
				}
				return { ...value, mode: 'youtube',
					emailSelectionPolicy: this.config.emailSelectionPolicy ??
						'allowlist' }
			})
			await applyApiSnapshot(this.db, snapshot)
			await this.db.run(SQL`INSERT INTO api_account_identity (id, channelId)
				VALUES (1, ${snapshot.profileId}) ON CONFLICT(id) DO UPDATE SET
				channelId=excluded.channelId;`)
			await this.db.run(SQL`INSERT INTO cookie_cleanup (id, legacyHash)
				VALUES (1, ${snapshot.legacyHash});`)
			await this.db.run('DELETE FROM combined_connection WHERE id=1')
			const removed = await this.db.run(SQL`DELETE FROM cookie_connection
				WHERE id=1 AND generation=${snapshot.generation};`)
			if (!removed.changes) throw new Error('Cookie connection changed.')
			await this.db.exec('COMMIT')
			return true
		} catch (error) {
			try { await this.db.exec('ROLLBACK') } catch {
				// Preserve the original failure.
			}
			try { if (!(await this.store.read())) return true } catch {
				// Do not infer success if the authority cannot be read.
			}
			throw error
		}
	}

}
