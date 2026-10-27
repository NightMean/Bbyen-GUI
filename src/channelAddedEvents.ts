import { randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { assertChannelId } from './lib/channelId'

/** Call inside the same transaction as channel reconciliation. */
export class ChannelAddedBatch {
	private readonly id = randomUUID()
	private readonly now = new Date().toISOString()
	constructor(private readonly db: sqlite.Database) {}

	async record(channelId: string): Promise<void> {
		assertChannelId(channelId)
		await this.db.run(SQL`INSERT OR IGNORE INTO channel_added_batches
			(id, observedAt, emailState)
			VALUES (${this.id}, ${this.now}, 'pending');`)
		await this.db.run(SQL`INSERT OR IGNORE INTO channel_added_events
			(batchId, channelId, observedAt)
			VALUES (${this.id}, ${channelId}, ${this.now});`)
	}
}
