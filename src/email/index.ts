import fs from 'fs/promises'
import path from 'path'

import ejs from 'ejs'
import nodemailer from 'nodemailer'
import SMTPTransport from 'nodemailer/lib/smtp-transport'

import { EmailConfig } from '../config'
import messages from './messages.en.json'
import { TitleAlert } from '../titleAlerts'
import { AddedChannel } from '../channelAddedAlerts'

export type SendVideoEmail =
	(props: ISendVideoEmail) => Promise<SMTPTransport.SentMessageInfo>

const loadTemplate = async (name: string) =>
	ejs.compile(await fs.readFile(
		path.join(__dirname, name),
		'utf-8',
	))

const safeChannelTitle = (value: string): string => [...value].map(char => {
	const code = char.charCodeAt(0)
	return code < 32 || code === 127 ? ' ' : char
}).join('').slice(0, 200)


export interface ISendVideoEmail {
	channelId: string,
	channelThumbnail: string,
	channelTitle: string,
	date: Date,
	isLiveStreamOrPremere: boolean,
	videoDuration: string,
	videoId: string,
	videoThumbnail: string,
	videoTitle: string,
	videoURL: string,
	cookieStale?: boolean,
}

export interface ISendErrorEmail {
	stack: string,
	message: string,
	subject?: string,
}

export const init = async (config: EmailConfig) => {
	const transporter = nodemailer.createTransport({ ...config,
		connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
	})
	const emailTemplate = await loadTemplate('./video-template.ejs')
	const errorTemplate = await loadTemplate('./error-template.ejs')

	// Send an email about a new upload
	// Has the video thumbnail, title, length, etc.
	const sendVideoEmail = ({ channelTitle, date, cookieStale = false,
		...rest }: ISendVideoEmail) =>
		transporter.sendMail({
			from: config.sendingContact,
			to: config.destination,
			subject: `${channelTitle} just uploaded a video`,
			date,
			headers: {
				'Date': date.toUTCString(),
			},
			html: emailTemplate({ channelTitle, cookieStale, messages, ...rest }),
		})

	// Notify about an error with the software
	const sendErrorEmail = (error: ISendErrorEmail) =>
		transporter.sendMail({
			from: config.sendingContact,
			to: config.destination,
			subject: error.subject ?? 'BBYEN encountered and error',
			html: errorTemplate({ error }),
		})
	const sendTestEmail = () => transporter.sendMail({
		from: config.sendingContact, to: config.destination,
		subject: 'BBYEN test email',
		text: 'Your BBYEN email delivery settings are working.',
	})
	const sendTitleAlert = (alert: TitleAlert) => transporter.sendMail({
		from: config.sendingContact, to: config.destination,
		subject: messages.titleSubject,
		text: `${messages.titlePrevious}: ${alert.previousTitle}\n` +
			`${messages.titleCurrent}: ${alert.currentTitle}\n` +
			`https://www.youtube.com/channel/${alert.channelId}` +
			(alert.cookieStale ? `\n\n${messages.cookieStale}` : ''),
	})
	const sendChannelAdded = (channels: AddedChannel[], cookieStale = false) =>
		transporter.sendMail({
			from: config.sendingContact, to: config.destination,
			subject: messages.channelAddedSubject,
			text: `${messages.channelAddedIntro}\n\n` + channels.map(channel =>
				`${safeChannelTitle(channel.title)}\n` +
				'https://www.youtube.com/channel/' +
				channel.channelId).join('\n\n') +
				(cookieStale ? `\n\n${messages.cookieStale}` : ''),
		})

	return { sendVideoEmail, sendErrorEmail, sendTestEmail, sendTitleAlert,
		sendChannelAdded }
}
