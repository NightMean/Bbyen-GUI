# Bring Back YouTube Email Notifications!

[Homepage](https://github.com/MarcelRobitaille/bbyen)

## Why?

In August 2020, YouTube removed the feature of sending email notifications when a subscriber uploads a video. Many watchers, myself included, prefer email notifications to app notifications. Here are some reasons why email notifications so great:

- Save videos for later
- Delete emails of videos you never want to watch
- Define filtering rules to automatically delete certain emails
- YouTube has been known to not always send notifications for all subscribers

This project aims to provide a replacement to YouTube's email notifications. Running this small program checks all your subscribers and sends emails with the links to new videos.

## How it works

It uses the [YouTube Data API](https://developers.google.com/youtube/v3/) to get a list of your subscribers and uses [RSS feeds](https://support.google.com/youtube/answer/6224202?hl=en) to get each channel's recent uploads. A database of videos for which an email has already been sent is kept in order to not notify about the same video twice. To send emails, the program connects to an email account through SMTP.

## Requirements

- [Docker](https://www.docker.com/)

or

- [node.js](https://nodejs.org/en/) >= 16 (20 recommended)
- [git](https://git-scm.com/) (used during setup to download the project)

## Installation and setup

There are two methods to run this software.
You may run it on bare metal, or take advantage of the Docker image published to Docker Hub.

### Bare metal

1. Download the source code

	```
	git clone https://github.com/MarcelRobitaille/bbyen.git
	```

1. Download packages

	```
	npm install --production
	```

1. Copy the template configuration files
	```
	cp config.example.json config.json
	cp channels.example.json channels.json
	cp secrets.example.json secrets.json
	```

1. [Perform the initial configuration](#initial-configuration)

### Docker

1. Create an empty folder on your computer
	```
	mkdir -p ~/docker/bbyen
	cd ~/docker/bbyen
	```
1. Copy the `docker-compose.yml` from this repository to that folder
	```
	wget https://raw.githubusercontent.com/MarcelRobitaille/bbyen/master/docker-compose.yml
	```
1. Copy the configuration file templates
	```
	wget https://raw.githubusercontent.com/MarcelRobitaille/bbyen/master/config.example.json \
	  -O config.json
	wget https://raw.githubusercontent.com/MarcelRobitaille/bbyen/master/channels.example.json \
	  -O channels.json
	wget https://raw.githubusercontent.com/MarcelRobitaille/bbyen/master/secrets.example.json \
	  -O secrets.json
	```
1. [Perform the initial configuration](#initial-configuration)

## Initial Configuration

After installing the software using either the bare metal or Docker method,
it is mandatory to configure certain values and to set up Google API credentials.

1. Populate the configuration files

	The configuration is split across three files:

	- **`config.json`** — general settings. Update `email.host`,
	  `email.sendingContact`, and `email.destination` (the address where videos
	  are sent). Optionally change `timers.subscriptions` and `timers.videos` to
	  configure how often subscriptions are updated and videos are checked.
	  `notifyOnFirstScan` (default `true`) controls whether a newly added
	  channel's existing videos are emailed on the first scan; set it to `false`
	  to record them silently and only be notified about videos published after
	  that first scan. `mode` selects how channels are discovered — see
	  [Operating modes](#operating-modes).

	- **`secrets.json`** — email credentials (`email.auth.user` and
	  `email.auth.pass`). Alternatively, set the environment variables
	  `BBYEN_EMAIL_USER` and `BBYEN_EMAIL_PASS`, which take precedence over the
	  file. If both env vars are set, `secrets.json` is not required.
	  Existing inline `config.json` credentials remain supported as a fallback;
	  separate secrets and environment variables take precedence.

	- **`channels.json`** — the channel whitelist / blacklist. See
	  [Channel Whitelist and Blacklist](#channel-whitelist-and-blacklist).

1. Set up Google API credentials

	The credentials have to be made on your personal account. This is the source of your subscriptions.

	1. Go to https://console.developers.google.com and create a new project

	1. Go to https://console.developers.google.com/apis/credentials and create OAuth 2.0 Client credentials

		1. Click "Create Credentials" and then "OAuth client ID"
		![Create Credentials Options](./docs/oauth_create_credentials.png)

		1. Select "Desktop app" for "Application type"
		![Create Credentials Application Type](./docs/oauth_application_type.png)

		1. Click "Create"

	1. Click the download button next to the new OAuth 2.0 Client ID.
	Download the credentials JSON file and save it as `google-credentials.json` in the folder where you downloaded the project.
	![OAuth Credentials Download](./docs/oauth_download.png)

	1. Go to https://console.developers.google.com/apis/library, search for and click "YouTube Data API v3", and enable this api.

## Running

### Bare Metal

```
npm start
```

### Docker
```
sudo docker-compose up
```

## Operating modes

Run `npm run setup` to choose how the app discovers channels; it writes `mode`
to `config.json`.

- **youtube** (default) — logs into your Google account (OAuth), auto-detects
  your subscriptions, and fetches full video metadata (duration, livestream
  filtering). Re-authenticate any time with `npm run login`.
- **whitelist** — no login. You list the channels yourself in `channels.json`
  using channel IDs (`UC...`), handles (`@name`), or channel URLs. On startup,
  any URLs or handles are automatically resolved to canonical 24-character IDs
  without requiring an API key. Emails omit the duration badge and do not filter
  livestreams (every new upload notifies). Good for a headless setup where you
  don't want to grant YouTube access.

## Authentication

Run `npm run setup` (or `npm run login` to re-authenticate in youtube mode).
On the first login you will authenticate the app, tying it to your Google
account (the subscriptions will come from whatever account you use):
1. A browser window should open automatically. If not, or if the system is headless, the URL will be printed in the console. Copy/paste it into a new tab.
1. Follow the instructions on this page.
1. You may have to click "Advanced" and "Got to bbyen (unsafe)". This is because the app hasn't been verified, but the server is trustworthy (you are running it).
1. After authenticating in the website, Google should automatically redirect you to your server, which will transfer the authentication code. In this case you will see a message "Authorization successful. You may now close this tab.".
If this does not work (if you see "Unable to connect"), please copy/paste the URL from the browser address bar into the console.

Normal runs (`npm start`) never launch the browser: in youtube mode, if the
stored token is missing or expired, the app sends an alert email and exits
rather than blocking. Run `npm run login` to re-authenticate.

## Failure alerts

When a backend run fails — YouTube authentication, API quota, or any other
error — the app emails you once per issue (repeats are suppressed until the
problem clears and recurs). This is gated by `logging.emailOnError` in
`config.json`.
Video API, RSS, and email delivery failures participate in this reporting.
A successful unrelated task does not reset suppression: affected tasks must
recover before a recurrence triggers another alert.

## Advanced Configuration

### Channel Whitelist and Blacklist

In some instances, you may want to stop receiving notifications from a list of channels (blacklist)
or only receive notifications from a list of channels (whitelist).

While the official YouTube Data API does not expose notification bell preferences, `bbyen` includes a built-in synchronizer that extracts only the channels where your bell is set to **"All"** (🔔) using session cookies.

#### Auto-Syncing "All" Bell Channels (`sync-channels`)

Export your session cookies from your browser (via Cookie-Editor or Netscape format) to `cookies.txt` in the `bbyen` directory, then run:

```bash
# Preview channels with "All" notification bell
npm run sync-channels

# Save to channels.json and track bell history in SQLite
npm run sync-channels -- --save

# List all account profiles (personal & Brand Accounts)
npm run sync-channels -- --list-accounts

# Target a specific Brand Account or profile
npm run sync-channels -- --account "YourChannelName" --save
```

Bell observation records do not activate email monitoring by themselves.
History records every observed bell state, including changes from All to
Personalized or None. Saving imports All channels into the whitelist and keeps
existing entries; it does not remove manually configured channels.
Restart the service after saving channel changes so it reloads the whitelist.
`firstObservedAt` records the first local observation, not the date you
subscribed on YouTube. Existing databases with no observation timestamp use
the upgrade time; previously recorded timestamps are preserved.

Saving merges channels by ID and preserves per-channel preferences and the
blacklist. Malformed files stop the operation without being overwritten.
Normal service startup requires `channels.json`; a missing file never silently
removes channel restrictions. Setup and sync may explicitly create this file.
The service, setup, sync, and Python companion use an adjacent `.lock` file
to prevent competing edits and replace JSON files atomically. A busy editor
fails clearly; retry after it finishes. If a process crashes, the lock contains
its process ID. Verify that process has stopped before deleting the lock and
retrying. The original JSON remains usable if a write fails before replacement.
If SQLite recording fails after the whitelist was saved, sync reports that
partial result and exits unsuccessfully. Retry after correcting the database
error; whitelist merging and database upserts are safe to repeat.

You can use the keys `blacklistedChannelIds` and `whitelistedChannelIds` in `channels.json`.
These should be arrays of the channels you want to include/exclude.
For example:
```json
{
	"blacklistedChannelIds": [ "xxx", "yyy" ],
	"whitelistedChannelIds": [ "zzz" ]
}
```
If the key `whitelistedChannelIds` is present, notifications will only be sent for those channels.
If `blacklistedChannelIds` is present, any notifications that would be sent for channels are skipped.

#### Per-channel settings

A whitelist entry may be a plain channel ID string, or an object that carries
per-channel settings:

```json
{
	"whitelistedChannelIds": [
		"UCcUNYFu8wNDncymesUOtPrg",
		{ "id": "UCVekgNuouyp2rpGLMEoWddA", "notify": false },
		{ "id": "UCmZdjVse4X2fGwUrIT1cnog", "notifyOnFirstScan": false }
	]
}
```

- **`notify`** (default `true`) — set to `false` to *mute* a channel. Its videos
  are still tracked in the database, but no email is sent. This is useful for
  keeping a channel's history without receiving notifications.
- **`notifyOnFirstScan`** — overrides the global `notifyOnFirstScan` for this
  channel. Set to `false` to record the channel's existing videos silently when
  it is first added and only be notified about newer videos.

The channel ID is usually at the end of the URL of the channel's page.
However, sometimes this is not the true ID but some customized shorter and readable string.
In this case, you may:
- Paste the entire channel page URL into the config. Note that the next time you run the software, this will be replaced with the channel ID so this conversion only has to happen once (it uses the API so there is a small cost to this).
- Run `copy(window.ytInitialData.metadata.channelMetadataRenderer.externalId)` in the developer console. On the channel page, press F12, click "Console", and paste this command. The channel ID will get copied to your clipboard.
- You may also find the channel ID by looking in the database file.

This is admittedly a manual and complicated process.
That is because this feature is indented for advanced users.
If there is demand, I will consider a more user-friendly implementation.

Please see #6 for more information on this.

## Alternatives

It is possible to manually set up RSS feeds for each channel you are interested in. It is a very lengthy process.

1. Find the id of the channel.
1. Get the URL to the RSS feed: https://www.youtube.com/feeds/videos.xml?channel_id=<channelId\>
1. Put this URL in an RSS reader (such as [blogtrottr.com](https://blogtrottr.com))

Here are some advantages of BBYEN over manually configuring RSS feeds:

- No ads.
- You don't have to manually go through all your subscriptions. It will automatically find all subscriptions you have notifications for.
- It will automatically detect new subscriptions and unsubscriptions.

## Contributing

Pull requests welcome.

I also accept donations, but please consider other, more worthy causes.

[![PayPal](https://img.shields.io/badge/PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/donate/?hosted_button_id=RU2HM3LYLQG34)

## Development

Run the Node regression suite with `npm test -- --run`, then `npm run typecheck`
and `npm run lint`. The Python companion tests use temporary files and require
Python 3 with `requests` installed:

```sh
python -B -m unittest discover -s tools -p 'test_*.py'
```

The companion accepts string and object channel entries, preserving settings
when adding or removing other channels. Set `BBYEN_CHANNELS` to choose its
`channels.json` path, including a file that does not exist yet.

### Docker

Building the docker image:
```
sudo docker build . -t marcel/bbyen
```

I had to use `--network host` to have `npm install` work correctly without timing out:
```
sudo docker build . -t marcel/bbyen --network host
```
