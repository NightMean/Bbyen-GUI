import { describe, test, expect } from 'vitest'
import {
	generateSapisidHash,
	normalizeCookieHeader,
	extractSapisidFromCookie,
	parseChannelRenderer,
	extractChannelsFromInnerTube,
	parseAccountsListResponse,
} from './innertubeChannels'

describe('generateSapisidHash', () => {
	test('generates expected hash format with sha1', () => {
		const ts = 1700000000000
		const sapisid = 'test_sapisid_value'
		const hash = generateSapisidHash(
			sapisid,
			'https://www.youtube.com',
			ts,
		)
		expect(hash).toBe(
			'SAPISIDHASH 1700000000000_5c698170a8b6cd0a009c5d2939d3ed209bcb817b',
		)
	})
})

describe('normalizeCookieHeader', () => {
	test('converts JSON cookie array to header string', () => {
		const json = JSON.stringify([
			{ name: 'SAPISID', value: 'sap123' },
			{ name: 'LOGIN_INFO', value: 'log456' },
		])
		expect(normalizeCookieHeader(json)).toBe(
			'SAPISID=sap123; LOGIN_INFO=log456',
		)
	})

	test('converts Netscape cookie format to header string', () => {
		const netscape =
			'.youtube.com\tTRUE\t/\tTRUE\t1800000000\tSAPISID\tsap999\n' +
			'.youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tsid111\n'
		expect(normalizeCookieHeader(netscape)).toBe(
			'SAPISID=sap999; SID=sid111',
		)
	})

	test('preserves already formatted cookie header', () => {
		const header = 'SAPISID=sap123; SID=sid456'
		expect(normalizeCookieHeader(header)).toBe(header)
	})
})

describe('extractSapisidFromCookie', () => {
	test('extracts SAPISID from cookie header', () => {
		const cookie = 'VISITOR_INFO1_LIVE=abc; SAPISID=my_sapisid; LOGIN_INFO=xyz'
		expect(extractSapisidFromCookie(cookie)).toBe('my_sapisid')
	})

	test('extracts __Secure-3PAPISID from JSON cookie array', () => {
		const json = JSON.stringify([
			{ name: 'PREF', value: 'val' },
			{ name: '__Secure-3PAPISID', value: 'secure_sap' },
		])
		expect(extractSapisidFromCookie(json)).toBe('secure_sap')
	})

	test('returns null when neither is present', () => {
		const cookie = 'VISITOR_INFO1_LIVE=abc; YSC=123'
		expect(extractSapisidFromCookie(cookie)).toBeNull()
	})
})

describe('parseChannelRenderer', () => {
	test('identifies ALL notifications from NOTIFICATIONS_ACTIVE icon', () => {
		const channel = {
			channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
			title: { simpleText: 'Google Developers' },
			subscribeButton: {
				subscribeButtonRenderer: {
					notificationPreferenceButton: {
						subscriptionNotificationToggleButtonRenderer: {
							currentStateId: 2,
							states: [
								{
									stateId: 2,
									state: {
										buttonRenderer: {
											icon: {
												iconType: 'NOTIFICATIONS_ACTIVE',
											},
											accessibility: {
												label: 'Current setting is all notifications.',
											},
										},
									},
								},
							],
						},
					},
				},
			},
		}

		const parsed = parseChannelRenderer(channel)
		expect(parsed).not.toBeNull()
		expect(parsed?.channelId).toBe('UC_x5XG1OV2P6uZZ5FSM9Ttw')
		expect(parsed?.title).toBe('Google Developers')
		expect(parsed?.isAllNotifications).toBe(true)
		expect(parsed?.notificationState).toBe('all')
	})

	test('identifies personalized notifications', () => {
		const channel = {
			channelId: 'UCzgA9CBrIXPtkB2yNTTiy1w',
			title: { runs: [{ text: 'Level2Jeff' }] },
			subscribeButton: {
				subscribeButtonRenderer: {
					notificationPreferenceButton: {
						subscriptionNotificationToggleButtonRenderer: {
							currentStateId: 3,
							states: [
								{
									stateId: 3,
									state: {
										buttonRenderer: {
											icon: {
												iconType: 'NOTIFICATIONS_NONE',
											},
											accessibility: {
												label: 'Current setting is personalized.',
											},
										},
									},
								},
							],
						},
					},
				},
			},
		}

		const parsed = parseChannelRenderer(channel)
		expect(parsed?.isAllNotifications).toBe(false)
		expect(parsed?.notificationState).toBe('personalized')
	})
})

