#!/usr/bin/env python3
"""
bbyen_add_sub_whitelist_only.py
Manage whitelisted YouTube channels in bbyen's channels.json.
Supports adding, removing, and listing channels by URL, handle, or channel ID.
"""

import sys
import os
import re
import json
import subprocess
import tempfile
from functools import wraps
import requests

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None

def find_config_file():
    env_path = os.environ.get("BBYEN_CONFIG")
    if env_path and os.path.exists(env_path):
        return os.path.abspath(env_path)
    candidates = [
        "/opt/youtubenotify-bbyen/config.json",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json"),
        "config.json",
        os.path.expanduser("~/.config/bbyen/config.json")
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    return "/opt/youtubenotify-bbyen/config.json"

def find_channels_file():
    env_path = os.environ.get("BBYEN_CHANNELS")
    if env_path:
        return os.path.abspath(env_path)
    config_env = os.environ.get("BBYEN_CONFIG")
    if config_env:
        candidate = os.path.join(os.path.dirname(os.path.abspath(config_env)), "channels.json")
        return candidate
    candidates = [
        "/opt/youtubenotify-bbyen/channels.json",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "channels.json"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "channels.json"),
        "channels.json",
        os.path.expanduser("~/.config/bbyen/channels.json")
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    return os.path.join(os.path.dirname(find_config_file()), "channels.json")

CONFIG_FILE = find_config_file()
TARGET_CHANNELS_FILE = find_channels_file()

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "SOCS=CAESNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQxMjE3LjA1X3AwGgJzayACGgYIgJfnuwY"
}

CHANNEL_ID_REGEX = re.compile(r"^UC[A-Za-z0-9_-]{22}$")

def is_valid_input(text: str) -> bool:
    """Check if input is a recognized YouTube URL, handle, or 24-char channel ID."""
    if not text or not isinstance(text, str):
        return False
    text = text.strip()
    # 1. Direct channel ID
    if CHANNEL_ID_REGEX.match(text):
        return True
    # 2. Handle directly (e.g. @name)
    if re.match(r"^@[A-Za-z0-9_.-]+$", text):
        return True
    # 3. URLs
    patterns = [
        r"^https?://(www\.)?youtube\.com/channel/UC[A-Za-z0-9_-]{22}",
        r"^https?://(www\.)?youtube\.com/@[A-Za-z0-9_.-]+",
        r"^https?://(www\.)?youtube\.com/c/[A-Za-z0-9_.-]+",
        r"^https?://(www\.)?youtube\.com/user/[A-Za-z0-9_.-]+",
        r"^https?://(www\.)?youtube\.com/watch\?v=[A-Za-z0-9_-]+",
        r"^https?://youtu\.be/[A-Za-z0-9_-]+",
        r"^https?://(www\.)?youtube\.com/shorts/[A-Za-z0-9_-]+"
    ]
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)

