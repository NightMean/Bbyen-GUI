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
	);
	CREATE TABLE IF NOT EXISTS cookie_active_profile (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		profileKey TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS cookie_connection (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		generation TEXT NOT NULL,
		cookieHeader TEXT NOT NULL,
		channelId TEXT NOT NULL,
		pageId TEXT,
		profileName TEXT NOT NULL,
		handle TEXT,
		selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
		stale INTEGER NOT NULL CHECK (stale IN (0, 1)),
		lastSuccessfulAt TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS cookie_cleanup (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		legacyHash TEXT
	);
	CREATE TABLE IF NOT EXISTS oauth_cleanup (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		tokenHash TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS cookie_channel_state (
		profileKey TEXT NOT NULL,
		channelId TEXT NOT NULL,
		subscribed INTEGER NOT NULL CHECK (subscribed IN (0, 1)),
		latestBell TEXT,
		lastConfirmedBell TEXT,
		observedAt TEXT NOT NULL,
		PRIMARY KEY (profileKey, channelId)
	);
	CREATE TABLE IF NOT EXISTS cookie_channel_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		profileKey TEXT NOT NULL,
		channelId TEXT NOT NULL,
		previousState TEXT,
		currentState TEXT NOT NULL,
		notifyEligible INTEGER NOT NULL CHECK (notifyEligible IN (0, 1)),
		observedAt TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS channel_title_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		channelId TEXT NOT NULL,
		previousTitle TEXT NOT NULL,
		currentTitle TEXT NOT NULL,
		observedAt TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS cookie_bell_actions (
		id TEXT PRIMARY KEY,
		profileKey TEXT NOT NULL,
		channelId TEXT NOT NULL,
		target TEXT NOT NULL CHECK (target IN ('all', 'personalized', 'none')),
		state TEXT NOT NULL CHECK (state IN
			('pending', 'confirmed', 'uncertain', 'acknowledged')),
		startedAt TEXT NOT NULL,
		finishedAt TEXT
	);
	CREATE TABLE IF NOT EXISTS cookie_subscription_actions (
		id TEXT PRIMARY KEY,
		profileKey TEXT NOT NULL,
		channelId TEXT NOT NULL,
		target INTEGER NOT NULL CHECK (target IN (0, 1)),
		state TEXT NOT NULL CHECK (state IN
			('pending', 'confirmed', 'uncertain', 'acknowledged')),
		startedAt TEXT NOT NULL,
		finishedAt TEXT
	);
	CREATE TABLE IF NOT EXISTS cookie_unsubscribe_undos (
		id TEXT PRIMARY KEY,
		profileKey TEXT NOT NULL,
		channelId TEXT NOT NULL,
		priorBell TEXT,
		state TEXT NOT NULL CHECK (state IN
			('pending', 'partial', 'completed', 'acknowledged')),
		startedAt TEXT NOT NULL,
		finishedAt TEXT
	);
	CREATE TABLE IF NOT EXISTS api_subscription_actions (
		id TEXT PRIMARY KEY,
		profileKey TEXT NOT NULL,
		channelId TEXT NOT NULL,
		target INTEGER NOT NULL CHECK (target IN (0, 1)),
		state TEXT NOT NULL CHECK (state IN
			('pending', 'confirmed', 'uncertain', 'acknowledged')),
		startedAt TEXT NOT NULL,
		finishedAt TEXT
	);
	CREATE TABLE IF NOT EXISTS channel_added_batches (
		id TEXT PRIMARY KEY,
		observedAt TEXT NOT NULL,
		emailState TEXT NOT NULL CHECK (emailState IN
			('pending', 'sending', 'sent', 'uncertain', 'suppressed'))
	);
	CREATE TABLE IF NOT EXISTS channel_added_events (
		batchId TEXT NOT NULL,
		channelId TEXT NOT NULL,
		observedAt TEXT NOT NULL,
		PRIMARY KEY (batchId, channelId)
	);
	`)
	await db.exec('BEGIN IMMEDIATE')
	try {
		const subscriptionColumns = await db.all(
			'PRAGMA table_info(cookie_subscription_actions)')
		if (!subscriptionColumns.some(column => column.name === 'priorBell')) {
			await db.exec(`ALTER TABLE cookie_subscription_actions
				ADD COLUMN priorBell TEXT`)
		}
		const columns = await db.all('PRAGMA table_info(channel_title_events)')
		if (!columns.some(column => column.name === 'emailState')) {
			await db.exec(`ALTER TABLE channel_title_events ADD COLUMN emailState TEXT
				NOT NULL DEFAULT 'historical'`)
		}
		await db.exec(`DROP TRIGGER IF EXISTS record_channel_title_change;
	CREATE TRIGGER record_channel_title_change
	AFTER UPDATE OF channelTitle ON subscriptions
	WHEN OLD.channelTitle <> NEW.channelTitle
		AND OLD.channelTitle <> OLD.channelId AND OLD.channelTitle <> ''
		AND NEW.channelTitle <> NEW.channelId AND NEW.channelTitle <> ''
	BEGIN
		INSERT INTO channel_title_events
			(channelId, previousTitle, currentTitle, observedAt, emailState)
		VALUES (NEW.channelId, OLD.channelTitle, NEW.channelTitle,
			strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending');
	END;`)
		await db.exec('COMMIT')
	} catch (err) {
		await db.exec('ROLLBACK')
		throw err
	}
}
