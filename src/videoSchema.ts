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
		const backlogMigration = await db.get(
			'SELECT version FROM video_schema_migrations WHERE version = 2')
		if (!backlogMigration) {
			await db.exec(`
				CREATE TABLE initial_backlog_videos (
					channelId TEXT NOT NULL,
					videoId TEXT NOT NULL,
					notify INTEGER NOT NULL CHECK (notify IN (0, 1)),
					PRIMARY KEY (channelId, videoId)
				);
				INSERT INTO video_schema_migrations (version) VALUES (2);
			`)
		}
		const repair = await db.get(
			'SELECT version FROM video_schema_migrations WHERE version = 3')
		if (!repair) {
			await db.exec(`
				INSERT INTO video_observations (videoId, channelId, emailOutcome)
					SELECT videos.videoId, videos.channelId, 'unknown' FROM videos
					WHERE NOT EXISTS (SELECT 1 FROM video_observations
						WHERE video_observations.videoId = videos.videoId);
				INSERT INTO video_schema_migrations (version) VALUES (3);
			`)
		}
		const discovered = await db.get(
			'SELECT version FROM video_schema_migrations WHERE version = 4')
		if (!discovered) {
			await db.exec(`
				CREATE TABLE video_observations_v4 (
					videoId TEXT PRIMARY KEY,
					channelId TEXT NOT NULL,
					title TEXT, publishedAt TEXT, thumbnailUrl TEXT,
					durationSeconds INTEGER, contentType TEXT, observedAt TEXT,
					emailOutcome TEXT NOT NULL CHECK (emailOutcome IN (
						'unknown', 'discovered', 'pending', 'sent', 'muted',
						'excluded', 'backlog_skipped', 'failed', 'uncertain'
					)),
					sentAt TEXT
				);
				INSERT INTO video_observations_v4
					SELECT videoId, channelId, title, publishedAt, thumbnailUrl,
						durationSeconds, contentType, observedAt,
						CASE WHEN emailOutcome='unknown' AND NOT EXISTS (
							SELECT 1 FROM videos WHERE videos.videoId=
								video_observations.videoId
						) THEN 'discovered' ELSE emailOutcome END, sentAt
					FROM video_observations;
				DROP TABLE video_observations;
				ALTER TABLE video_observations_v4 RENAME TO video_observations;
				CREATE INDEX video_observations_channel_date
					ON video_observations(channelId, publishedAt);
				INSERT INTO video_schema_migrations (version) VALUES (4);
			`)
		}
		const metadata = await db.get(
			'SELECT version FROM video_schema_migrations WHERE version = 5')
		if (!metadata) {
			await db.exec(`
				ALTER TABLE video_observations ADD COLUMN apiMetadataAt TEXT;
				INSERT INTO video_schema_migrations (version) VALUES (5);
			`)
		}
		await db.exec('COMMIT')
	} catch (err) {
		await db.exec('ROLLBACK')
		throw err
	}
}