def fetch_channel_id(input_str: str) -> str:
    """
    Extracts or resolves a 24-char YouTube Channel ID from raw ID, URL, or handle.
    Does NOT require network requests if an ID or /channel/ URL is provided.
    """
    input_str = input_str.strip()

    # 1. If it's already a channel ID (UC...)
    if CHANNEL_ID_REGEX.match(input_str):
        return input_str

    # 2. If it's a direct channel URL (https://www.youtube.com/channel/UC...)
    channel_url_match = re.search(r"youtube\.com/channel/(UC[A-Za-z0-9_-]{22})", input_str, re.IGNORECASE)
    if channel_url_match:
        return channel_url_match.group(1)

    # Normalize @handle without URL
    if input_str.startswith("@"):
        url = f"https://www.youtube.com/{input_str}"
    else:
        url = input_str

    # Ensure protocol
    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url

    # 3. Must fetch the page to resolve handle, /c/, /user/, video, or shorts URL
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        response.raise_for_status()
    except requests.exceptions.HTTPError as e:
        status_code = getattr(response, "status_code", None)
        if status_code == 404:
            raise ValueError(f"Channel or video not found (HTTP 404) at {url}. The channel may have been deleted or renamed.")
        raise ValueError(f"Network error fetching {url}: {e}")
    except requests.RequestException as e:
        raise ValueError(f"Network error fetching {url}: {e}")

    html = response.text

    # Try RSS link: <link rel="alternate" type="application/rss+xml" href="...channel_id=UC...">
    if BeautifulSoup:
        soup = BeautifulSoup(html, "html.parser")
        link_tag = soup.find("link", rel="alternate", type="application/rss+xml")
        if link_tag and "channel_id=" in link_tag.get("href", ""):
            cid = link_tag["href"].split("channel_id=")[-1].split("&")[0]
            if CHANNEL_ID_REGEX.match(cid):
                return cid

        meta_id = soup.find("meta", {"itemprop": ["identifier", "channelId"]})
        if meta_id and meta_id.get("content") and CHANNEL_ID_REGEX.match(meta_id["content"]):
            return meta_id["content"]

        canonical_tag = soup.find("link", rel="canonical")
        if canonical_tag and "youtube.com/channel/" in canonical_tag.get("href", ""):
            cid_match = re.search(r"youtube\.com/channel/(UC[A-Za-z0-9_-]{22})", canonical_tag["href"])
            if cid_match:
                return cid_match.group(1)

    # Regex fallbacks (works whether BeautifulSoup is present or not)
    rss_match = re.search(r'href="[^"]*channel_id=(UC[A-Za-z0-9_-]{22})', html)
    if rss_match:
        return rss_match.group(1)

    meta_match = re.search(r'<meta[^>]+itemprop="(?:identifier|channelId)"[^>]+content="(UC[A-Za-z0-9_-]{22})"', html)
    if meta_match:
        return meta_match.group(1)

    match = re.search(r'"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"', html)
    if match:
        return match.group(1)

    match_ext = re.search(r'"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"', html)
    if match_ext:
        return match_ext.group(1)

    raise ValueError(f"Unable to extract YouTube channel ID from URL: {url}")

def validate_channel_id(channel_id: str) -> bool:
    return bool(CHANNEL_ID_REGEX.match(channel_id))

def restart_service():
    """Restarts the systemd service if running on Linux with systemctl."""
    try:
        res = subprocess.run(["sudo", "systemctl", "restart", "youtubenotify-bbyen.service"], check=False, capture_output=True, text=True)
        if res.returncode == 0:
            print("Successfully restarted youtubenotify-bbyen.service")
        else:
            # Fallback without sudo if already root
            res2 = subprocess.run(["systemctl", "restart", "youtubenotify-bbyen.service"], check=False, capture_output=True, text=True)
            if res2.returncode == 0:
                print("Successfully restarted youtubenotify-bbyen.service")
            else:
                err = (res.stderr or res2.stderr or "").strip()
                print(f"Notice: Could not restart service automatically ({err})")
    except Exception as e:
        print(f"Notice: Service restart skipped ({e})")

def load_config():
    if not os.path.exists(TARGET_CHANNELS_FILE):
        return {"whitelistedChannelIds": []}
    with open(TARGET_CHANNELS_FILE, "r", encoding="utf-8") as f:
        config = json.load(f)
    if not isinstance(config, dict):
        raise ValueError("channels.json must contain a JSON object")
    entries = config.get("whitelistedChannelIds", [])
    if not isinstance(entries, list):
        raise ValueError("whitelistedChannelIds must be an array")
    for entry in entries:
        channel_entry_id(entry)
    return config


def channel_entry_id(entry):
    if isinstance(entry, str) and entry:
        return entry
    if isinstance(entry, dict) and isinstance(entry.get("id"), str) and entry["id"]:
        return entry["id"]
    raise ValueError("Channel entries must be strings or objects with a nonempty id")

def save_config(config):
    directory = os.path.dirname(os.path.abspath(TARGET_CHANNELS_FILE))
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory,
                                         prefix=os.path.basename(TARGET_CHANNELS_FILE) + ".",
                                         suffix=".tmp", delete=False) as target:
            temporary = target.name
            json.dump(config, target, indent=4, sort_keys=True)
        os.replace(temporary, TARGET_CHANNELS_FILE)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def locked_edit(operation):
    @wraps(operation)
    def edit(*args, **kwargs):
        lock_path = TARGET_CHANNELS_FILE + ".lock"
        try:
            descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            raise ValueError(f"File is locked: {TARGET_CHANNELS_FILE}. Retry after the other "
                             "editor finishes. After a crash, verify the owning process "
                             f"has stopped before removing {lock_path}.") from None
        try:
            with os.fdopen(descriptor, "w", encoding="ascii") as lock:
                lock.write(str(os.getpid()))
            changed = operation(*args, **kwargs)
        finally:
            os.unlink(lock_path)
        if changed:
            # The service reload also acquires this lock; release it first.
            restart_service()
        return changed
    return edit

