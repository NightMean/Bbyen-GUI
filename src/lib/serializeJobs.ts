/** Serialize work sharing a SQLite connection and coalesce duplicate jobs. */
export const serializeJobs = () => {
	let tail: Promise<unknown> = Promise.resolve()
	const pending = new Map<string, Promise<unknown>>()
	return {
		run: <T>(key: string, job: () => Promise<T>): Promise<T> => {
			const existing = pending.get(key)
			if (existing) return existing as Promise<T>
			const result = tail.then(job)
			pending.set(key, result)
			tail = result.then(() => undefined, () => undefined)
			void result.then(() => pending.delete(key), () => pending.delete(key))
			return result
		},
	}
}
