import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'

const DAY_MS = 24 * 60 * 60 * 1000

export const parseActivityRetentionDays = (value: unknown): number | null => {
	if (value === null) return null
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 ||
			!Number.isFinite(new Date(Date.now() - value * DAY_MS).getTime())) {
		throw new Error('activityRetentionDays must be null or a positive integer.')
	}
	return value
}

/** Keep pending deliveries, active incidents, and unresolved remote actions. */
export const pruneActivity = async (
	db: sqlite.Database, days: number | null, now = new Date(),
): Promise<void> => {
	if (days === null) return
	parseActivityRetentionDays(days)
	const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString()
	await db.exec('BEGIN IMMEDIATE')
	try {
		await db.run(SQL`DELETE FROM cookie_channel_events
			WHERE observedAt < ${cutoff};`)
		await db.run(SQL`DELETE FROM channel_title_events
			WHERE observedAt < ${cutoff}
			AND emailState NOT IN ('pending', 'sending');`)
		await db.run(SQL`DELETE FROM channel_added_events WHERE batchId IN
			(SELECT id FROM channel_added_batches WHERE observedAt < ${cutoff}
			AND emailState NOT IN ('pending', 'sending'));`)
		await db.run(SQL`DELETE FROM channel_added_batches
			WHERE observedAt < ${cutoff}
			AND emailState NOT IN ('pending', 'sending');`)
		await db.run(SQL`DELETE FROM incidents WHERE resolvedAt IS NOT NULL
			AND resolvedAt < ${cutoff}
			AND emailState NOT IN ('pending', 'sending', 'failed')
			AND NOT EXISTS (SELECT 1 FROM incident_recovery_alerts r
				WHERE r.incidentId=incidents.id AND r.state IN
				('pending', 'sending', 'failed'));`)
		await db.run(`DELETE FROM incident_reminders WHERE incidentId NOT IN
			(SELECT id FROM incidents)`)
		await db.run(`DELETE FROM incident_recovery_alerts WHERE incidentId NOT IN
			(SELECT id FROM incidents)`)
		await db.run(SQL`DELETE FROM refresh_runs WHERE status <> 'running'
			AND finishedAt IS NOT NULL AND finishedAt < ${cutoff}
			AND id NOT IN (SELECT id FROM refresh_runs WHERE kind='videos'
				AND status <> 'running' ORDER BY startedAt DESC, id DESC LIMIT 1)
			AND id NOT IN (SELECT id FROM refresh_runs WHERE kind='subscriptions'
				AND status <> 'running' ORDER BY startedAt DESC, id DESC LIMIT 1);`)
		await db.run(SQL`DELETE FROM email_test_runs WHERE outcome <> 'pending'
			AND finishedAt IS NOT NULL
			AND julianday(finishedAt) < julianday(${cutoff});`)
		await db.run(SQL`DELETE FROM cookie_bell_actions
			WHERE finishedAt < ${cutoff}
			AND state IN ('confirmed', 'acknowledged');`)
		await db.run(SQL`DELETE FROM cookie_subscription_actions
			WHERE finishedAt < ${cutoff} AND state IN ('confirmed', 'acknowledged');`)
		await db.exec('COMMIT')
	} catch (err) {
		await db.exec('ROLLBACK')
		throw err
	}
}
