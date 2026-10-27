import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { buildSafeAlert, AlertDeps } from './lib/alertState'
import { MAX_EMAIL_ATTEMPTS } from './incidents'
import messages from './email/messages.en.json'

const DAY_MS = 24 * 60 * 60 * 1000
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000]

/** Schedule reminders only for active incidents and retry bounded failures. */
export class IncidentReminders {
	private unavailable = false
	constructor(private readonly db: sqlite.Database,
		private readonly loadSender: () => Promise<AlertDeps['sendErrorEmail']>,
		private readonly warn: (message: string) => void,
		private readonly clock: () => Date = () => new Date()) {}

	async recoverInterrupted(): Promise<void> {
		const now = this.clock().toISOString()
		await this.db.run(SQL`UPDATE incident_reminders SET
			state=CASE WHEN attemptCount >= ${MAX_EMAIL_ATTEMPTS}
				THEN 'exhausted' ELSE 'failed' END,
			nextAttemptAt=${now} WHERE state='sending';`)
	}

	async run(enabled: boolean): Promise<void> {
		if (!enabled) return
		const now = this.clock()
		const current = now.toISOString()
		const cutoff = new Date(now.getTime() - DAY_MS).toISOString()
		await this.db.run(SQL`INSERT OR IGNORE INTO incident_reminders
			(incidentId, state) SELECT i.id, 'pending' FROM incidents i
			WHERE i.resolvedAt IS NULL AND i.openedAt <= ${cutoff}
			AND NOT EXISTS (SELECT 1 FROM incident_reminders r
				WHERE r.incidentId=i.id)
			ORDER BY i.openedAt, i.id LIMIT 1000;`)
		await this.db.run(SQL`UPDATE incident_reminders SET state='pending'
			WHERE state='waiting' AND nextReminderAt <= ${current};`)
		const rows = await this.db.all(SQL`SELECT r.incidentId, r.attemptCount,
			i.source, i.category, i.channelId FROM incident_reminders r
			JOIN incidents i ON i.id=r.incidentId WHERE i.resolvedAt IS NULL
			AND r.state IN ('pending', 'failed')
			AND (r.nextAttemptAt IS NULL OR r.nextAttemptAt <= ${current})
			ORDER BY i.openedAt, i.id LIMIT 20;`)
		if (!rows.length) return
		let send: AlertDeps['sendErrorEmail']
		try { send = await this.loadSender(); this.unavailable = false } catch {
			if (!this.unavailable) this.safeWarn('Reminder email is unavailable.')
			this.unavailable = true
			return
		}
		for (const row of rows) {
			const claim = await this.db.run(SQL`UPDATE incident_reminders
				SET state='sending', attemptCount=attemptCount+1
				WHERE incidentId=${row.incidentId} AND state IN ('pending', 'failed')
				AND EXISTS (SELECT 1 FROM incidents WHERE id=${row.incidentId}
					AND resolvedAt IS NULL);`)
			if (!claim.changes) continue
			const alert = buildSafeAlert(row.category, row.source,
				row.channelId ?? undefined)
			alert.subject = messages.reminderSubject
			alert.message += ` ${messages.reminderSuffix}`
			let delivered = false
			try { await send(alert); delivered = true } catch {
				this.safeWarn('Reminder delivery failed; retry may be scheduled.')
			}
			const attempt = row.attemptCount + 1
			const state = delivered ? 'waiting' :
				attempt >= MAX_EMAIL_ATTEMPTS ? 'exhausted' : 'failed'
			const nextAttempt = state === 'failed' ? new Date(
				now.getTime() + RETRY_DELAYS_MS[attempt - 1]).toISOString() : null
			const nextReminder = delivered ? new Date(
				now.getTime() + DAY_MS).toISOString() : null
			await this.db.run(SQL`UPDATE incident_reminders SET state=${state},
				attemptCount=${delivered ? 0 : attempt}, nextAttemptAt=${nextAttempt},
				nextReminderAt=${nextReminder}
				WHERE incidentId=${row.incidentId} AND state='sending';`)
		}
	}

	private safeWarn(message: string): void {
		try { this.warn(message) } catch { /* Preserve the incident state. */ }
	}
}
