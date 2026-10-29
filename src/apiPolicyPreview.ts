import { createHash, randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import { Config } from './config'
import { EmailSelectionPolicy, makeEmailEligibility } from './emailPolicy'
import { isChannelId } from './lib/channelId'

const fingerprint = (value: unknown) => createHash('sha256')
	.update(JSON.stringify(value)).digest('hex')

export class PolicyPreviewError extends Error {}

/** Review effective email changes without changing channel membership. */
export class ApiPolicyPreview {
	private preview?: { id: string, target: EmailSelectionPolicy,
		fingerprint: string, expiresAt: number }
	constructor(private readonly db: sqlite.Database,
		private readonly config: Config,
		private readonly clock: () => number = Date.now) {}

	private async snapshot(target: EmailSelectionPolicy) {
		if (this.config.mode !== 'youtube' ||
				!['allowlist', 'blocklist'].includes(target)) {
			throw new Error('API email policy is unavailable.')
		}
		const rows = await this.db.all(`SELECT s.channelId,
			substr(s.channelTitle, 1, 200) AS title,
			COALESCE(c.manual, 0) AS manual,
			COALESCE(c.apiSubscribed, 0) AS apiSubscribed
			FROM subscriptions s LEFT JOIN channel_sources c
			ON c.channelId=s.channelId
			WHERE s.deleted=0 ORDER BY s.channelId LIMIT 10001`)
		if (rows.length > 10_000 || rows.some(row =>
			typeof row.channelId !== 'string' || !isChannelId(row.channelId))) {
			throw new Error('Tracked channels are invalid.')
		}
		const manualOnly = new Set<string>(rows.filter(row =>
			row.manual && !row.apiSubscribed).map(row => row.channelId))
		const before = makeEmailEligibility(this.config, manualOnly)
		const after = makeEmailEligibility({ ...this.config,
			emailSelectionPolicy: target }, manualOnly)
		const changes = rows.map(row => {
			const entry = this.config.channelSettingsById?.get(row.channelId)
			return { channelId: row.channelId, title: row.title,
				before: before(row.channelId, entry),
				after: after(row.channelId, entry) }
		}).filter(row => row.before !== row.after)
		return { current: this.config.emailSelectionPolicy ?? null,
			target, changes }
	}

	async review(target: EmailSelectionPolicy) {
		const snapshot = await this.snapshot(target)
		const id = randomUUID()
		this.preview = { id, target, fingerprint: fingerprint(snapshot),
			expiresAt: this.clock() + 10 * 60_000 }
		return { previewId: id, ...snapshot }
	}

	async confirm(id: unknown, target: EmailSelectionPolicy): Promise<void> {
		const preview = this.preview
		this.preview = undefined
		if (!preview || id !== preview.id || target !== preview.target ||
				this.clock() >= preview.expiresAt ||
				fingerprint(await this.snapshot(target)) !== preview.fingerprint) {
			throw new PolicyPreviewError('Policy review expired or changed.')
		}
	}
}
