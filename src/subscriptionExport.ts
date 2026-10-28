import { ChannelEntry, Config } from './config'

interface ExportedChannel {
	id: string,
	notify?: boolean,
	manualPolicyExcluded?: boolean,
	notifyOnFirstScan?: boolean,
	initialBacklog?: ChannelEntry['initialBacklog'],
}

/** Export only subscription lists and their supported per-channel settings. */
export const exportSubscriptions = (config: Config) => {
	const list = (entries?: ChannelEntry[]): ExportedChannel[] | null => {
		if (!entries) return null
		return entries.map(entry => ({ id: entry.id,
			...(entry.notify !== undefined ? { notify: entry.notify } : {}),
			...(entry.manualPolicyExcluded !== undefined
				? { manualPolicyExcluded: entry.manualPolicyExcluded } : {}),
			...(entry.notifyOnFirstScan !== undefined
				? { notifyOnFirstScan: entry.notifyOnFirstScan } : {}),
			...(entry.initialBacklog !== undefined
				? { initialBacklog: entry.initialBacklog } : {}),
		}))
	}
	return { formatVersion: 1,
		whitelistedChannelIds: list(config.whitelistedChannelIds),
		blacklistedChannelIds: list(config.blacklistedChannelIds),
		manualChannelIds: list(config.manualChannelIds),
		savedChannelSettings: list(config.savedChannelSettings) }
}
