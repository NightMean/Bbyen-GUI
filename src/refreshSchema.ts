import * as sqlite from 'sqlite'

export const initRefreshSchema = async (db: sqlite.Database): Promise<void> => {
	await db.exec(`CREATE TABLE IF NOT EXISTS refresh_runs (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL CHECK (kind IN ('videos', 'subscriptions')),
		status TEXT NOT NULL CHECK (status IN
			('running', 'completed', 'interrupted')),
		startedAt TEXT NOT NULL,
		finishedAt TEXT,
		resultJson TEXT
	);
	CREATE INDEX IF NOT EXISTS refresh_runs_by_kind
		ON refresh_runs(kind, startedAt);
	`)
}
