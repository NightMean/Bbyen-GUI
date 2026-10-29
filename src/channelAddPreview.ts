import axios from 'axios'
import RSSParser from 'rss-parser'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { Config } from './config'
import { assertChannelId } from './lib/channelId'
import { channelFeedUrl } from './videos'

/** Read only the public YouTube feed for a validated channel ID. */
export const readPublicChannelTitle = async (channelId: string) => {
	assertChannelId(channelId)
	try {
		const response = await axios.get<string>(channelFeedUrl(channelId), {
			timeout: 8000, maxContentLength: 1024 * 1024, maxRedirects: 0,
			responseType: 'text',
		})
		const feed = await new RSSParser().parseString(response.data)
		return typeof feed.title === 'string' && feed.title.trim()
			? feed.title.trim().slice(0, 200) : null
	} catch { return null }
}

/** Summarize known state without changing subscriptions or settings. */
export const channelAddPreview = async (db: sqlite.Database, config: Config,
	channelId: string) => {
	assertChannelId(channelId)
	const row = await db.get(SQL`SELECT channelTitle, deleted, deletedReason
		FROM subscriptions WHERE channelId=${channelId};`)
	const manual = config.mode === 'whitelist'
		? config.whitelistedChannelIds?.some(item => item.id === channelId)
		: config.mode === 'youtube' &&
			config.manualChannelIds?.some(item => item.id === channelId)
	const tracked = row?.deletedReason === 'terminated' ? false :
		!!(manual || (row && !row.deleted))
	const entry = config.channelSettingsById?.get(channelId)
	const emailEnabled = entry?.notify !== false &&
		!(config.mode === 'whitelist' && entry?.manualPolicyExcluded)
	return { channelId, tracked, emailEnabled,
		title: typeof row?.channelTitle === 'string' &&
			row.channelTitle !== channelId ? row.channelTitle.slice(0, 200) : null }
}