describe('extractChannelsFromInnerTube', () => {
	const bellKey = 'subscriptionNotificationToggleButtonRenderer'

	test('walks nested browse response and extracts channels and token', () => {
		const payload = {
			contents: {
				twoColumnBrowseResultsRenderer: {
					tabs: [
						{
							tabRenderer: {
								content: {
									sectionListRenderer: {
										contents: [
											{
												itemSectionRenderer: {
													contents: [
														{
															shelfRenderer: {
																content: {
																	expandedShelfContentsRenderer: {
																		items: [
																			{
																				channelRenderer: {
																					channelId: 'UC1',
																					title: { simpleText: 'Ch 1' },
																					subscriptionButton: {
																						[bellKey]: { currentStateId: 1 },
																					},
																				},
																			},
																			{
																				channelRenderer: {
																					channelId: 'UC2',
																					title: { simpleText: 'Ch 2' },
																					subscriptionButton: {
																						[bellKey]: { currentStateId: 2 },
																					},
																				},
																			},
																		],
																	},
																},
															},
														},
													],
												},
											},
										],
									},
								},
							},
						},
					],
				},
			},
			continuationEndpoint: {
				continuationCommand: {
					token: 'token_abc123',
				},
			},
		}

		const result = extractChannelsFromInnerTube(payload)
		expect(result.channels).toHaveLength(2)
		expect(result.channels[0].channelId).toBe('UC1')
		expect(result.channels[0].isAllNotifications).toBe(true)
		expect(result.channels[1].channelId).toBe('UC2')
		expect(result.channels[1].isAllNotifications).toBe(false)
		expect(result.continuationToken).toBe('token_abc123')
	})
})

describe('parseAccountsListResponse', () => {
	test('extracts personal and brand accounts with pageIds', () => {
		const payload = {
			actions: [
				{
					getMultiPageMenuAction: {
						menu: {
							multiPageMenuRenderer: {
								sections: [
									{
										accountSectionListRenderer: {
											contents: [
												{
													accountItemSectionRenderer: {
														contents: [
															{
																accountItem: {
																	accountName: {
																		simpleText: 'User Primary',
																	},
																	channelHandle: {
																		simpleText: '@userprimary',
																	},
																	isSelected: true,
																	serviceEndpoint: {
																		selectActiveIdentityEndpoint: {
																			supportedTokens: [
																				{
																					accountStateToken: {
																						hasChannel: true,
																					},
																				},
																			],
																		},
																	},
																},
															},
															{
																accountItem: {
																	accountName: {
																		simpleText: 'BrandChannel',
																	},
																	channelHandle: {
																		simpleText: '@brandch',
																	},
																	isSelected: false,
																	serviceEndpoint: {
																		selectActiveIdentityEndpoint: {
																			supportedTokens: [
																				{
																					pageIdToken: {
																						pageId: '123456789012345678901',
																					},
																				},
																			],
																		},
																	},
																},
															},
														],
													},
												},
											],
										},
									},
								],
							},
						},
					},
				},
			],
		}

		const profiles = parseAccountsListResponse(payload)
		expect(profiles).toHaveLength(2)
		expect(profiles[0]).toEqual({
			accountName: 'User Primary',
			channelHandle: '@userprimary',
			isSelected: true,
			pageId: undefined,
		})
		expect(profiles[1]).toEqual({
			accountName: 'BrandChannel',
			channelHandle: '@brandch',
			isSelected: false,
			pageId: '123456789012345678901',
		})
	})
})

