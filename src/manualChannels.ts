import {
	Config, buildChannelSettingsMap, normalizeChannelEntries,
} from './config'
import { assertChannelId } from './lib/channelId'
import { mergeChannelEntries, parseChannelLists } from './lib/channelConfig'
import { updateJsonFile } from './lib/jsonFile'

/** Preserve other writers' changes and settings when adding a channel. */
export const addManualChannel = async (
	filename: string, config: Config, channelId: string,
): Promise<void> => {
	return updateManualChannel(filename, config, channelId, { type: 'add' })
}

export const setManualChannelNotify = async (
	filename: string, config: Config, channelId: string, notify: boolean,
): Promise<void> => {
	if (config.mode !== 'whitelist') {
		throw new Error('Manual notification controls require whitelist mode.')
	}
	return updateManualChannel(filename, config, channelId,
		{ type: 'notify', notify })
}

type ManualChange = { type: 'add' } | { type: 'notify', notify: boolean }

const updateManualChannel = async (
	filename: string, config: Config, channelId: string, change: ManualChange,
): Promise<void> => {
	assertChannelId(channelId)
	const lists = await updateJsonFile(filename, async value => {
		const current = parseChannelLists(value)
		// Startup normalizes this file; revalidate after another writer changes it.
		const normalize = async (id: string) => assertChannelId(id)
		const whitelist = await normalizeChannelEntries(normalize,
			current.whitelistedChannelIds) ?? []
		const blacklist = await normalizeChannelEntries(normalize,
			current.blacklistedChannelIds)
		const manual = await normalizeChannelEntries(normalize,
			current.manualChannelIds) ?? []
		if (change.type === 'notify' && !whitelist.some(c => c.id === channelId)) {
			throw new Error('The channel is not in the manual whitelist.')
		}
		const update = change.type === 'add' ? { id: channelId } :
			{ id: channelId, notify: change.notify }
		return { ...current,
			whitelistedChannelIds: mergeChannelEntries([...whitelist, update]),
			blacklistedChannelIds: blacklist,
			manualChannelIds: change.type === 'add' ||
				manual.some(c => c.id === channelId)
				? mergeChannelEntries([...manual, update]) : manual,
		}
	})
	config.whitelistedChannelIds = lists.whitelistedChannelIds
	config.blacklistedChannelIds = lists.blacklistedChannelIds
	config.manualChannelIds = lists.manualChannelIds
	config.channelSettingsById = buildChannelSettingsMap(mergeChannelEntries([
		...lists.whitelistedChannelIds, ...lists.manualChannelIds,
	]))
}
