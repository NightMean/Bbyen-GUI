import { randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { reconcileCookieSnapshot } from './cookieReconciliation'
import { isChannelId } from './lib/channelId'
import {
	extractSapisidFromCookie, ChannelBellState,
} from './lib/innertubeChannels'
import { ResolvedCookieProfile } from './lib/cookieProfiles'
import { recordOAuthCleanup } from './oauthCleanup'

export interface CookieConnection {
	generation: string,
	cookieHeader: string,
	profile: ResolvedCookieProfile,
	stale: boolean,
	lastSuccessfulAt: string,
}

/** Store a confirmed cookie connection and its authority in one transaction. */
export class CookieConnectionStore {
	constructor(private readonly db: sqlite.Database) {}

	async activate(cookieHeader: string, profile: ResolvedCookieProfile,
		channels: ChannelBellState[], oauthHash?: string,
		combinedProfile?: string): Promise<string> {
		if (oauthHash && combinedProfile) {
			throw new Error('Cannot combine and remove the same authorization.')
		}
		if (!Array.isArray(channels) || !channels.length ||
				typeof cookieHeader !== 'string' || cookieHeader.length > 256 * 1024 ||
				!extractSapisidFromCookie(cookieHeader) || !profile.selectable ||
				!profile.channelId || !isChannelId(profile.channelId) ||
				typeof profile.name !== 'string' || profile.name.length > 200 ||
				(profile.pageId !== undefined && (typeof profile.pageId !== 'string' ||
				!profile.pageId || profile.pageId.length > 256))) {
			throw new Error('Cookie connection is invalid.')
		}
		const generation = randomUUID()
		const now = new Date().toISOString()
		const stale = channels.some(channel =>
			channel.notificationState === 'unknown')
		await this.db.exec('BEGIN IMMEDIATE')
		try {
			if (await this.cleanupPending()) {
				throw new Error('Previous cookie cleanup must finish first.')
			}
			if (oauthHash) await recordOAuthCleanup(this.db, oauthHash)
			if (combinedProfile) {
				if (combinedProfile !== profile.channelId) {
					throw new Error('Combined account identity does not match.')
				}
				await this.db.run(SQL`INSERT INTO combined_connection
					(id, profileKey) VALUES (1, ${combinedProfile});`)
			}
			await reconcileCookieSnapshot(this.db, {
				profileKey: profile.channelId, complete: true, activateProfile: true,
				suppressNotifications: true, channels,
			}, { externalTransaction: true })
			await this.db.run(SQL`INSERT INTO cookie_connection
				(id, generation, cookieHeader, channelId, pageId, profileName,
					handle, selected, stale, lastSuccessfulAt)
				VALUES (1, ${generation}, ${cookieHeader}, ${profile.channelId},
					${profile.pageId ?? null}, ${profile.name}, ${profile.handle ?? null},
					${profile.selected ? 1 : 0}, ${stale ? 1 : 0}, ${now})
				ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,
					cookieHeader=excluded.cookieHeader, channelId=excluded.channelId,
					pageId=excluded.pageId, profileName=excluded.profileName,
					handle=excluded.handle, selected=excluded.selected,
					stale=excluded.stale,
					lastSuccessfulAt=excluded.lastSuccessfulAt;`)
			await this.db.exec('COMMIT')
		} catch (err) {
			await this.db.exec('ROLLBACK')
			throw err
		}
		return generation
	}

	async read(): Promise<CookieConnection | null> {
		const row = await this.db.get('SELECT * FROM cookie_connection WHERE id=1')
		if (!row) return null
		if (!isChannelId(row.channelId) || typeof row.cookieHeader !== 'string' ||
				row.cookieHeader.length > 256 * 1024 ||
				typeof row.generation !== 'string' || !row.generation ||
				typeof row.profileName !== 'string' ||
				!extractSapisidFromCookie(row.cookieHeader)) {
			throw new Error('Stored cookie connection is invalid.')
		}
		return { generation: row.generation, cookieHeader: row.cookieHeader,
			profile: { channelId: row.channelId, pageId: row.pageId ?? undefined,
				name: row.profileName, handle: row.handle ?? undefined,
				selected: !!row.selected, selectable: true }, stale: !!row.stale,
			lastSuccessfulAt: row.lastSuccessfulAt }
	}

	async markStale(generation: string): Promise<boolean> {
		const result = await this.db.run(SQL`UPDATE cookie_connection SET stale=1
			WHERE id=1 AND generation=${generation};`)
		return !!result.changes
	}

	async refresh(
		generation: string, channels: ChannelBellState[],
	): Promise<boolean> {
		return (await this.applySnapshot(generation, channels)) !== null
	}

	async replaceAndRefresh(generation: string, cookieHeader: string,
		channels: ChannelBellState[]): Promise<string | null> {
		if (typeof cookieHeader !== 'string' || cookieHeader.length > 256 * 1024 ||
				!extractSapisidFromCookie(cookieHeader)) {
			throw new Error('Replacement cookie is invalid.')
		}
		return this.applySnapshot(generation, channels, cookieHeader)
	}

	private async applySnapshot(generation: string, channels: ChannelBellState[],
		replacement?: string): Promise<string | null> {
		if (!Array.isArray(channels) || !channels.length) {
			throw new Error('An empty cookie snapshot cannot be verified.')
		}
		await this.db.exec('BEGIN IMMEDIATE')
		try {
			const row = await this.db.get(SQL`SELECT channelId FROM cookie_connection
				WHERE id=1 AND generation=${generation};`)
			if (!row) { await this.db.exec('ROLLBACK'); return null }
			await reconcileCookieSnapshot(this.db, { profileKey: row.channelId,
				complete: true, channels }, { externalTransaction: true })
			const stale = channels.some(channel =>
				channel.notificationState === 'unknown')
			const nextGeneration = replacement === undefined ? generation :
				randomUUID()
			await this.db.run(SQL`UPDATE cookie_connection SET stale=${stale ? 1 : 0},
				generation=${nextGeneration},
				cookieHeader=COALESCE(${replacement ?? null}, cookieHeader),
				lastSuccessfulAt=CASE WHEN ${stale ? 1 : 0}=0
				THEN ${new Date().toISOString()} ELSE lastSuccessfulAt END
				WHERE id=1 AND generation=${generation};`)
			await this.db.exec('COMMIT')
			return nextGeneration
		} catch (err) {
			await this.db.exec('ROLLBACK')
			throw err
		}
	}

	async status() {
		const row = await this.db.get(`SELECT channelId, profileName, handle, stale,
			lastSuccessfulAt FROM cookie_connection WHERE id=1`)
		return row ? { channelId: row.channelId, name: row.profileName,
			handle: row.handle, stale: !!row.stale,
			lastSuccessfulAt: row.lastSuccessfulAt } : null
	}

	async cleanupPending(): Promise<boolean> {
		return !!await this.db.get('SELECT id FROM cookie_cleanup WHERE id=1')
	}

	async oauthCleanupPending(): Promise<boolean> {
		return !!await this.db.get('SELECT id FROM oauth_cleanup WHERE id=1')
	}
}
