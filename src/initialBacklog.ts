export type BacklogPolicy =
	{ mode: 'all' | 'none' } | { mode: 'newest', count: number }

export const parseBacklogPolicy = (
	value: unknown, name: string,
): BacklogPolicy => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${name} must be an all, none, or newest policy.`)
	}
	const policy = value as Record<string, unknown>
	if ((policy.mode === 'all' || policy.mode === 'none') &&
			Object.keys(policy).every(key => key === 'mode')) {
		return { mode: policy.mode }
	}
	if (policy.mode === 'newest' && typeof policy.count === 'number' &&
			Number.isSafeInteger(policy.count) && policy.count > 0 &&
			Object.keys(policy).every(key => key === 'mode' || key === 'count')) {
		return { mode: 'newest', count: policy.count }
	}
	throw new Error(`${name} must be {mode: all|none} or ` +
		'{mode: newest, count: positive integer}.')
}

export interface BacklogItem {
	videoId: string,
	isoDate?: string,
	pubDate?: string,
}

export const chooseInitialVideos = (
	items: BacklogItem[], policy: BacklogPolicy,
): Set<string> => {
	if (policy.mode === 'none') return new Set()
	const sorted = [...items].sort((a, b) => {
		const aDate = Date.parse(a.isoDate ?? a.pubDate ?? '')
		const bDate = Date.parse(b.isoDate ?? b.pubDate ?? '')
		const aTime = Number.isFinite(aDate) ? aDate : -Infinity
		const bTime = Number.isFinite(bDate) ? bDate : -Infinity
		if (aTime !== bTime) return bTime > aTime ? 1 : -1
		return a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0
	})
	const ids = [...new Set(sorted.map(item => item.videoId))]
	if (policy.mode !== 'newest') return new Set(ids)
	return new Set(ids.slice(0, policy.count))
}
