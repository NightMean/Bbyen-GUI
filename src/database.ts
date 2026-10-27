import path from 'path'

import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'
import SQL from 'sql-template-strings'
import { migrateVideoSchema } from './videoSchema'
import { initChannelSchema } from './channelSchema'
import { initRefreshSchema } from './refreshSchema'
import { initIncidentSchema } from './incidentSchema'
import { initQuotaSchema } from './quotaBackoff'

export const DEFAULT_CHANNEL_THUMBNAIL =
	'https://www.gstatic.com/youtube/img/creator/no_avatar.png'


/**
 * Set up database
 */

export const init = async ({ filename }: { filename: string }) => {
	const db = await sqlite.open({
		filename: filename === ':memory:'
			? filename : path.resolve(__dirname, '../', filename),
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

	// Older versions never recorded observation times. This upgrade is our
	// earliest verifiable observation, not the historical YouTube subscribe date.
	await db.run(SQL`
		UPDATE subscriptions SET firstObservedAt=${new Date().toISOString()}
		WHERE firstObservedAt IS NULL;
	`)
	await migrateVideoSchema(db)
	await initChannelSchema(db)
	await initRefreshSchema(db)
	await initIncidentSchema(db)
	await initQuotaSchema(db)
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
	// Bell discovery alone must not activate email monitoring. Subscription
	// reconciliation activates eligible rows and fetches their channel metadata.
	await db.run(SQL`
		INSERT INTO subscriptions (
			channelId, channelTitle, channelThumbnail,
			firstObservedAt, bellState, bellUpdatedAt, deleted, deletedReason
		) VALUES (
			${channelId}, ${channelTitle}, ${thumbnail || DEFAULT_CHANNEL_THUMBNAIL},
			${now}, ${bellState}, ${now}, 1, 'unsubscribed'
		)
		ON CONFLICT(channelId) DO UPDATE SET
			firstObservedAt=COALESCE(
				subscriptions.firstObservedAt, excluded.firstObservedAt),
			bellUpdatedAt=CASE
				WHEN subscriptions.bellState IS NOT excluded.bellState
				THEN excluded.bellUpdatedAt ELSE subscriptions.bellUpdatedAt END,
			bellState=excluded.bellState,
			channelTitle=COALESCE(
				NULLIF(excluded.channelTitle, ''), subscriptions.channelTitle),
			channelThumbnail=CASE WHEN ${thumbnail} <> '' THEN ${thumbnail}
				ELSE subscriptions.channelThumbnail END;
	`)
}

