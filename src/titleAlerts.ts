import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'

export interface TitleAlert {
	channelId: string,
	previousTitle: string,
	currentTitle: string,
	cookieStale?: boolean,
}

/** Claim before SMTP and never replay a delivery with an uncertain outcome. */
export class TitleAlerts {
	private unavailable = false
	constructor(private readonly db: sqlite.Database,
		private readonly loadSender: () => Promise<(alert: TitleAlert) =>
			Promise<unknown>>,
		private readonly warn: (message: string) => void) {}

	async recoverInterrupted(): Promise<void> {
		await this.db.run(`UPDATE channel_title_events SET emailState='uncertain'
			WHERE emailState='sending'`)
	}

	async run(enabled: boolean): Promise<void> {
		if (!enabled) {
			await this.db.run(`UPDATE channel_title_events SET emailState='suppressed'
				WHERE emailState='pending'`)
			return
		}
		const rows = await this.db.all(`SELECT id, channelId, previousTitle,
			currentTitle FROM channel_title_events WHERE emailState='pending'
			ORDER BY id LIMIT 20`)
		if (!rows.length) return
		let send: (alert: TitleAlert) => Promise<unknown>
		try { send = await this.loadSender(); this.unavailable = false } catch {
			if (!this.unavailable) this.safeWarn('Title alert email is unavailable.')
			this.unavailable = true
			return
		}
		for (const row of rows) {
			const claim = await this.db.run(SQL`UPDATE channel_title_events
				SET emailState='sending' WHERE id=${row.id} AND emailState='pending';`)
			if (!claim.changes) continue
			let state = 'uncertain'
			try {
				await send({ channelId: row.channelId, previousTitle: row.previousTitle,
					currentTitle: row.currentTitle })
				state = 'sent'
			} catch { this.safeWarn('Title alert delivery could not be confirmed.') }
			await this.db.run(SQL`UPDATE channel_title_events SET emailState=${state}
				WHERE id=${row.id} AND emailState='sending';`)
		}
	}

	private safeWarn(message: string): void {
		try { this.warn(message) } catch { /* Preserve the delivery outcome. */ }
	}
}
