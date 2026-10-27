import { Config } from './config'
import fs from 'fs/promises'
import { BacklogPolicy, parseBacklogPolicy } from './initialBacklog'
import { updateJsonFile } from './lib/jsonFile'
import { parseVideoRetentionDays } from './videoRetention'
import { parseActivityRetentionDays } from './activityRetention'

export interface GeneralSettings {
	initialBacklog: BacklogPolicy,
	videoRetentionDays: number | null,
	activityRetentionDays: number | null,
	emailOnError: boolean,
	confirmUnsubscribe: boolean,
	notifyTitleChanges: boolean,
	notifyChannelAdded: boolean,
}

export const readGeneralSettings = (config: Config): GeneralSettings => ({
	initialBacklog: config.initialBacklog ??
		{ mode: config.notifyOnFirstScan ? 'all' : 'none' },
	videoRetentionDays: config.videoRetentionDays ?? null,
	activityRetentionDays: config.activityRetentionDays ?? null,
	emailOnError: config.logging.emailOnError,
	confirmUnsubscribe: config.confirmUnsubscribe !== false,
	notifyTitleChanges: config.notifyTitleChanges !== false,
	notifyChannelAdded: config.notifyChannelAdded !== false,
})

export const parseGeneralSettings = (value: unknown): GeneralSettings => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Settings must be an object.')
	}
	const data = value as Record<string, unknown>
	if (typeof data.emailOnError !== 'boolean') {
		throw new Error('Failure email setting must be boolean.')
	}
	return { initialBacklog: parseBacklogPolicy(data.initialBacklog,
		'initialBacklog'), videoRetentionDays: parseVideoRetentionDays(
		data.videoRetentionDays), emailOnError: data.emailOnError,
	activityRetentionDays: data.activityRetentionDays === undefined ? null :
		parseActivityRetentionDays(data.activityRetentionDays),
	confirmUnsubscribe: data.confirmUnsubscribe === undefined ? true :
		parseConfirmation(data.confirmUnsubscribe),
	notifyTitleChanges: data.notifyTitleChanges === undefined ? true :
		parseConfirmation(data.notifyTitleChanges),
	notifyChannelAdded: data.notifyChannelAdded === undefined ? true :
		parseConfirmation(data.notifyChannelAdded) }
}

const parseConfirmation = (value: unknown): boolean => {
	if (typeof value !== 'boolean') {
		throw new Error('Confirmation must be boolean.')
	}
	return value
}

export const saveGeneralSettings = async (
	filename: string, config: Config, input: unknown,
): Promise<void> => {
	const settings = parseGeneralSettings(input)
	const apply = () => {
		config.initialBacklog = settings.initialBacklog
		config.videoRetentionDays = settings.videoRetentionDays
		config.activityRetentionDays = settings.activityRetentionDays
		config.logging.emailOnError = settings.emailOnError
		config.confirmUnsubscribe = settings.confirmUnsubscribe
		config.notifyTitleChanges = settings.notifyTitleChanges
		config.notifyChannelAdded = settings.notifyChannelAdded
	}
	try { await updateJsonFile(filename, value => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Configuration must be an object.')
		}
		const current = value as Record<string, unknown>
		if (!current.logging || typeof current.logging !== 'object' ||
				Array.isArray(current.logging)) throw new Error('Logging is invalid.')
		return { ...current, initialBacklog: settings.initialBacklog,
			videoRetentionDays: settings.videoRetentionDays,
			activityRetentionDays: settings.activityRetentionDays,
			confirmUnsubscribe: settings.confirmUnsubscribe,
			notifyTitleChanges: settings.notifyTitleChanges,
			notifyChannelAdded: settings.notifyChannelAdded,
			logging: { ...current.logging, emailOnError: settings.emailOnError } }
	}) } catch (err) {
		// A replacement can succeed even if lock cleanup fails afterward.
		try {
			const stored = JSON.parse(await fs.readFile(filename, 'utf8'))
			const effective = parseGeneralSettings({
				initialBacklog: stored.initialBacklog,
				videoRetentionDays: stored.videoRetentionDays,
				activityRetentionDays: stored.activityRetentionDays,
				confirmUnsubscribe: stored.confirmUnsubscribe,
				notifyTitleChanges: stored.notifyTitleChanges,
				notifyChannelAdded: stored.notifyChannelAdded,
				emailOnError: stored.logging?.emailOnError })
			if (JSON.stringify(effective) === JSON.stringify(settings)) apply()
		} catch { console.warn('Could not verify saved general settings.') }
		throw err
	}
	apply()
}
