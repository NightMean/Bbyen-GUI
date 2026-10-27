import * as sqlite from 'sqlite'

export const initIncidentSchema = async (
	db: sqlite.Database,
): Promise<void> => {
	await db.exec(`CREATE TABLE IF NOT EXISTS incidents (
		id TEXT PRIMARY KEY,
		source TEXT NOT NULL,
		category TEXT NOT NULL,
		channelId TEXT,
		openedAt TEXT NOT NULL,
		lastObservedAt TEXT NOT NULL,
		resolvedAt TEXT,
		occurrences INTEGER NOT NULL,
		emailState TEXT NOT NULL,
		attemptCount INTEGER NOT NULL DEFAULT 0,
		nextAttemptAt TEXT
	);
	CREATE UNIQUE INDEX IF NOT EXISTS incidents_active_key
		ON incidents(source, category, COALESCE(channelId, ''))
		WHERE resolvedAt IS NULL;
	CREATE INDEX IF NOT EXISTS incidents_by_time ON incidents(openedAt);
	`)
}