@locked_edit
def add_channel(user_input):
    if not is_valid_input(user_input):
        print("Invalid input! Please provide a YouTube channel URL, handle (@name), video URL, or channel ID.")
        return

    try:
        channel_id = fetch_channel_id(user_input)
    except ValueError as e:
        print(f"Error: {e}")
        return

    if not validate_channel_id(channel_id):
        print(f"Extracted ID '{channel_id}' is not a valid 24-char YouTube channel ID.")
        return

    config = load_config()
    whitelist = config.get("whitelistedChannelIds", [])

    if channel_id in {channel_entry_id(entry) for entry in whitelist}:
        print(f"YouTube channel already exists in whitelist! (ID: {channel_id})")
        return

    whitelist.append(channel_id)
    config["whitelistedChannelIds"] = whitelist
    save_config(config)

    print(f"Added YouTube channel! (https://www.youtube.com/channel/{channel_id})")
    return True

@locked_edit
def remove_channel(user_input):
    user_input = user_input.strip()
    config = load_config()
    whitelist = config.get("whitelistedChannelIds", [])
    whitelist_ids = {channel_entry_id(entry) for entry in whitelist}

    channel_id = None

    # 1. Direct ID match: check if the user entered an ID that is directly in the whitelist
    if CHANNEL_ID_REGEX.match(user_input):
        channel_id = user_input
    # 2. Check if the user entered a channel URL with /channel/UC...
    elif "youtube.com/channel/" in user_input.lower():
        match = re.search(r"youtube\.com/channel/(UC[A-Za-z0-9_-]{22})", user_input, re.IGNORECASE)
        if match:
            channel_id = match.group(1)

    # 3. If still not found, try to resolve via network / scraper
    if not channel_id:
        try:
            channel_id = fetch_channel_id(user_input)
        except ValueError as e:
            # If network resolution failed (e.g. channel deleted / 404), check if input is in whitelist anyway
            if user_input in whitelist_ids:
                channel_id = user_input
            else:
                print(f"Error resolving channel: {e}")
                print("Tip: If the channel was deleted or suspended, you can remove it directly using its channel ID (UC...).")
                return

    if not channel_id or channel_id not in whitelist_ids:
        print(f"YouTube channel not found in whitelist! (ID: {channel_id or user_input})")
        return

    # Remove all instances of this channel_id
    original_len = len(whitelist)
    whitelist = [entry for entry in whitelist if channel_entry_id(entry) != channel_id]
    removed_count = original_len - len(whitelist)

    config["whitelistedChannelIds"] = whitelist
    save_config(config)

    print(f"Removed YouTube channel! (https://www.youtube.com/channel/{channel_id}) [Removed {removed_count} entry]")
    return True

def list_channels():
    config = load_config()
    whitelist = config.get("whitelistedChannelIds", [])
    print(f"\nTotal whitelisted channels: {len(whitelist)}\n")
    try:
        for entry in whitelist:
            channel_id = channel_entry_id(entry)
            print(f"https://www.youtube.com/channel/{channel_id}")
    except BrokenPipeError:
        pass

def main():
    print(f"Using channels file: {TARGET_CHANNELS_FILE}")
    while True:
        print("\nChoose an option (1-4):")
        print("1. Add a YouTube channel (URL, @handle, or Channel ID)")
        print("2. Remove a YouTube channel (URL, @handle, or Channel ID)")
        print("3. List all YouTube channels")
        print("4. Exit")
        print("")
        choice = input("Enter option number: ").strip()

        if choice in ["1", "2"]:
            while True:
                prompt_text = "Enter YouTube URL, @handle, or Channel ID (0 to go back): "
                user_input = input(prompt_text).strip()
                if user_input == "0":
                    break
                if is_valid_input(user_input):
                    break
                print("Not a valid YouTube URL, @handle, or Channel ID. Please try again.")

            if user_input == "0":
                continue

            if choice == "1":
                print("")
                add_channel(user_input)
            elif choice == "2":
                print("")
                remove_channel(user_input)
        elif choice == "3":
            list_channels()
        elif choice == "4":
            sys.exit()
        else:
            print("Invalid choice")

if __name__ == "__main__":
    main()
