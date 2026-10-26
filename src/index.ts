import { google } from 'googleapis'
import parseDuration from 'parse-duration'
import { OAuth2Client } from 'google-auth-library'

import { loadConfig, loadConfigRaw, loadEmailConfig } from './config'
import * as database from './database'
import { recoverPendingVideoEmails } from './videoSchema'
import authorize from './google/auth'
import * as mailer from './email'
import { parseFeedsAndNotify } from './videos'
import { updateSubscriptions } from './subscriptions'
import setIntervalInstant from './lib/setIntervalInstant'
import { serializeJobs } from './lib/serializeJobs'
import { ISendErrorEmail } from './email'
import { classifyError } from './lib/classifyError'
import { notifyError } from './lib/alertState'
import { assertTimerWithinLimit } from './lib/timerLimit'
import setupLogger from './lib/logger'

const main = async () => {
	const logger = await setupLogger({ label: 'main' })

	// Email must be available before anything that can fail, so failures can be
	// reported. A failure to set up email itself can only be logged.
	let sendVideoEmail: mailer.SendVideoEmail
	let sendErrorEmail: (error: ISendErrorEmail) => Promise<unknown>
	try {
		const emailConfig = await loadEmailConfig()
		const mailers = await mailer.init(emailConfig)
		sendVideoEmail = mailers.sendVideoEmail
		sendErrorEmail = mailers.sendErrorEmail
	} catch (err) {
		logger.error('Failed to initialize email; cannot send alerts.')
		logger.error(err)
		process.exit(1)
	}

	try {
		const service = google.youtube('v3')

		// Read the mode without full config normalization (which may hit the
		// API) so we can decide whether to authenticate at all.
		const raw = await loadConfigRaw()

		let auth: OAuth2Client | undefined
		if (raw.mode !== 'whitelist') {
			try {
				auth = await authorize({ interactive: false })
			} catch (err) {
				await notifyError(classifyError(err), err, {
					sendErrorEmail,
					emailOnError: raw.logging.emailOnError,
					logger,
				})
				logger.error(err)
				process.exit(1)
			}
		}

		const config = await loadConfig(service, auth)
		const db = await database.init(config.database)
		await recoverPendingVideoEmails(db)

		// Reject over-long intervals up front: Node's timer delay is a 32-bit
		// int, so anything larger silently fires every 1 ms.
		const subscriptionsTimer = assertTimerWithinLimit(
			'subscriptions', parseDuration(config.timers.subscriptions) as number)
		const videosTimer = assertTimerWithinLimit(
			'videos', parseDuration(config.timers.videos) as number)

		// Both jobs share one SQLite connection and may open transactions.
		const jobs = serializeJobs()
		setIntervalInstant(
			() => jobs.run('subscriptions', () => updateSubscriptions(
				{ db, service, auth, config, sendErrorEmail },
			)).catch(err => logger.error(err)),
			subscriptionsTimer,
			config.kickoff.subscriptions,
		)

		setIntervalInstant(
			() => jobs.run('videos', () => parseFeedsAndNotify(
				{ db, service, auth, sendVideoEmail, config, sendErrorEmail },
			)).catch(err => logger.error(err)),
			videosTimer,
			config.kickoff.videos,
		)

	} catch (err) {
		logger.error(err)
		process.exit(1)
	}
}

main()
