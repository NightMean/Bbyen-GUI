import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import type { RefreshKind } from './refreshCoordinator'
import { RefreshResult } from './refreshResult'

const DELAYS_MS = [30, 60, 120, 240, 240].map(minutes => minutes * 60_000)

export const initQuotaSchema = async (db: sqlite.Database): Promise<void> => {
	await db.exec(`CREATE TABLE IF NOT EXISTS quota_backoff (
		kind TEXT PRIMARY KEY CHECK (kind IN ('videos', 'subscriptions')),
		failures INTEGER NOT NULL CHECK (failures BETWEEN 1 AND 5),
		nextRetryAt TEXT NOT NULL,
		alerted INTEGER NOT NULL CHECK (alerted IN (0, 1))
	);`)
}

interface QuotaState {
	failures: number,
	nextRetryAt: string,
	alerted: number,
}

export class QuotaBackoff {
	constructor(
		private readonly db: sqlite.Database,
		private readonly clock: () => Date = () => new Date(),
	) {}

	private get(kind: RefreshKind): Promise<QuotaState | undefined> {
		return this.db.get(SQL`SELECT failures, nextRetryAt, alerted
			FROM quota_backoff WHERE kind=${kind};`)
	}

	async isDue(kind: RefreshKind): Promise<boolean> {
		const state = await this.get(kind)
		return !state || state.nextRetryAt <= this.clock().toISOString()
	}

	async dueKinds(): Promise<RefreshKind[]> {
		const now = this.clock().toISOString()
		const rows: { kind: RefreshKind }[] = await this.db.all(SQL`
			SELECT kind FROM quota_backoff WHERE nextRetryAt <= ${now};`)
		return rows.map(row => row.kind)
	}

	async record(kind: RefreshKind, result: RefreshResult): Promise<{
		notify: boolean, fullyRecovered: boolean,
	}> {
		const prior = await this.get(kind)
		if (result.status === 'success' && result.apiChecked === true) {
			await this.db.run(SQL`DELETE FROM quota_backoff WHERE kind=${kind};`)
			const remaining = await this.db.get(
				'SELECT COUNT(*) AS count FROM quota_backoff')
			return { notify: false, fullyRecovered: !!prior && remaining.count === 0 }
		}
		if (result.errorCategory !== 'quota' && !prior) {
			return { notify: false, fullyRecovered: false }
		}
		const failures = result.errorCategory === 'quota'
			? Math.min((prior?.failures ?? 0) + 1, DELAYS_MS.length)
			: prior!.failures
		const next = new Date(this.clock().getTime() + DELAYS_MS[failures - 1])
			.toISOString()
		const alerted = prior?.alerted ?? 0
		await this.db.run(SQL`INSERT INTO quota_backoff
			(kind, failures, nextRetryAt, alerted)
			VALUES (${kind}, ${failures}, ${next}, ${alerted})
			ON CONFLICT(kind) DO UPDATE SET failures=excluded.failures,
				nextRetryAt=excluded.nextRetryAt, alerted=excluded.alerted;`)
		return { notify: result.errorCategory === 'quota' &&
			failures >= DELAYS_MS.length && !alerted, fullyRecovered: false }
	}

	async markAlerted(kind: RefreshKind): Promise<void> {
		await this.db.run(SQL`UPDATE quota_backoff SET alerted=1
			WHERE kind=${kind};`)
	}
}
