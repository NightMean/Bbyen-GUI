import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'

export interface AddedChannel {
	channelId: string,
	title: string,
}

/** Deliver a reconciliation batch once, preserving uncertain outcomes. */
export class ChannelAddedAlerts {
	private unavailable = false
	constructor(private readonly db: sqlite.Database,
		private readonly loadSender: () => Promise<(channels: AddedChannel[]) =>
			Promise<unknown>>,
		private readonly warn: (message: string) => void) {}

	async recoverInterrupted(): Promise<void> {
		await this.db.run(`UPDATE channel_added_batches SET emailState='uncertain'
			WHERE emailState='sending'`)
	}

	async run(enabled: boolean): Promise<void> {
		if (!enabled) {
			await this.db.run(`UPDATE channel_added_batches
				SET emailState='suppressed'
				WHERE emailState='pending'`)
			return
		}
		const batches = await this.db.all(`SELECT id FROM channel_added_batches
			WHERE emailState='pending' ORDER BY observedAt, id LIMIT 20`)
		if (!batches.length) return
		let send: (channels: AddedChannel[]) => Promise<unknown>
		try { send = await this.loadSender(); this.unavailable = false } catch {
			if (!this.unavailable) this.safeWarn('Channel alert email unavailable.')
			this.unavailable = true
			return
		}
		for (const batch of batches) {
			const channels = await this.db.all(SQL`SELECT e.channelId,
				COALESCE(s.channelTitle, e.channelId) AS title
				FROM channel_added_events e LEFT JOIN subscriptions s
				ON s.channelId=e.channelId WHERE e.batchId=${batch.id}
				ORDER BY e.channelId LIMIT 10001;`)
			if (!channels.length || channels.length > 10000) {
				await this.db.run(SQL`UPDATE channel_added_batches
					SET emailState='uncertain' WHERE id=${batch.id}
					AND emailState='pending';`)
				this.safeWarn('Channel alert batch is invalid or too large.')
				continue
			}
			const claim = await this.db.run(SQL`UPDATE channel_added_batches
				SET emailState='sending' WHERE id=${batch.id}
				AND emailState='pending';`)
			if (!claim.changes) continue
			let state = 'uncertain'
			try { await send(channels); state = 'sent' } catch {
				this.safeWarn('Channel alert delivery could not be confirmed.')
			}
			await this.db.run(SQL`UPDATE channel_added_batches SET emailState=${state}
				WHERE id=${batch.id} AND emailState='sending';`)
		}
	}

	private safeWarn(message: string): void {
		try { this.warn(message) } catch { /* Preserve the delivery outcome. */ }
	}
}
