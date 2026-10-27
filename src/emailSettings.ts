import { Config } from './config'
import { updateJsonFile } from './lib/jsonFile'

export interface PublicEmailSettings {
	host: string,
	port: number,
	secure: boolean,
	sendingContact: string,
	destination: string,
}

const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Expected a configuration object.')
	}
	return value as Record<string, unknown>
}

const safeText = (value: unknown, max: number): string => {
	if (typeof value !== 'string' || !value.trim() || value.length > max ||
			/[\r\n\0]/.test(value)) throw new Error('Invalid email setting.')
	return value.trim()
}

export const parseEmailSettings = (value: unknown): PublicEmailSettings => {
	const data = record(value)
	if (typeof data.port !== 'number' || !Number.isInteger(data.port) ||
			data.port < 1 || data.port > 65535 || typeof data.secure !== 'boolean') {
		throw new Error('Invalid SMTP port or secure setting.')
	}
	return { host: safeText(data.host, 253), port: data.port, secure: data.secure,
		sendingContact: safeText(data.sendingContact, 512),
		destination: safeText(data.destination, 512) }
}

export const publicEmailSettings = (config: Config): PublicEmailSettings => ({
	host: config.email.host, port: config.email.port, secure: config.email.secure,
	sendingContact: config.email.sendingContact,
	destination: config.email.destination,
})

export const saveEmailSettings = async (
	filename: string, config: Config, value: unknown,
): Promise<void> => {
	const settings = parseEmailSettings(value)
	await updateJsonFile(filename, current => {
		const general = record(current)
		return { ...general, email: { ...record(general.email), ...settings } }
	})
	config.email = { ...config.email, ...settings }
}

export const parseEmailCredentials = (
	value: unknown,
	env: NodeJS.ProcessEnv = process.env,
): { user?: string, pass?: string } => {
	const input = record(value)
	const user = input.user === undefined ? undefined : safeText(input.user, 512)
	let pass: string | undefined
	if (input.pass !== undefined) {
		if (typeof input.pass !== 'string' || !input.pass.length ||
				input.pass.length > 4096) throw new Error('Invalid email credential.')
		pass = input.pass
	}
	if ((!user && !pass) || (user && env.BBYEN_EMAIL_USER !== undefined) ||
			(pass && env.BBYEN_EMAIL_PASS !== undefined)) {
		throw new Error('Credential is missing or controlled by the environment.')
	}
	return { user, pass }
}

export const saveEmailCredentials = async (
	filename: string, value: unknown,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
	const { user, pass } = parseEmailCredentials(value, env)
	await updateJsonFile(filename, current => {
		const secrets = record(current)
		const email = secrets.email === undefined ? {} : record(secrets.email)
		const auth = email.auth === undefined ? {} : record(email.auth)
		return { ...secrets, email: { ...email, auth: { ...auth,
			...(user ? { user } : {}), ...(pass ? { pass } : {}),
		} } }
	}, { createIfMissing: true })
}
