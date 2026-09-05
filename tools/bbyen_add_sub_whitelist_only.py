# TODO
# Restart service URL is added or Removed. 
# Chrome extension to send or check if the URL exists?
# Add option to add to blacklist as well as whitelist? 
# If URL was added to whitelist, print "URL added into whitelist"
# If URL was added to blacklist, print "URL added into blacklist"
# Edit print commands to include like "Enter URL to Add to whitelist/blacklist"
# List option should support it as well - If only whitelist option exist, show that. If both, make a choice
# Batch import of URLs with ; as a separator
# Store channel name somewhere so ID will always point to it
# Example URLs
# "https://www.youtube.com/@jetlagthegame"
# "https://www.youtube.com/c/jetlagthegame"
# "https://www.youtube.com/channel/UCxkM67T_Iele-mRVUiBkRqg"

import sys
import requests
import json
import re
import subprocess
from bs4 import BeautifulSoup

import os

def find_config_file():
    env_path = os.environ.get("BBYEN_CONFIG")
    if env_path and os.path.exists(env_path):
        return env_path
    candidates = [
        "config.json",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json"),
        "/opt/youtubenotify-bbyen/config.json",
        os.path.expanduser("~/.config/bbyen/config.json")
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    return "config.json"

CONFIG_FILE = find_config_file()

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "SOCS=CAESNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQxMjE3LjA1X3AwGgJzayACGgYIgJfnuwY"  # Your SOCS cookie value
}

VALID_URL_PATTERNS = [
    r"^https://www\.youtube\.com/c/[A-Za-z0-9_-]+.*$",
    r"^https://www\.youtube\.com/channel/[A-Za-z0-9_-]+.*$",
    r"^https://www\.youtube\.com/@[A-Za-z0-9_-]+.*$",
    r"^https://youtu\.be/[A-Za-z0-9_-]+.*$",
    r"^https://www\.youtube\.com/watch\?v=.*$"
]

def is_valid_url(url):
    return any(re.match(pattern, url) for pattern in VALID_URL_PATTERNS)

def fetch_channel_id(url):
    # Check if the URL contains '/channel/' and extract the ID directly
    if 'youtube.com/channel/' in url:
        match = re.search(r'youtube\.com/channel/([A-Za-z0-9_-]+)', url)
        if match:
            return match.group(1)

    # If the URL contains '/@', fetch and parse the page
    if 'youtube.com/@' in url:
        try:
            response = requests.get(url, headers=HEADERS)
            response.raise_for_status()
        except requests.RequestException:
            raise ValueError(f"Unable to fetch the URL: {url}")

        soup = BeautifulSoup(response.text, 'html.parser')

        # Look for the RSS link tag
        link_tag = soup.find('link', rel='alternate', type='application/rss+xml', title='RSS')
        if link_tag and 'channel_id=' in link_tag.get('href', ''):
            channel_id = link_tag['href'].split('channel_id=')[-1]
            return channel_id

    # If the URL is a video URL, fetch and parse the page
    if 'youtube.com/watch' in url or 'youtu.be/' in url:
        try:
            response = requests.get(url, headers=HEADERS)
            response.raise_for_status()
        except requests.RequestException:
            raise ValueError(f"Unable to fetch the URL: {url}")

        soup = BeautifulSoup(response.text, 'html.parser')

        # Look for "channelId" in script tags
        script_tags = soup.find_all('script')
        for script in script_tags:
            if '"channelId":"' in script.text:
                match = re.search(r'"channelId":"([A-Za-z0-9_-]+)"', script.text)
                if match:
                    return match.group(1)

    # If no channel ID is found, raise an error
    raise ValueError(f"Unable to get channel ID from URL: {url}")

def validate_channel_id(channel_id):
    # You can adjust the regex based on the expected channel ID format
    if re.match(r"^[A-Za-z0-9_-]{24}$", channel_id):
        return True
    return False

def add_channel(channel_url):
    if not is_valid_url(channel_url):
        print("The channel URL is not valid")
        return

    try:
        channel_id = fetch_channel_id(channel_url)
    except ValueError as e:
        print(e)
        return

    if not validate_channel_id(channel_id):
        print(f"Unable to add URL: {channel_url}")
        return

    # Add to config file
    try:
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)
    except FileNotFoundError:
        config = {"whitelistedChannelIds": []}

    if channel_id in config.get("whitelistedChannelIds", []):
        print("YouTube channel already exists!")
        return

    config["whitelistedChannelIds"].append(channel_id)

    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=4, sort_keys=True)

    print(f"Added YouTube channel! (https://www.youtube.com/channel/{channel_id})")
    subprocess.run(["sudo", "systemctl", "restart", "youtubenotify-bbyen.service"])

def remove_channel(channel_url):
    if not is_valid_url(channel_url):
        print("The channel URL is not valid")
        return

    try:
        channel_id = fetch_channel_id(channel_url)
    except ValueError as e:
        print(e)
        return

    if not validate_channel_id(channel_id):
        print(f"Unable to remove URL: {channel_url}")
        return

    # Remove from config file
    try:
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)
    except FileNotFoundError:
        print("Config file not found!")
        return

    if channel_id not in config.get("whitelistedChannelIds", []):
        print("YouTube channel not found!")
        return

    config["whitelistedChannelIds"].remove(channel_id)

    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=4, sort_keys=True)

    print(f"Removed YouTube channel! (https://www.youtube.com/channel/{channel_id})")
    subprocess.run(["systemctl", "restart", "youtubenotify-bbyen.service"])

def list_channels():
    try:
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)
    except FileNotFoundError:
        print("Config file not found!")
        return

    print("")
    for channel_id in config.get("whitelistedChannelIds", []):
        print(f"https://www.youtube.com/channel/{channel_id}")

def main():
    while True:
        print("\nChoose an option (1-4):")
        print("")
        print("1. Add a YouTube channel by URL (Video or channel)")
        print("2. Remove a YouTube channel by URL (Video or channel)")
        print("3. List all YouTube channel URLs (Only IDs, without channel name)")
        print("4. Exit")
        print("")
        choice = input("Enter option number: ")

        if choice in ["1", "2"]:
            while True:
                url_address = input("Enter URL of YouTube video or channel (0 to go back): ")
                if url_address == "0":
                    break
                if is_valid_url(url_address):
                    break
                print("Not a valid URL")
            if url_address == "0":
                continue
            if choice == "1":
                print("")
                add_channel(url_address)
            elif choice == "2":
                print("")
                remove_channel(url_address)
        elif choice == "3":
            list_channels()
        elif choice == "4":
            sys.exit()
        else:
            print("Invalid choice")

if __name__ == "__main__":
    main()
