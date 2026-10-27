import { describe, test, expect, vi } from 'vitest'
import axios from 'axios'
import {
	generateSapisidHash,
	normalizeCookieHeader,
	extractSapisidFromCookie,
	parseChannelRenderer,
	extractChannelsFromInnerTube,
	parseAccountsListResponse,
	buildModifyChannelPreferenceParams,
	extractBellActionParams,
	subscribeToChannel,
	unsubscribeFromChannel,
	setChannelNotificationPreference,
	fetchAccountsList,
} from './innertubeChannels'
import { CookieSessionError } from './cookieSessionError'
import { classifyError } from './classifyError'

describe('generateSapisidHash', () => {
	test('uses Unix seconds for automatically generated timestamps', () => {
		const now = vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
		try {
			const hash = generateSapisidHash('synthetic-fixture')
			expect(hash.split(' ')[1].split('_')[0]).toBe('1700000000')
		} finally {
			now.mockRestore()
		}
	})

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

	test('filters domains and handles HttpOnly Netscape entries', () => {
		const json = JSON.stringify([
			{ domain: '.youtube.com', path: '/', name: 'SID', value: 'fixture' },
			{ domain: '.other.test', path: '/', name: 'PRIVATE', value: 'fixture' },
			{ domain: 'youtube.com.other.test', path: '/', name: 'BAD',
				value: 'fixture' },
			{ domain: '.youtube.com', path: '/other', name: 'PATH',
				value: 'fixture' },
		])
		expect(normalizeCookieHeader(json)).toBe('SID=fixture')
		const file = '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfixture\n' +
			'.other.test\tTRUE\t/\tTRUE\t0\tPRIVATE\tfixture\n'
		expect(normalizeCookieHeader(file)).toBe('SID=fixture')
	})

	test('rejects malformed JSON and header injection', () => {
		expect(() => normalizeCookieHeader('[invalid')).toThrow()
		expect(() => normalizeCookieHeader('SID=fixture\r\nOther: value')).toThrow()
	})
})

test('classifies a logged-out profile response as auth failure', async () => {
	vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { responseContext: {
		mainAppWebResponseContext: { loggedOut: true },
	} } })
	try {
		await expect(fetchAccountsList('SID=synthetic-fixture', 'fixture'))
			.rejects.toBeInstanceOf(CookieSessionError)
		expect(classifyError(new CookieSessionError('fixture'))).toBe('auth')
	} finally { vi.restoreAllMocks() }
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

describe('buildModifyChannelPreferenceParams', () => {
	test('encodes all notifications parameter', () => {
		const encoded = buildModifyChannelPreferenceParams(
			'UCheBKArlttOQt_t5zgFUw_Q',
			'all',
		)
		expect(encoded).toBe('ChhVQ2hlQktBcmx0dE9RdF90NXpnRlV3X1ESAggCGAAgBA==')
	})

	test('encodes personalized notifications parameter', () => {
		const encoded = buildModifyChannelPreferenceParams(
			'UCheBKArlttOQt_t5zgFUw_Q',
			'personalized',
		)
		expect(Buffer.from(encoded, 'base64').subarray(26))
			.toEqual(Buffer.from([0x12, 2, 8, 1, 0x18, 0, 0x20, 4]))
	})

	test('encodes none notifications parameter', () => {
		const encoded = buildModifyChannelPreferenceParams(
			'UCheBKArlttOQt_t5zgFUw_Q',
			'none',
		)
		expect(Buffer.from(encoded, 'base64').subarray(26))
			.toEqual(Buffer.from([0x12, 2, 8, 3, 0x18, 0, 0x20, 4]))
	})

	test('rejects invalid channel IDs and preference values', () => {
		expect(() => buildModifyChannelPreferenceParams('bad-id', 'all'))
			.toThrow()
		expect(() => buildModifyChannelPreferenceParams(
			'UCheBKArlttOQt_t5zgFUw_Q', 'invalid' as never,
		)).toThrow()
	})
})

