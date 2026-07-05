import winston from 'winston'

import { CONFIG_FILE } from '../config'

const { format, transports } = winston

// const join = format(info => ({
// 	...info,
// 	message: [ info.message, ...(info[Symbol.for('splat')] ?? []) ].join(' '),
// }))

const isObjectEmpty = (object: Object) => Object.keys(object).length === 0

const createLogger = async ({ label }: { label: string }) => {
	// Load config lazily here rather than at module import time, so importing
	// the logger (or anything that transitively imports it) does not eagerly
	// read config.json and produce a floating unhandled rejection.
	const config: any = await import(CONFIG_FILE)
	Error.stackTraceLimit = config.logging.stackTraceLimit

	return winston.createLogger({
		level: config.logging.level,
		transports: [
			new transports.Console(),
		],
		exitOnError: true,
		format: format.combine(
			// join(),
			format.label({ label }),
			format.timestamp(),
			format.colorize(),
			format.errors({ stack: true }),
			format.printf(({ timestamp, level, label, message, stack, ...rest }) => {
				return [
					`${timestamp} [${level}] [${label}]: ${message} `,
					isObjectEmpty(rest) ? '' : JSON.stringify(rest, null, '    '),
					stack ? `\n${stack}` : '',
				].join('')
			}),
		),
	})
}

export default createLogger
