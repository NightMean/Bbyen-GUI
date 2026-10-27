import { randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { classifyError } from './lib/classifyError'
import { serializeJobs } from './lib/serializeJobs'
import { isChannelId } from './lib/channelId'
import { RefreshResult } from './refreshResult'

export type RefreshKind = 'videos' | 'subscriptions'
type LiveState = 'idle' | 'queued' | 'running'
const MAX_FAILED_CHANNELS = 1000

const sanitizeResult = (value: unknown): RefreshResult => {
	const data = value && typeof value === 'object'
		? value as Partial<RefreshResult> : {}
	const count = (v: unknown) =>
		typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0
	const ids = Array.isArray(data.failedChannels) ? data.failedChannels : []
	const safeIds = ids.filter((id): id is string =>
		typeof id === 'string' && isChannelId(id))
	const status = data.status === 'success' || data.status === 'partial'
		? data.status : 'failed'
	const category = data.errorCategory === 'auth' ||
		data.errorCategory === 'quota' || data.errorCategory === 'other'
		? data.errorCategory : undefined
	return { status, total: data.total === null ? null : count(data.total),
		succeeded: count(data.succeeded), failed: count(data.failed),
		skipped: count(data.skipped),
		failedChannels: safeIds.slice(0, MAX_FAILED_CHANNELS),
		...(safeIds.length !== ids.length || safeIds.length > MAX_FAILED_CHANNELS ||
			data.failedChannelsTruncated === true
			? { failedChannelsTruncated: true } : {}),
		...(category ? { errorCategory: category } : {}),
		...(typeof data.apiChecked === 'boolean'
			? { apiChecked: data.apiChecked } : {}) }
}

export class RefreshCoordinator {
	private readonly jobs = serializeJobs()
	private readonly pending = new Map<RefreshKind, Promise<RefreshResult>>()
	private readonly live = new Map<RefreshKind, LiveState>()

	constructor(
		private readonly db: sqlite.Database,
		private readonly logger: { warn: (message: string) => void },
	) {}

	private warn(message: string): void {
		try { this.logger.warn(message) } catch {
			// A broken diagnostics backend must not stop the refresh.
		}
	}

	private async record(operation: () => Promise<unknown>): Promise<void> {
		try {
			await operation()
		} catch {
			// Diagnostic storage must never mask or stop the original work.
			this.warn('Could not record refresh history.')
		}
	}

	async recoverInterrupted(): Promise<void> {
		const now = new Date().toISOString()
		await this.record(() => this.db.run(SQL`UPDATE refresh_runs
			SET status='interrupted', finishedAt=${now} WHERE status='running';`))
	}

	maintenance<T>(key: string, work: () => Promise<T>): Promise<T> {
		return this.jobs.run(`maintenance:${key}`, work)
	}

	run(
		kind: RefreshKind, work: () => Promise<RefreshResult>,
	): Promise<RefreshResult> {
		const existing = this.pending.get(kind)
		if (existing) return existing
		this.live.set(kind, 'queued')
		const promise = this.jobs.run(kind, async () => {
			this.live.set(kind, 'running')
			const id = randomUUID()
			const startedAt = new Date().toISOString()
			await this.record(() => this.db.run(SQL`INSERT INTO refresh_runs
				(id, kind, status, startedAt)
				VALUES (${id}, ${kind}, 'running', ${startedAt});`))
			let result: RefreshResult
			try {
				result = await work()
			} catch (err) {
				this.warn('A refresh stopped unexpectedly.')
				result = { status: 'failed', total: null, succeeded: 0, failed: 0,
					skipped: 0, failedChannels: [], errorCategory: classifyError(err) }
			}
			result = sanitizeResult(result)
			const finishedAt = new Date().toISOString()
			await this.record(() => {
				const resultJson = JSON.stringify(result)
				return this.db.run(SQL`UPDATE refresh_runs
					SET status='completed', finishedAt=${finishedAt},
						resultJson=${resultJson} WHERE id=${id};`)
			})
			return result
		})
		this.pending.set(kind, promise)
		const clear = () => { this.pending.delete(kind); this.live.delete(kind) }
		void promise.then(clear, clear)
		return promise
	}

	async status(kind: RefreshKind): Promise<{
		state: LiveState,
		lastSuccessfulAt: string | null,
		lastRun: { status: string; startedAt: string; finishedAt: string | null;
			result: RefreshResult | null } | null,
	}> {
		const row = await this.db.get(SQL`SELECT status, startedAt, finishedAt,
			resultJson FROM refresh_runs WHERE kind=${kind}
			ORDER BY startedAt DESC, rowid DESC LIMIT 1;`)
		const lastSuccess = await this.db.get(SQL`SELECT finishedAt
			FROM refresh_runs
			WHERE kind=${kind} AND status='completed' AND json_valid(resultJson)
				AND json_extract(resultJson, '$.status')='success'
			ORDER BY startedAt DESC, rowid DESC LIMIT 1;`)
		let result: RefreshResult | null = null
		if (row?.resultJson) {
			try { result = sanitizeResult(JSON.parse(row.resultJson)) } catch {
				this.warn('Stored refresh result is unreadable.')
			}
		}
		return { state: this.live.get(kind) ?? 'idle',
			lastSuccessfulAt: lastSuccess?.finishedAt ?? null,
			lastRun: row ? { status: row.status, startedAt: row.startedAt,
				finishedAt: row.finishedAt, result } : null }
	}
}