describe('subscribeToChannel & unsubscribeFromChannel', () => {
	test('sends subscribe request with auth and channel ID', async () => {
		const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
			data: { actions: [{ openPopupAction: {} }] },
		})

		const result = await subscribeToChannel(
			'SAPISID=test_sapisid',
			'test_sapisid',
			'UC1234567890123456789012',
		)

		expect(result).toEqual({ actions: [{ openPopupAction: {} }] })
		expect(postSpy).toHaveBeenCalledWith(
			'https://www.youtube.com/youtubei/v1/subscription/subscribe',
			expect.objectContaining({
				channelIds: ['UC1234567890123456789012'],
			}),
			expect.objectContaining({
				headers: expect.objectContaining({
					Cookie: 'SAPISID=test_sapisid',
					Authorization: expect.stringContaining('SAPISIDHASH'),
				}),
			}),
		)
		postSpy.mockRestore()
	})

	test(
		'sends subscribe with Brand Account pageId headers and body',
		async () => {
			const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
				data: { actions: [] },
			})

			await subscribeToChannel(
				'SAPISID=test_sapisid',
				'test_sapisid',
				'UC1234567890123456789012',
				'999888777666',
			)

			expect(postSpy).toHaveBeenCalledWith(
				'https://www.youtube.com/youtubei/v1/subscription/subscribe',
				expect.objectContaining({
					context: expect.objectContaining({
						user: { onBehalfOfUser: '999888777666' },
					}),
					channelIds: ['UC1234567890123456789012'],
				}),
				expect.objectContaining({
					headers: expect.objectContaining({
						'X-Goog-PageId': '999888777666',
						'X-Goog-AuthUser': '0',
					}),
				}),
			)
			postSpy.mockRestore()
		},
	)

	test('sends unsubscribe request', async () => {
		const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
			data: { actions: [] },
		})

		await unsubscribeFromChannel(
			'SAPISID=test_sapisid',
			'test_sapisid',
			'UC1234567890123456789012',
		)

		expect(postSpy).toHaveBeenCalledWith(
			'https://www.youtube.com/youtubei/v1/subscription/unsubscribe',
			expect.objectContaining({
				channelIds: ['UC1234567890123456789012'],
			}),
			expect.any(Object),
		)
		postSpy.mockRestore()
	})
})

describe('YouTube bell actions', () => {
	const channelId = 'UC0000000000000000000002'
	const action = (id: string, pref: 'all' | 'none') => {
		const prefix = Buffer.from(buildModifyChannelPreferenceParams(id, pref),
			'base64')
		return encodeURIComponent(Buffer.concat([prefix, Buffer.from([0x2a, 0])])
			.toString('base64'))
	}
	const renderer = (id: string, token: string) => ({ channelRenderer: {
		channelId: id, nested: { menuServiceItemRenderer: {
			icon: { iconType: 'NOTIFICATIONS_ACTIVE' },
			serviceEndpoint: { modifyChannelNotificationPreferenceEndpoint: {
				params: token,
			} },
		} },
	} })
	test('uses only the requested channel and matching preference', () => {
		const token = action(channelId, 'all')
		const other = 'UC0000000000000000000003'
		const data = [renderer(other, action(other, 'all')),
			renderer(channelId, token)]
		expect(extractBellActionParams(data, channelId, 'all')).toBe(token)
		expect(extractBellActionParams(data, channelId, 'none')).toBeNull()
		expect(extractBellActionParams(renderer(channelId, action(other, 'all')),
			channelId, 'all')).toBeNull()
		expect(extractBellActionParams(renderer(channelId, '%invalid'),
			channelId, 'all')).toBeNull()
	})
	test('rejects conflicting tokens and a disabled bell', () => {
		const first = action(channelId, 'all')
		const second = encodeURIComponent(Buffer.concat([
			Buffer.from(decodeURIComponent(first), 'base64'), Buffer.from([1]),
		]).toString('base64'))
		expect(() => extractBellActionParams([
			renderer(channelId, first), renderer(channelId, second),
		], channelId, 'all')).toThrow(/conflicting/i)
		expect(extractBellActionParams({ channelRenderer: {
			channelId, subscriptionButton: { disabled: true },
		} }, channelId, 'all')).toBeNull()
	})
})

describe('setChannelNotificationPreference', () => {
	test('sends the profile-bound action unchanged', async () => {
		const post = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: {} })
		try {
			await setChannelNotificationPreference('SAPISID=fixture', 'fixture',
				'UC0000000000000000000002', 'all', 'brand', 'opaque-action')
			const [, body, options] = post.mock.calls[0]
			expect((body as any).params).toBe('opaque-action')
			expect((body as any).context.user.onBehalfOfUser).toBe('brand')
			expect((options as any).headers['X-Goog-PageId']).toBe('brand')
		} finally { post.mockRestore() }
	})

	test(
		'sends modify_channel_preference request with encoded params',
		async () => {
			const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
				data: { actions: [] },
			})

			await setChannelNotificationPreference(
				'SAPISID=test_sapisid',
				'test_sapisid',
				'UCheBKArlttOQt_t5zgFUw_Q',
				'all',
			)

			expect(postSpy).toHaveBeenCalledWith(
				'https://www.youtube.com/youtubei/v1/notification/' +
					'modify_channel_preference',
				expect.objectContaining({
					params:
						'ChhVQ2hlQktBcmx0dE9RdF90NXpnRlV3X1ESAggCGAAgBA==',
				}),
				expect.objectContaining({
					headers: expect.objectContaining({
						Cookie: 'SAPISID=test_sapisid',
						Authorization: expect.stringContaining('SAPISIDHASH'),
					}),
				}),
			)
			postSpy.mockRestore()
		},
	)
})


