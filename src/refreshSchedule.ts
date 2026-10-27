import parseDuration from 'parse-duration'
import fs from 'fs/promises'
import { Config } from './config'
import { assertTimerWithinLimit } from './lib/timerLimit'
import { updateJsonFile } from './lib/jsonFile'
import { RefreshKind } from './refreshCoordinator'

export interface RefreshIntervals { subscriptions: string, videos: string }

const parseInterval = (
	name: string, value: unknown,
): { text: string, ms: number } => {
	if (typeof value !== 'string' || value.length > 64) {
		throw new Error(`Invalid ${name} interval.`)
	}
	const text = value.trim().toLowerCase()
	const pattern = new RegExp('^\\d+(?:\\.\\d+)?\\s*' +
		'(?:ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?|w|weeks?)$')
	if (!pattern.test(text)) {
		throw new Error(`Invalid ${name} interval.`)
	}
	const ms = assertTimerWithinLimit(name, parseDuration(text) as number)
	if (ms < 1) throw new Error(`Invalid ${name} interval.`)
	return { text, ms }
}

export const parseRefreshIntervals = (value: unknown): {
	intervals: RefreshIntervals, ms: Record<RefreshKind, number>,
} => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Refresh intervals must be an object.')
	}
	const input = value as Record<string, unknown>
	const subscriptions = parseInterval('subscriptions', input.subscriptions)
	const videos = parseInterval('videos', input.videos)
	return {
		intervals: { subscriptions: subscriptions.text, videos: videos.text },
		ms: { subscriptions: subscriptions.ms, videos: videos.ms },
	}
}

/** Own both timers and replace them together when settings change. */
export class RefreshSchedule {
	private timers: NodeJS.Timeout[] = []
	constructor(private readonly run: (kind: RefreshKind) => void) {}
	prepare(ms: Record<RefreshKind, number>): { commit: () => void,
		cancel: () => void } {
		const created: NodeJS.Timeout[] = []
		let active = false
		try {
			for (const kind of ['subscriptions', 'videos'] as const) {
				created.push(setInterval(() => { if (active) this.run(kind) },
					assertTimerWithinLimit(kind, ms[kind])))
			}
		} catch (err) {
			created.forEach(clearInterval)
			throw err
		}
		return { commit: () => {
			this.timers.forEach(clearInterval)
			this.timers = created; active = true
		}, cancel: () => created.forEach(clearInterval) }
	}
	configure(ms: Record<RefreshKind, number>): void { this.prepare(ms).commit() }
	stop(): void { this.timers.forEach(clearInterval); this.timers = [] }
}

export const saveRefreshIntervals = async (
	filename: string, config: Config, schedule: RefreshSchedule, value: unknown,
): Promise<void> => {
	const parsed = parseRefreshIntervals(value)
	const prepared = schedule.prepare(parsed.ms)
	try {
		await updateJsonFile(filename, current => {
			if (!current || typeof current !== 'object' || Array.isArray(current)) {
				throw new Error('Configuration must be an object.')
			}
			return { ...current, timers: parsed.intervals }
		})
	} catch (err) {
		// Atomic replacement may have succeeded before lock cleanup failed.
		let persisted = false
		try {
			const stored = JSON.parse(await fs.readFile(filename, 'utf8'))
			const checked = parseRefreshIntervals(stored.timers).intervals
			persisted = checked.subscriptions === parsed.intervals.subscriptions &&
				checked.videos === parsed.intervals.videos
		} catch { console.warn('Could not verify saved refresh intervals.') }
		if (persisted) { prepared.commit(); config.timers = parsed.intervals }
		else prepared.cancel()
		throw err
	}
	prepared.commit()
	config.timers = parsed.intervals
}
