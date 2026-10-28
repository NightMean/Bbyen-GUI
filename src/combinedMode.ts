import { createHash, randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { compareConnectionIdentities } from './combinedIdentity'
import {
	oauthTokenHash, recordOAuthCleanup, recoverOAuthCleanup, withOAuthTokenLock,
} from './oauthCleanup'

type Direction = 'enable' | 'disable'
type Snapshot = { generation: string, revision: string, profileKey: string,
	channels: { channelId: string, title: string }[] }

/** Review and commit API enrichment while the cookie remains authoritative. */
export class CombinedMode {
	private preview?: { id: string, direction: Direction, fingerprint: string,
		expiresAt: number }
	constructor(private readonly db: sqlite.Database,
		private readonly config: Config,
		private readonly store: CookieConnectionStore,
		private readonly service: youtube_v3.Youtube,
		private readonly loadAuth: () => Promise<OAuth2Client>,
		private readonly revision: () => Promise<string>,
		private readonly directory: string,
		private readonly clock: () => number = Date.now) {}

	private async snapshot(direction: Direction): Promise<Snapshot> {
		if (this.config.mode !== 'cookie' ||
				!!this.config.apiEnrichment !== (direction === 'disable')) {
			throw new Error('Connection mode changed.')
		}
		if (await this.store.oauthCleanupPending()) {
			throw new Error('Previous authorization cleanup is pending.')
		}
		const cookie = await this.store.read()
		if (!cookie?.profile.channelId) throw new Error('Cookie is unavailable.')
		const revision = await this.revision()
		if (direction === 'enable') {
			const comparison = await compareConnectionIdentities({ store: this.store,
				service: this.service, loadAuth: this.loadAuth,
				authRevision: this.revision })
			if (!comparison.matches) throw new Error('YouTube profiles differ.')
		}
		const rows = await this.db.all(`SELECT channelId, channelTitle AS title
			FROM subscriptions WHERE deleted=0 ORDER BY channelId LIMIT 10001`)
		if (rows.length > 10_000) throw new Error('Too many tracked channels.')
		if ((await this.store.read())?.generation !== cookie.generation ||
				revision !== await this.revision()) {
			throw new Error('Connections changed; review again.')
		}
		return { generation: cookie.generation,
			profileKey: cookie.profile.channelId,
			revision, channels: rows }
	}

	private fingerprint(value: Snapshot): string {
		return createHash('sha256').update(JSON.stringify(value)).digest('hex')
	}

	async review(direction: Direction) {
		const snapshot = await this.snapshot(direction)
		const id = randomUUID()
		this.preview = { id, direction, fingerprint: this.fingerprint(snapshot),
			expiresAt: this.clock() + 10 * 60_000 }
		return { previewId: id, continuing: snapshot.channels }
	}

	async apply(id: string): Promise<{ cleanupPending: boolean,
		apiEnrichment: boolean }> {
		const preview = this.preview
		if (!preview || preview.id !== id || preview.expiresAt <= this.clock()) {
			throw new Error('Connection preview expired.')
		}
		const current = await this.snapshot(preview.direction)
		if (this.fingerprint(current) !== preview.fingerprint) {
			throw new Error('Connections changed; review again.')
		}
		let committed = false
		try {
			await withOAuthTokenLock(this.directory, async () => {
				if (await this.revision() !== current.revision ||
						(await this.store.read())?.generation !== current.generation) {
					throw new Error('Connections changed; review again.')
				}
				await this.db.exec('BEGIN IMMEDIATE')
				try {
					if (preview.direction === 'enable') {
						await this.db.run(SQL`INSERT INTO combined_connection
							(id, profileKey) VALUES (1, ${current.profileKey});`)
					} else {
						const hash = await oauthTokenHash(this.directory)
						if (hash) await recordOAuthCleanup(this.db, hash)
						await this.db.run('DELETE FROM combined_connection WHERE id=1')
					}
					await this.db.exec('COMMIT')
					committed = true
				} catch (error) { await this.db.exec('ROLLBACK'); throw error }
			})
		} catch (error) { if (!committed) throw error }
		this.config.apiEnrichment = preview.direction === 'enable'
		this.preview = undefined
		if (preview.direction === 'disable') {
			try { await recoverOAuthCleanup(this.db, this.directory) } catch {
				// The journal remains available for automatic retry.
			}
		}
		return { cleanupPending: await this.store.oauthCleanupPending(),
			apiEnrichment: !!this.config.apiEnrichment }
	}
}
