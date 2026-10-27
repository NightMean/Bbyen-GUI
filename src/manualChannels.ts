import {
	Config, buildChannelSettingsMap, normalizeChannelEntries,
} from './config'
import { assertChannelId } from './lib/channelId'
import { mergeChannelEntries, parseChannelLists } from './lib/channelConfig'
import { updateJsonFile } from './lib/jsonFile'
import { BacklogPolicy } from './initialBacklog'

/** Preserve other writers' changes and settings when adding a channel. */
export const addManualChannel = async (
	filename: string, config: Config, channelId: string,
	initialBacklog?: BacklogPolicy,
): Promise<void> => {
	return updateManualChannel(filename, config, channelId,
		{ type: 'add', initialBacklog })
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

export const removeManualChannel = async (
	filename: string, config: Config, channelId: string,
): Promise<void> => {
	if (config.mode !== 'whitelist') {
		throw new Error('Manual removal requires whitelist mode.')
	}
	return updateManualChannel(filename, config, channelId, { type: 'remove' })
}

type ManualChange = { type: 'add', initialBacklog?: BacklogPolicy } |
	{ type: 'remove' } |
	{ type: 'notify', notify: boolean }

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
		const saved = await normalizeChannelEntries(normalize,
			current.savedChannelSettings) ?? []
		if (change.type !== 'add' && !whitelist.some(c => c.id === channelId)) {
			throw new Error('The channel is not in the manual whitelist.')
		}
		if (change.type === 'remove') {
			const preference = mergeChannelEntries([
				...saved, ...whitelist, ...manual,
			]).find(c => c.id === channelId)
			return { ...current,
				whitelistedChannelIds: whitelist.filter(c => c.id !== channelId),
				manualChannelIds: manual.filter(c => c.id !== channelId),
				blacklistedChannelIds: blacklist,
				savedChannelSettings: mergeChannelEntries([
					...saved, ...(preference ? [preference] : []),
				]),
			}
		}
		const update = change.type === 'add' ? { id: channelId,
			...(change.initialBacklog
				? { initialBacklog: change.initialBacklog } : {}),
		} :
			{ id: channelId, notify: change.notify }
		return { ...current,
			whitelistedChannelIds: mergeChannelEntries([...whitelist, update]),
			blacklistedChannelIds: blacklist,
			savedChannelSettings: saved,
			manualChannelIds: change.type === 'add' ||
				manual.some(c => c.id === channelId)
				? mergeChannelEntries([...manual, update]) : manual,
		}
	})
	config.whitelistedChannelIds = lists.whitelistedChannelIds
	config.blacklistedChannelIds = lists.blacklistedChannelIds
	config.manualChannelIds = lists.manualChannelIds
	config.savedChannelSettings = lists.savedChannelSettings
	config.channelSettingsById = buildChannelSettingsMap(mergeChannelEntries([
		...lists.savedChannelSettings, ...lists.whitelistedChannelIds,
		...lists.manualChannelIds,
	]))
}
