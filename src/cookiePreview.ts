import { createHash, randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import { ChannelBellState } from './lib/innertubeChannels'
import {
	discoverCookieProfiles, ResolvedCookieProfile,
} from './lib/cookieProfiles'
import { fetchCookieChannels } from './lib/cookieDiscovery'
import { isChannelId } from './lib/channelId'

interface Candidate {
	cookieHeader: string,
	profiles: Map<string, ResolvedCookieProfile>,
	expiresAt: number,
	timer: NodeJS.Timeout,
	preview?: { id: string, profileId: string, fingerprint: string },
}

interface PreviewDependencies {
	discover: typeof discoverCookieProfiles,
	fetch: typeof fetchCookieChannels,
}

const MAX_CANDIDATES = 3
const CANDIDATE_LIFETIME_MS = 10 * 60_000

/** Keep temporary cookie candidates in memory only and expire them promptly. */
export class CookiePreviewService {
	private readonly candidates = new Map<string, Candidate>()
	constructor(private readonly db: sqlite.Database,
		private readonly deps: PreviewDependencies = {
			discover: discoverCookieProfiles, fetch: fetchCookieChannels,
		}, private readonly clock: () => number = Date.now) {}

	private remove(id: string): void {
		const candidate = this.candidates.get(id)
		if (candidate) clearTimeout(candidate.timer)
		this.candidates.delete(id)
	}

	private candidate(id: string): Candidate {
		const candidate = this.candidates.get(id)
		if (!candidate || candidate.expiresAt <= this.clock()) {
			this.remove(id)
			throw new Error('Cookie preview expired.')
		}
		return candidate
	}

	async inspect(cookie: string) {
		const { cookieHeader, profiles } = await this.deps.discover(cookie)
		while (this.candidates.size >= MAX_CANDIDATES) {
			this.remove(this.candidates.keys().next().value as string)
		}
		const id = randomUUID()
		const entries = new Map(profiles.map(profile => [randomUUID(), profile]))
		const timer = setTimeout(() => this.remove(id), CANDIDATE_LIFETIME_MS)
		timer.unref()
		this.candidates.set(id, { cookieHeader, profiles: entries,
			expiresAt: this.clock() + CANDIDATE_LIFETIME_MS, timer })
		return { candidateId: id,
			profiles: [...entries].map(([profileId, profile]) =>
				({ profileId, name: profile.name, handle: profile.handle,
					selected: profile.selected, channelId: profile.channelId,
					selectable: profile.selectable })) }
	}

	async compare(candidateId: string, profileId: string) {
		const candidate = this.candidate(candidateId)
		const profile = candidate.profiles.get(profileId)
		if (!profile?.selectable || !profile.channelId) {
			throw new Error('Selected cookie profile is unavailable.')
		}
		const channels = await this.deps.fetch({ cookie: candidate.cookieHeader,
			targetProfile: profile, onProgress: () => undefined })
		// Recheck after network I/O; expired or replaced candidates cannot commit.
		if (this.candidate(candidateId) !== candidate) {
			throw new Error('Cookie preview expired.')
		}
		const comparison = await this.compareSnapshot(profile.channelId, channels)
		if (this.candidate(candidateId) !== candidate) {
			throw new Error('Cookie preview expired.')
		}
		const id = randomUUID()
		candidate.preview = { id, profileId,
			fingerprint: this.fingerprint(channels, comparison) }
		return { previewId: id, ...comparison }
	}

	private async compareSnapshot(
		profileId: string, channels: ChannelBellState[],
	) {
		if (!Array.isArray(channels) || !channels.length ||
				channels.length > 10_000) {
			throw new Error('Cookie snapshot is invalid.')
		}
		const seen = new Set<string>()
		for (const channel of channels) {
			if (!channel || !isChannelId(channel.channelId) ||
					typeof channel.title !== 'string' || seen.has(channel.channelId) ||
					!['all', 'personalized', 'none', 'unknown']
						.includes(channel.notificationState)) {
				throw new Error('Cookie snapshot is invalid.')
			}
			seen.add(channel.channelId)
		}
		const saved = await this.db.all(`SELECT channelId, channelTitle, deleted,
			deletedReason FROM subscriptions`)
		const prior = await this.db.all('SELECT channelId, subscribed, ' +
			'lastConfirmedBell FROM cookie_channel_state WHERE profileKey=?',
		profileId)
		const existing = new Map(saved.map(row => [row.channelId, row]))
		const bells = new Map(prior.map(row => [row.channelId, row]))
		const next = new Map<string, { channelId: string, title: string,
			unconfirmed: boolean }>()
		for (const channel of channels) {
			const previous = bells.get(channel.channelId)
			const confirmed = channel.notificationState === 'unknown'
				? previous?.subscribed ? previous.lastConfirmedBell : null
				: channel.notificationState
			const row = existing.get(channel.channelId)
			const track = confirmed === 'all' || (confirmed === null &&
				channel.notificationState === 'unknown' && row?.deleted === 0)
			if (track && row?.deletedReason !== 'terminated') {
				next.set(channel.channelId, { channelId: channel.channelId,
					title: channel.title || row?.channelTitle || channel.channelId,
					unconfirmed: channel.notificationState === 'unknown' })
			}
		}
		const start = [...next.values()].filter(item =>
			!existing.has(item.channelId) ||
			existing.get(item.channelId).deleted !== 0)
		const continuing = [...next.values()].filter(item =>
			existing.get(item.channelId)?.deleted === 0)
		const stop = saved.filter(row =>
			row.deleted === 0 && !next.has(row.channelId))
			.map(row => ({ channelId: row.channelId, title: row.channelTitle }))
		const sort = (a: { channelId: string }, b: { channelId: string }) =>
			a.channelId.localeCompare(b.channelId)
		start.sort(sort); stop.sort(sort); continuing.sort(sort)
		return { start, stop, continuing }
	}

	private fingerprint(
		channels: ChannelBellState[], comparison: unknown,
	): string {
		const ordered = [...channels].sort((a, b) =>
			a.channelId.localeCompare(b.channelId))
		return createHash('sha256').update(JSON.stringify({ ordered, comparison }))
			.digest('hex')
	}

	async confirm(candidateId: string, previewId: string): Promise<{
		cookieHeader: string, profile: ResolvedCookieProfile,
		channels: ChannelBellState[],
	}> {
		const candidate = this.candidate(candidateId)
		const preview = candidate.preview
		const profile = preview && candidate.profiles.get(preview.profileId)
		if (!preview || preview.id !== previewId || !profile?.channelId) {
			throw new Error('Cookie preview is no longer available.')
		}
		const channels = await this.deps.fetch({ cookie: candidate.cookieHeader,
			targetProfile: profile, onProgress: () => undefined })
		if (this.candidate(candidateId) !== candidate ||
				candidate.preview !== preview) {
			throw new Error('Cookie preview expired.')
		}
		const comparison = await this.compareSnapshot(profile.channelId, channels)
		if (this.candidate(candidateId) !== candidate ||
				candidate.preview !== preview) {
			throw new Error('Cookie preview expired.')
		}
		if (this.fingerprint(channels, comparison) !== preview.fingerprint) {
			delete candidate.preview
			throw new Error('Channels changed; preview again before confirming.')
		}
		this.remove(candidateId)
		return { cookieHeader: candidate.cookieHeader, profile, channels }
	}

	cancel(id: string): void { this.remove(id) }

	dispose(): void { for (const id of this.candidates.keys()) this.remove(id) }
}
