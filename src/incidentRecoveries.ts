import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { AlertDeps, buildRecoveryAlert } from './lib/alertState'
import { MAX_EMAIL_ATTEMPTS } from './incidents'

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000]

/** Deliver recovery notifications once, with bounded retries after failure. */
export class IncidentRecoveries {
	private unavailable = false
	constructor(private readonly db: sqlite.Database,
		private readonly loadSender: () => Promise<AlertDeps['sendErrorEmail']>,
		private readonly warn: (message: string) => void,
		private readonly clock: () => Date = () => new Date()) {}

	async recoverInterrupted(): Promise<void> {
		const now = this.clock().toISOString()
		await this.db.run(SQL`UPDATE incident_recovery_alerts SET
			state=CASE WHEN attemptCount >= ${MAX_EMAIL_ATTEMPTS}
				THEN 'exhausted' ELSE 'failed' END,
			nextAttemptAt=${now} WHERE state='sending';`)
	}

	async run(enabled: boolean): Promise<void> {
		if (!enabled) {
			await this.db.run(`UPDATE incident_recovery_alerts SET state='suppressed'
				WHERE state IN ('pending', 'failed')`)
			return
		}
		const now = this.clock()
		const current = now.toISOString()
		// A later recurrence would make an old recovery email misleading.
		await this.db.run(`UPDATE incident_recovery_alerts SET state='suppressed'
			WHERE state IN ('pending', 'failed') AND EXISTS (
				SELECT 1 FROM incidents old JOIN incidents active
				ON active.source=old.source AND active.category=old.category
				AND active.channelId IS old.channelId AND active.resolvedAt IS NULL
				WHERE old.id=incident_recovery_alerts.incidentId)`)
		const rows = await this.db.all(SQL`SELECT r.incidentId, r.attemptCount,
			i.source, i.channelId FROM incident_recovery_alerts r
			JOIN incidents i ON i.id=r.incidentId WHERE i.resolvedAt IS NOT NULL
			AND r.state IN ('pending', 'failed')
			AND (r.nextAttemptAt IS NULL OR r.nextAttemptAt <= ${current})
			ORDER BY i.resolvedAt, i.id LIMIT 20;`)
		if (!rows.length) return
		let send: AlertDeps['sendErrorEmail']
		try { send = await this.loadSender(); this.unavailable = false } catch {
			if (!this.unavailable) this.safeWarn('Recovery email is unavailable.')
			this.unavailable = true
			return
		}
		for (const row of rows) {
			const claim = await this.db.run(SQL`UPDATE incident_recovery_alerts
				SET state='sending', attemptCount=attemptCount+1
				WHERE incidentId=${row.incidentId} AND state IN ('pending', 'failed');`)
			if (!claim.changes) continue
			let delivered = false
			try { await send(buildRecoveryAlert(row.source,
				row.channelId ?? undefined)); delivered = true } catch {
				this.safeWarn('Recovery email failed; retry may be scheduled.')
			}
			const attempt = row.attemptCount + 1
			const state = delivered ? 'sent' :
				attempt >= MAX_EMAIL_ATTEMPTS ? 'exhausted' : 'failed'
			const next = state === 'failed' ? new Date(
				now.getTime() + RETRY_DELAYS_MS[attempt - 1]).toISOString() : null
			await this.db.run(SQL`UPDATE incident_recovery_alerts SET state=${state},
				nextAttemptAt=${next}
				WHERE incidentId=${row.incidentId} AND state='sending';`)
		}
	}

	private safeWarn(message: string): void {
		try { this.warn(message) } catch { /* Preserve the incident state. */ }
	}
}
