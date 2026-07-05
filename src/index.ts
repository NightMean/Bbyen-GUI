import { google } from 'googleapis'
import parseDuration from 'parse-duration'
import { OAuth2Client } from 'google-auth-library'

import { loadConfig, loadConfigRaw, loadEmailConfig } from './config'
import * as database from './database'
import authorize from './google/auth'
import * as mailer from './email'
import { parseFeedsAndNotify } from './videos'
import { updateSubscriptions } from './subscriptions'
import setIntervalInstant from './lib/setIntervalInstant'
import { ISendErrorEmail } from './email'
import { classifyError } from './lib/classifyError'
import { notifyError } from './lib/alertState'
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

		const config = await loadConfig(service, auth as OAuth2Client)
		const db = await database.init(config.database)

		setIntervalInstant(
			updateSubscriptions,
			parseDuration(config.timers.subscriptions),
			config.kickoff.subscriptions,
			{ db, service, auth, config, sendErrorEmail },
		)

		setIntervalInstant(
			parseFeedsAndNotify,
			parseDuration(config.timers.videos),
			config.kickoff.videos,
			{ db, service, auth, sendVideoEmail, config, sendErrorEmail },
		)

	} catch (err) {
		logger.error(err)
		process.exit(1)
	}
}

main()
