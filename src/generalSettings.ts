import { Config, parseVideoViewDays } from './config'
import fs from 'fs/promises'
import { BacklogPolicy, parseBacklogPolicy } from './initialBacklog'
import { updateJsonFile } from './lib/jsonFile'
import { parseVideoRetentionDays } from './videoRetention'
import { parseActivityRetentionDays } from './activityRetention'
import { EmailSelectionPolicy, parseEmailSelectionPolicy } from './emailPolicy'

export interface GeneralSettings {
	initialBacklog: BacklogPolicy,
	videoRetentionDays: number | null,
	videoViewDays: number,
	emailSelectionPolicy: EmailSelectionPolicy | null,
	activityRetentionDays: number | null,
	emailOnError: boolean,
	confirmUnsubscribe: boolean,
	notifyTitleChanges: boolean,
	notifyChannelAdded: boolean,
	notifyFailureReminders: boolean,
	notifyRecoveries: boolean,
}

export const readGeneralSettings = (config: Config): GeneralSettings => ({
	initialBacklog: config.initialBacklog ??
		{ mode: config.notifyOnFirstScan ? 'all' : 'none' },
	videoRetentionDays: config.videoRetentionDays ?? null,
	videoViewDays: config.videoViewDays ?? 7,
	emailSelectionPolicy: config.emailSelectionPolicy ?? null,
	activityRetentionDays: config.activityRetentionDays ?? null,
	emailOnError: config.logging.emailOnError,
	confirmUnsubscribe: config.confirmUnsubscribe !== false,
	notifyTitleChanges: config.notifyTitleChanges !== false,
	notifyChannelAdded: config.notifyChannelAdded !== false,
	notifyFailureReminders: config.notifyFailureReminders === true,
	notifyRecoveries: config.notifyRecoveries === true,
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
	videoViewDays: data.videoViewDays === undefined ? 7 :
		parseVideoViewDays(data.videoViewDays),
	emailSelectionPolicy: data.emailSelectionPolicy == null ? null :
		parseEmailSelectionPolicy(data.emailSelectionPolicy),
	activityRetentionDays: data.activityRetentionDays === undefined ? null :
		parseActivityRetentionDays(data.activityRetentionDays),
	confirmUnsubscribe: data.confirmUnsubscribe === undefined ? true :
		parseConfirmation(data.confirmUnsubscribe),
	notifyTitleChanges: data.notifyTitleChanges === undefined ? true :
		parseConfirmation(data.notifyTitleChanges),
	notifyChannelAdded: data.notifyChannelAdded === undefined ? true :
		parseConfirmation(data.notifyChannelAdded),
	notifyFailureReminders: data.notifyFailureReminders === undefined ? false :
		parseConfirmation(data.notifyFailureReminders),
	notifyRecoveries: data.notifyRecoveries === undefined ? false :
		parseConfirmation(data.notifyRecoveries) }
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
		config.videoViewDays = settings.videoViewDays
		config.emailSelectionPolicy = settings.emailSelectionPolicy ?? undefined
		config.activityRetentionDays = settings.activityRetentionDays
		config.logging.emailOnError = settings.emailOnError
		config.confirmUnsubscribe = settings.confirmUnsubscribe
		config.notifyTitleChanges = settings.notifyTitleChanges
		config.notifyChannelAdded = settings.notifyChannelAdded
		config.notifyFailureReminders = settings.notifyFailureReminders
		config.notifyRecoveries = settings.notifyRecoveries
	}
	try { await updateJsonFile(filename, value => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Configuration must be an object.')
		}
		const current = value as Record<string, unknown>
		if (current.emailSelectionPolicy !== config.emailSelectionPolicy) {
			throw new Error('Email selection changed; reload settings and retry.')
		}
		if (!current.logging || typeof current.logging !== 'object' ||
				Array.isArray(current.logging)) throw new Error('Logging is invalid.')
		return { ...current, initialBacklog: settings.initialBacklog,
			videoRetentionDays: settings.videoRetentionDays,
			videoViewDays: settings.videoViewDays,
			...(settings.emailSelectionPolicy ?
				{ emailSelectionPolicy: settings.emailSelectionPolicy } : {}),
			activityRetentionDays: settings.activityRetentionDays,
			confirmUnsubscribe: settings.confirmUnsubscribe,
			notifyTitleChanges: settings.notifyTitleChanges,
			notifyChannelAdded: settings.notifyChannelAdded,
			notifyFailureReminders: settings.notifyFailureReminders,
			notifyRecoveries: settings.notifyRecoveries,
			logging: { ...current.logging, emailOnError: settings.emailOnError } }
	}) } catch (err) {
		// A replacement can succeed even if lock cleanup fails afterward.
		try {
			const stored = JSON.parse(await fs.readFile(filename, 'utf8'))
			const effective = parseGeneralSettings({
				initialBacklog: stored.initialBacklog,
				videoRetentionDays: stored.videoRetentionDays,
				videoViewDays: stored.videoViewDays,
				emailSelectionPolicy: stored.emailSelectionPolicy,
				activityRetentionDays: stored.activityRetentionDays,
				confirmUnsubscribe: stored.confirmUnsubscribe,
				notifyTitleChanges: stored.notifyTitleChanges,
				notifyChannelAdded: stored.notifyChannelAdded,
				notifyFailureReminders: stored.notifyFailureReminders,
				notifyRecoveries: stored.notifyRecoveries,
				emailOnError: stored.logging?.emailOnError })
			if (JSON.stringify(effective) === JSON.stringify(settings)) apply()
		} catch { console.warn('Could not verify saved general settings.') }
		throw err
	}
	apply()
}
