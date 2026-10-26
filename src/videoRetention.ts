import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'

const DAY_MS = 24 * 60 * 60 * 1000

export const parseVideoRetentionDays = (value: unknown): number | null => {
	if (value === null) return null
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 ||
			!Number.isFinite(new Date(Date.now() - value * DAY_MS).getTime())) {
		throw new Error('videoRetentionDays must be null or a positive day count.')
	}
	return value
}

export const pruneVideoObservations = async (
	db: sqlite.Database, days: number | null, now = new Date(),
): Promise<void> => {
	if (days === null) return
	parseVideoRetentionDays(days)
	const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString()
	await db.run(SQL`DELETE FROM video_observations
		WHERE observedAt < ${cutoff} AND emailOutcome <> 'pending';`)
}
