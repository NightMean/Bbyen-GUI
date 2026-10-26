import * as sqlite from 'sqlite'

/** Run once at service startup before any video jobs are started. */
export const recoverPendingVideoEmails = async (
	db: sqlite.Database,
): Promise<void> => {
	await db.run(`UPDATE video_observations SET emailOutcome='uncertain'
		WHERE emailOutcome='pending'`)
}

/** Install video history storage without changing the processed-ID ledger. */
export const migrateVideoSchema = async (
	db: sqlite.Database,
): Promise<void> => {
	await db.exec('BEGIN IMMEDIATE')
	try {
		await db.exec(`
			CREATE TABLE IF NOT EXISTS video_schema_migrations (
				version INTEGER PRIMARY KEY
			);
		`)
		const migration = await db.get(
			'SELECT version FROM video_schema_migrations WHERE version = 1')
		if (!migration) {
			await db.exec(`
				CREATE TABLE video_observations (
					videoId TEXT PRIMARY KEY,
					channelId TEXT NOT NULL,
					title TEXT,
					publishedAt TEXT,
					thumbnailUrl TEXT,
					durationSeconds INTEGER,
					contentType TEXT,
					observedAt TEXT,
					emailOutcome TEXT NOT NULL CHECK (emailOutcome IN (
						'unknown', 'pending', 'sent', 'muted',
						'excluded', 'backlog_skipped', 'failed', 'uncertain'
					)),
					sentAt TEXT
				);
				CREATE INDEX video_observations_channel_date
					ON video_observations(channelId, publishedAt);
				CREATE TABLE video_scan_baselines (
					channelId TEXT PRIMARY KEY,
					completedAt TEXT NOT NULL
				);
				INSERT INTO video_observations (videoId, channelId, emailOutcome)
					SELECT videoId, channelId, 'unknown' FROM videos;
				INSERT INTO video_scan_baselines (channelId, completedAt)
					SELECT DISTINCT channelId, CURRENT_TIMESTAMP FROM videos;
				INSERT INTO video_schema_migrations (version) VALUES (1);
			`)
		}
		await db.exec('COMMIT')
	} catch (err) {
		await db.exec('ROLLBACK')
		throw err
	}
}
