import path from 'path'

import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'
import SQL from 'sql-template-strings'


/**
 * Set up database
 */

export const init = async ({ filename }: { filename: string }) => {
	const db = await sqlite.open({
		filename: path.join(__dirname, '../', filename),
		driver: sqlite3.Database,
	})

	// Create all necessary tables if they don't exist
	await db.exec(SQL`
		CREATE TABLE IF NOT EXISTS videos (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			videoId TEXT NOT NULL UNIQUE,
			channelId TEXT NOT NULL
		);
	`)

	await db.exec(SQL`
		CREATE TABLE IF NOT EXISTS subscriptions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			channelId TEXT NOT NULL UNIQUE,
			channelThumbnail TEXT NOT NULL,
			channelTitle TEXT NOT NULL,
			deleted INTEGER DEFAULT 0,
			deletedReason TEXT DEFAULT NULL,
			deletedAt TEXT DEFAULT NULL,
			firstObservedAt TEXT DEFAULT NULL,
			bellState TEXT DEFAULT NULL,
			bellUpdatedAt TEXT DEFAULT NULL
		);
	`)

	// Migration if db was created before newer columns.
	const subscriptions = await db.all(SQL`PRAGMA table_info(subscriptions)`)
	if (!subscriptions.some(col => col.name === 'deleted')) {
		await db.exec(SQL`
			ALTER TABLE subscriptions ADD COLUMN deleted INTEGER DEFAULT 0;
		`)
	}
	if (!subscriptions.some(col => col.name === 'deletedReason')) {
		await db.exec(SQL`
			ALTER TABLE subscriptions
			ADD COLUMN deletedReason TEXT DEFAULT NULL;
		`)
	}
	if (!subscriptions.some(col => col.name === 'deletedAt')) {
		await db.exec(SQL`
			ALTER TABLE subscriptions
			ADD COLUMN deletedAt TEXT DEFAULT NULL;
		`)
	}
	if (!subscriptions.some(col => col.name === 'firstObservedAt')) {
		await db.exec(SQL`
			ALTER TABLE subscriptions
			ADD COLUMN firstObservedAt TEXT DEFAULT NULL;
		`)
	}
	if (!subscriptions.some(col => col.name === 'bellState')) {
		await db.exec(SQL`
			ALTER TABLE subscriptions
			ADD COLUMN bellState TEXT DEFAULT NULL;
		`)
	}
	if (!subscriptions.some(col => col.name === 'bellUpdatedAt')) {
		await db.exec(SQL`
			ALTER TABLE subscriptions
			ADD COLUMN bellUpdatedAt TEXT DEFAULT NULL;
		`)
	}

	return db
}

/**
 * Inserts or updates a channel's subscription and notification bell status.
 * Preserves initial firstObservedAt timestamp; updates bellUpdatedAt only when
 * the bell status changes.
 */
export const recordSubscriptionBellState = async (
	db: sqlite.Database,
	channelId: string,
	channelTitle: string,
	bellState: 'all' | 'personalized' | 'none' | 'unknown',
	thumbnail = '',
): Promise<void> => {
	const now = new Date().toISOString()
	const existing = await db.get(SQL`
		SELECT id, bellState, firstObservedAt FROM subscriptions
		WHERE channelId=${channelId};
	`)

	if (!existing) {
		await db.run(SQL`
			INSERT INTO subscriptions (
				channelId, channelTitle, channelThumbnail,
				firstObservedAt, bellState, bellUpdatedAt
			) VALUES (
				${channelId}, ${channelTitle}, ${thumbnail},
				${now}, ${bellState}, ${now}
			);
		`)
	} else if (existing.bellState !== bellState) {
		await db.run(SQL`
			UPDATE subscriptions
			SET bellState=${bellState},
				bellUpdatedAt=${now},
				channelTitle=${channelTitle}
			WHERE channelId=${channelId};
		`)
	} else if (channelTitle && existing.channelTitle !== channelTitle) {
		await db.run(SQL`
			UPDATE subscriptions
			SET channelTitle=${channelTitle}
			WHERE channelId=${channelId};
		`)
	}
}

