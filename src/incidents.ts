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

/** Persist allowlisted context without exception text. */
export class IncidentStore {
	constructor(private readonly db: sqlite.Database) {}

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
		const now = new Date().toISOString()
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
					WHEN incidents.emailState='sent' THEN 'sent'
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
		source: IncidentSource, categories: ErrorCategory[],
	): Promise<void> {
		if (!SOURCES.includes(source) ||
				categories.some(c => !CATEGORIES.includes(c))) {
			throw new Error('Invalid incident source or category.')
		}
		const now = new Date().toISOString()
		for (const category of categories) {
			await this.db.run(SQL`UPDATE incidents SET resolvedAt=${now}
				WHERE source=${source} AND category=${category}
				AND resolvedAt IS NULL;`)
		}
	}
}
