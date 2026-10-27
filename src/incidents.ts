import { randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { isChannelId } from './lib/channelId'
import { ErrorCategory } from './lib/classifyError'

export type IncidentSource =
	'videos' | 'subscriptions' | 'service-auth' | 'cookie' | 'smtp' | 'service'

export interface Incident {
	id: string,
	source: IncidentSource,
	category: ErrorCategory,
	channelId: string | null,
	openedAt: string,
	lastObservedAt: string,
	resolvedAt: string | null,
	occurrences: number,
	emailState: 'pending' | 'sending' | 'sent' | 'failed' | 'disabled' |
		'exhausted',
	attemptCount: number,
	nextAttemptAt: string | null,
}

const SOURCES: IncidentSource[] = [
	'videos', 'subscriptions', 'service-auth', 'cookie', 'smtp', 'service',
]
const CATEGORIES: ErrorCategory[] = ['auth', 'quota', 'other']
export const MAX_EMAIL_ATTEMPTS = 5
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000]

/** Persist allowlisted context without exception text. */
export class IncidentStore {
	constructor(
		private readonly db: sqlite.Database,
		private readonly clock: () => Date = () => new Date(),
	) {}

	async record(input: {
		source: IncidentSource,
		category: ErrorCategory,
		channelId?: string,
		emailEnabled: boolean,
	}): Promise<Incident> {
		if (!SOURCES.includes(input.source) ||
				!CATEGORIES.includes(input.category)) {
			throw new Error('Invalid incident source or category.')
		}
		if (input.channelId !== undefined && (typeof input.channelId !== 'string' ||
				!isChannelId(input.channelId))) {
			throw new Error('Incident channel ID must be a canonical YouTube ID.')
		}
		if (typeof input.emailEnabled !== 'boolean') {
			throw new Error('Incident emailEnabled must be a boolean.')
		}
		const id = randomUUID()
		const now = this.clock().toISOString()
		const channelId = input.channelId ?? null
		const state = input.emailEnabled ? 'pending' : 'disabled'
		await this.db.run(SQL`INSERT INTO incidents
			(id, source, category, channelId, openedAt, lastObservedAt,
				occurrences, emailState)
			VALUES (${id}, ${input.source}, ${input.category}, ${channelId},
				${now}, ${now}, 1, ${state})
			ON CONFLICT DO UPDATE SET lastObservedAt=excluded.lastObservedAt,
				occurrences=incidents.occurrences+1,
				emailState=CASE
					WHEN incidents.emailState IN ('sent', 'exhausted')
						THEN incidents.emailState
					WHEN excluded.emailState='disabled' THEN 'disabled'
					WHEN incidents.emailState='disabled' THEN 'pending'
					ELSE incidents.emailState END;`)
		const saved: Incident | undefined = await this.db.get(SQL`
			SELECT * FROM incidents WHERE source=${input.source}
			AND category=${input.category} AND channelId IS ${channelId}
			AND resolvedAt IS NULL;`)
		if (!saved) throw new Error('Incident was resolved while being recorded.')
		return saved
	}

	async resolve(
		source: IncidentSource, categories: ErrorCategory[], channelId?: string,
		recoveryEnabled = false,
	): Promise<void> {
		if (!SOURCES.includes(source) ||
				categories.some(c => !CATEGORIES.includes(c))) {
			throw new Error('Invalid incident source or category.')
		}
		if (channelId !== undefined && !isChannelId(channelId)) {
			throw new Error('Incident channel ID must be a canonical YouTube ID.')
		}
		const now = this.clock().toISOString()
		await this.db.exec('BEGIN IMMEDIATE')
		try {
			for (const category of categories) {
				if (recoveryEnabled) {
					if (channelId) {
						await this.db.run(SQL`INSERT OR IGNORE INTO incident_recovery_alerts
							(incidentId, state) SELECT id, 'pending' FROM incidents
							WHERE source=${source} AND category=${category}
							AND channelId=${channelId} AND resolvedAt IS NULL;`)
					} else {
						await this.db.run(SQL`INSERT OR IGNORE INTO incident_recovery_alerts
							(incidentId, state) SELECT id, 'pending' FROM incidents
							WHERE source=${source} AND category=${category}
							AND resolvedAt IS NULL;`)
					}
				}
				if (channelId) {
					await this.db.run(SQL`UPDATE incidents SET resolvedAt=${now}
						WHERE source=${source} AND category=${category}
						AND channelId=${channelId} AND resolvedAt IS NULL;`)
				} else {
					await this.db.run(SQL`UPDATE incidents SET resolvedAt=${now}
						WHERE source=${source} AND category=${category}
						AND resolvedAt IS NULL;`)
				}
			}
			await this.db.exec('COMMIT')
		} catch (err) {
			await this.db.exec('ROLLBACK')
			throw err
		}
	}

	async claim(id: string): Promise<Incident | undefined> {
		const now = this.clock().toISOString()
		const updated = await this.db.run(SQL`UPDATE incidents SET
			emailState='sending', attemptCount=attemptCount+1
			WHERE id=${id} AND emailState IN ('pending', 'failed')
			AND attemptCount < ${MAX_EMAIL_ATTEMPTS}
			AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${now});`)
		if (!updated.changes) return undefined
		return this.db.get(SQL`SELECT * FROM incidents WHERE id=${id};`)
	}

	async complete(
		id: string, delivered: boolean, attempts: number,
	): Promise<void> {
		const exhausted = attempts >= MAX_EMAIL_ATTEMPTS
		const state = delivered ? 'sent' : exhausted ? 'exhausted' : 'failed'
		const next = delivered || exhausted ? null : new Date(
			this.clock().getTime() + RETRY_DELAYS_MS[attempts - 1],
		).toISOString()
		await this.db.run(SQL`UPDATE incidents SET emailState=${state},
			nextAttemptAt=${next} WHERE id=${id} AND emailState='sending';`)
	}

	async due(): Promise<Incident[]> {
		const now = this.clock().toISOString()
		return this.db.all(SQL`SELECT * FROM incidents
			WHERE emailState IN ('pending', 'failed')
			AND attemptCount < ${MAX_EMAIL_ATTEMPTS}
			AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${now})
			ORDER BY openedAt, id LIMIT 20;`)
	}

	async recoverSending(): Promise<void> {
		const now = this.clock().toISOString()
		await this.db.run(SQL`UPDATE incidents SET
			emailState=CASE WHEN attemptCount >= ${MAX_EMAIL_ATTEMPTS}
				THEN 'exhausted' ELSE 'failed' END,
			nextAttemptAt=CASE WHEN attemptCount >= ${MAX_EMAIL_ATTEMPTS}
				THEN NULL ELSE ${now} END WHERE emailState='sending';`)
	}
}
