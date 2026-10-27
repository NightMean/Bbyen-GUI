import { RefreshCoordinator, RefreshKind } from './refreshCoordinator'
import { RefreshResult } from './refreshResult'
import { QuotaBackoff } from './quotaBackoff'

interface QuotaRunnerOptions {
	coordinator: RefreshCoordinator,
	backoff: QuotaBackoff,
	enabled: boolean,
	alertsEnabled: () => boolean,
	work: Record<RefreshKind, () => Promise<RefreshResult>>,
	rssFallback?: () => Promise<RefreshResult>,
	reportQuota: () => Promise<boolean>,
	clearQuota: () => Promise<void>,
	warn: (message: string) => void,
}

/** Gate API jobs and schedule persisted retries without overlap. */
export class QuotaRunner {
	constructor(private readonly options: QuotaRunnerOptions) {}

	private async fallback(): Promise<RefreshResult> {
		const result = await this.options.rssFallback!()
		return { ...result, status: result.status === 'success' ? 'partial' :
			result.status, degradedReason: 'quota',
		errorCategory: result.errorCategory ?? 'quota', apiChecked: false }
	}

	async run(kind: RefreshKind): Promise<RefreshResult | undefined> {
		const { coordinator, backoff } = this.options
		const due = await coordinator.maintenance(`quota-gate:${kind}`, async () =>
			!this.options.enabled || await backoff.isDue(kind))
		if (!due) {
			if (kind !== 'videos' || !this.options.rssFallback) return undefined
			return coordinator.run(kind, async () => {
				try { return await this.fallback() } catch {
					return { status: 'failed', total: null, succeeded: 0, failed: 0,
						skipped: 0, failedChannels: [], errorCategory: 'quota',
						degradedReason: 'quota' }
				}
			})
		}
		return coordinator.run(kind, async () => {
			const result = await this.options.work[kind]()
			if (this.options.enabled) {
				try {
					const update = await backoff.record(kind, result)
					if (update.notify) {
						const recorded = await this.options.reportQuota()
						if (recorded && this.options.alertsEnabled()) {
							await backoff.markAlerted(kind)
						}
					}
					if (update.fullyRecovered) await this.options.clearQuota()
				} catch {
					try {
						this.options.warn('Could not update API quota retry state.')
					} catch {
						// Diagnostics must not replace the original refresh outcome.
					}
				}
			}
			if (kind === 'videos' && result.errorCategory === 'quota' &&
					this.options.rssFallback) {
				try { return await this.fallback() } catch {
					// Preserve the quota failure if independent RSS recovery fails.
					return { ...result, degradedReason: 'quota' }
				}
			}
			return result
		})
	}

	async tick(): Promise<void> {
		if (!this.options.enabled) return
		const kinds = await this.options.coordinator.maintenance('quota-due', () =>
			this.options.backoff.dueKinds())
		await Promise.all(kinds.map(kind => this.run(kind)))
	}
}
