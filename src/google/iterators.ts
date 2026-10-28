import { youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { GaxiosResponse, GaxiosPromise, MethodOptions } from 'googleapis-common'

import setupLogger from '../lib/logger'


type SubscriptionsParams = youtube_v3.Params$Resource$Subscriptions$List
type SubscriptionsResult = youtube_v3.Schema$SubscriptionListResponse
type SubscriptionsItem = youtube_v3.Schema$Subscription


/**
 * Base iterator for aggregating data through paging. Continues until
 * `nextPageToken === undefined`.
 */

async function* _genericIterator(
	method: (
		params: SubscriptionsParams,
		options?: MethodOptions,
	) => GaxiosPromise<SubscriptionsResult>,
	params: SubscriptionsParams,
	options?: MethodOptions,
): AsyncIterable<Awaited<SubscriptionsItem>> {
	let nextPageToken = undefined
	const seenTokens = new Set<string>()
	let pages = 0

	const logger = await setupLogger({ label: 'iterator' })
	let itemsSeen = 0

	do {
		if (++pages > 1000) {
			throw new Error('Subscription page limit reached; snapshot not saved.')
		}

		// Call given method with given params
		const res: GaxiosResponse<SubscriptionsResult> =
			await method({ ...params, pageToken: nextPageToken }, options)

		if (!res.data || !Array.isArray(res.data.items)) {
			throw new Error('Invalid subscription page; snapshot not saved.')
		}
		itemsSeen += res.data.items?.length ?? 0

		logger.verbose('Got page of data', {
			resultsPerPage: res.data.pageInfo?.resultsPerPage,
			totalResults: res.data.pageInfo?.totalResults,
			itemsSeen,
			currentPageToken: nextPageToken,
			nextPageToken: res.data.nextPageToken,
		})

		nextPageToken = res.data.nextPageToken
		if (nextPageToken) {
			if (seenTokens.has(nextPageToken)) {
				throw new Error('Repeated subscription page token; snapshot not saved.')
			}
			seenTokens.add(nextPageToken)
		}

		// Yield all data entries
		yield* res.data.items ?? []

	} while (nextPageToken)
}

/**
 * Iterator for authorized account's subscriptions
 */

export const subscriptionIterator = (
	service: youtube_v3.Youtube,
	auth: OAuth2Client,
) =>
	_genericIterator(service.subscriptions.list.bind(service), {
		auth,
		part: ['snippet,contentDetails'],
		order: 'alphabetical',
		mine: true,
		maxResults: 50,
	})

/** Verify known channel IDs when a listing omits them. */
export const subscriptionMembershipIterator = (
	service: youtube_v3.Youtube, auth: OAuth2Client, channelIds: string[],
	options?: MethodOptions,
) => _genericIterator(service.subscriptions.list.bind(service), {
	auth, part: ['snippet,contentDetails'], mine: true, maxResults: 50,
	forChannelId: channelIds.join(','),
}, options)
