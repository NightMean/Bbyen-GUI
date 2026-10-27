import * as sqlite from 'sqlite'
import { ErrorCategory } from './lib/classifyError'
import { isChannelId } from './lib/channelId'
import {
	AlertDeps, buildSafeAlert, clearErrorState, notifyError,
} from './lib/alertState'
import {
	Incident, IncidentSource, IncidentStore, MAX_EMAIL_ATTEMPTS,
} from './incidents'

const SOURCES: IncidentSource[] = [
	'videos', 'subscriptions', 'service-auth', 'cookie', 'smtp', 'service',
]

/** Records incidents and delivers bounded, retryable alert emails. */
export class IncidentReporter {
	private readonly store: IncidentStore

	constructor(
		db: sqlite.Database,
		private readonly logger: { warn: (message: string) => void },
		clock: () => Date = () => new Date(),
	) {
		this.store = new IncidentStore(db, clock)
	}

	private async send(
		incident: Incident,
		sendEmail: AlertDeps['sendErrorEmail'],
	): Promise<void> {
		try {
			const claimed = await this.store.claim(incident.id)
			if (!claimed) return
			const alert = buildSafeAlert(
				claimed.category, claimed.source, claimed.channelId ?? undefined)
			if (claimed.resolvedAt) {
				alert.message += ' This issue has since recovered.'
			}
			let delivered = false
			try {
				await sendEmail(alert)
				delivered = true
			} catch {
				this.logger.warn(claimed.attemptCount >= MAX_EMAIL_ATTEMPTS
					? 'Incident alert delivery failed; retry limit reached.'
					: 'Incident alert delivery failed; retry is scheduled.')
			}
			await this.store.complete(claimed.id, delivered, claimed.attemptCount)
		} catch {
			this.logger.warn('Could not update incident alert delivery state.')
		}
	}

	async notify(
		category: ErrorCategory, err: unknown, deps: AlertDeps,
	): Promise<void> {
		const source = SOURCES.includes(deps.source as IncidentSource)
			? deps.source as IncidentSource : 'service'
		const channelId = deps.channelId && isChannelId(deps.channelId)
			? deps.channelId : undefined
		try {
			const incident = await this.store.record({ source, category, channelId,
				emailEnabled: deps.emailOnError })
			deps.logger.error(buildSafeAlert(category, source, channelId).message)
			if (deps.emailOnError) await this.send(incident, deps.sendErrorEmail)
		} catch {
			this.logger.warn('Could not record an incident; using fallback alerts.')
			await notifyError(category, err, deps)
		}
	}

	async clear(
		categories: ErrorCategory[], source: IncidentSource,
	): Promise<void> {
		try {
			await this.store.resolve(source, categories)
		} catch {
			this.logger.warn('Could not mark incidents as recovered.')
		}
		clearErrorState(categories, source)
	}

	async retryPending(
		sendEmail: AlertDeps['sendErrorEmail'], emailEnabled: boolean,
	): Promise<void> {
		if (!emailEnabled) return
		try {
			for (const incident of await this.store.due()) {
				await this.send(incident, sendEmail)
			}
		} catch {
			this.logger.warn('Could not inspect pending incident alerts.')
		}
	}

	async recoverInterrupted(): Promise<void> {
		try {
			await this.store.recoverSending()
		} catch {
			this.logger.warn('Could not recover interrupted incident alerts.')
		}
	}
}
