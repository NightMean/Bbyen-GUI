import * as sqlite from 'sqlite'

/** Sources are recorded independently of whether video email is enabled. */
export const initChannelSchema = async (db: sqlite.Database): Promise<void> => {
	await db.exec(`CREATE TABLE IF NOT EXISTS channel_sources (
		channelId TEXT PRIMARY KEY,
		apiSubscribed INTEGER NOT NULL DEFAULT 0 CHECK (apiSubscribed IN (0, 1)),
		manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1)),
		apiSubscriptionId TEXT,
		apiSubscribedAt TEXT,
		apiObservedAt TEXT
	);`)
}
