import axios from 'axios'
import sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import winston from 'winston'

import { ISendErrorEmail } from '../email'

const HEADERS = {
	'User-Agent':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
		'(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
}

export interface TerminatedChannelInfo {
	channelId: string
	channelTitle: string
}

/**
 * Verifies if a channel is terminated or deleted on YouTube.
 * Returns true if the public channel page returns 404 or lacks canonical tags.
 */
export const isChannelTerminatedOnYouTube = async (
	channelId: string,
): Promise<boolean> => {
	const url = `https://www.youtube.com/channel/${channelId}`
	try {
		const res = await axios.get(url, {
			headers: HEADERS,
			timeout: 10000,
			validateStatus: () => true,
		})

		if (res.status === 404) {
			return true
		}

		const data = typeof res.data === 'string' ? res.data : ''
		const hasCanonical = data.includes('rel="canonical"')
		const hasOgTitle = data.includes('property="og:title"')

		// Dead or non-existent channels lack both canonical link and og:title
		if (!hasCanonical && !hasOgTitle) {
			return true
		}

		return false
	} catch {
		// Network errors should not be treated as termination
		return false
	}
}

/**
 * Marks a channel as terminated in SQLite and sends an email notification.
 * Keeps channel details permanently in database history.
 */
export const handleTerminatedChannel = async (
	db: sqlite.Database,
	channel: TerminatedChannelInfo,
	sendErrorEmail: (e: ISendErrorEmail) => Promise<unknown>,
	logger: winston.Logger,
): Promise<void> => {
	const now = new Date().toISOString()

	await db.run(SQL`
		UPDATE subscriptions
		SET deleted = 1,
			deletedReason = 'terminated',
			deletedAt = ${now}
		WHERE channelId = ${channel.channelId};
	`)

	logger.warn(
		`Channel "${channel.channelTitle}" (${channel.channelId}) was ` +
		'terminated/deleted by YouTube. Marked in database.',
	)

	try {
		await sendErrorEmail({
			subject:
				`[bbyen] Channel Deleted/Terminated: ${channel.channelTitle}`,
			message:
				`The YouTube channel "${channel.channelTitle}" ` +
				`(${channel.channelId}) is no longer available on YouTube ` +
				'(HTTP 404 / Policy Termination).\n\n' +
				'It has been marked as terminated in your database history ' +
				'to preserve your record of it.',
			stack: `Channel URL: https://www.youtube.com/channel/${channel.channelId}`,
		})
	} catch (emailErr) {
		logger.error(
			`Failed to send termination alert email for ${channel.channelId}: ` +
			`${(emailErr as Error).message}`,
		)
	}
}
