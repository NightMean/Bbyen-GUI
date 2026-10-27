import { randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { reconcileCookieSnapshot } from './cookieReconciliation'
import { isChannelId } from './lib/channelId'
import {
	extractSapisidFromCookie, ChannelBellState,
} from './lib/innertubeChannels'
import { ResolvedCookieProfile } from './lib/cookieProfiles'

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
		channels: ChannelBellState[]): Promise<string> {
		if (typeof cookieHeader !== 'string' || cookieHeader.length > 256 * 1024 ||
				!extractSapisidFromCookie(cookieHeader) || !profile.selectable ||
				!profile.channelId || !isChannelId(profile.channelId) ||
				typeof profile.name !== 'string' || profile.name.length > 200 ||
				(profile.pageId !== undefined && (typeof profile.pageId !== 'string' ||
				!profile.pageId || profile.pageId.length > 256))) {
			throw new Error('Cookie connection is invalid.')
		}
		const generation = randomUUID()
		const now = new Date().toISOString()
		await this.db.exec('BEGIN IMMEDIATE')
		try {
			await reconcileCookieSnapshot(this.db, {
				profileKey: profile.channelId, complete: true, activateProfile: true,
				suppressNotifications: true, channels,
			}, { externalTransaction: true })
			await this.db.run(SQL`INSERT INTO cookie_connection
				(id, generation, cookieHeader, channelId, pageId, profileName,
					handle, selected, stale, lastSuccessfulAt)
				VALUES (1, ${generation}, ${cookieHeader}, ${profile.channelId},
					${profile.pageId ?? null}, ${profile.name}, ${profile.handle ?? null},
					${profile.selected ? 1 : 0}, 0, ${now})
				ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,
					cookieHeader=excluded.cookieHeader, channelId=excluded.channelId,
					pageId=excluded.pageId, profileName=excluded.profileName,
					handle=excluded.handle, selected=excluded.selected, stale=0,
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

	async markStale(generation: string): Promise<void> {
		await this.db.run(SQL`UPDATE cookie_connection SET stale=1
			WHERE id=1 AND generation=${generation};`)
	}

	async status() {
		const row = await this.db.get(`SELECT channelId, profileName, handle, stale,
			lastSuccessfulAt FROM cookie_connection WHERE id=1`)
		return row ? { channelId: row.channelId, name: row.profileName,
			handle: row.handle, stale: !!row.stale,
			lastSuccessfulAt: row.lastSuccessfulAt } : null
	}
}
