// ==UserScript==
// @name         YouTube Auto-Bell and Channel URL Copier
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Automatically sets notifications to "All" (Všetky) upon subscribing, copies the channel URL to clipboard, and shows an elegant toast.
// @author       NightMean
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // No LOCALES needed: language-agnostic DOM detection is used.

  /**
   * Displays an elegant, glassmorphic toast notification at the bottom center of the viewport.
   * @param {string} message - The text to display.
   */
  const showToast = (message) => {
    let toast = document.getElementById('tm-youtube-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'tm-youtube-toast';

      const style = document.createElement('style');
      style.textContent = `
        #tm-youtube-toast {
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translate(-50%, 20px);
          background: rgba(28, 28, 30, 0.85);
          backdrop-filter: blur(12px) saturate(180%);
          -webkit-backdrop-filter: blur(12px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #f5f5f7;
          padding: 12px 24px;
          border-radius: 12px;
          z-index: 10000;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 14px;
          font-weight: 500;
          box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
          opacity: 0;
          transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
          display: flex;
          align-items: center;
          gap: 8px;
          pointer-events: none;
        }
        #tm-youtube-toast.show {
          opacity: 1;
          transform: translate(-50%, 0);
        }
        #tm-youtube-toast .toast-icon {
          color: #34c759;
          font-weight: bold;
        }
      `;
      document.head.appendChild(style);

      const iconSpan = document.createElement('span');
      iconSpan.className = 'toast-icon';
      iconSpan.textContent = '✓';
      const textSpan = document.createElement('span');
      textSpan.className = 'toast-text';
      toast.appendChild(iconSpan);
      toast.appendChild(textSpan);

      document.body.appendChild(toast);
    }

    toast.querySelector('.toast-text').textContent = message;

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
    }, 3500);
  };

  const getChannelUrl = (element) => {
    const currentUrl = window.location.href;
    if (currentUrl.includes('/@') || currentUrl.includes('/channel/') || currentUrl.includes('/c/') || currentUrl.includes('/user/')) {
      if (!currentUrl.includes('/watch')) {
        return currentUrl;
      }
    }

    if (element) {
      const ownerContainer = element.closest('ytd-video-owner-renderer, ytd-channel-renderer, ytd-grid-channel-renderer, #owner, #upload-info');
      if (ownerContainer) {
        const channelLink = ownerContainer.querySelector('a[href*="/@"], a[href*="/channel/"], a[href*="/c/"], a[href*="/user/"]');
        if (channelLink) {
          const href = channelLink.getAttribute('href');
          if (href) {
            return new URL(href, window.location.origin).href;
          }
        }
      }
    }

    const globalOwner = document.querySelector('ytd-video-owner-renderer, #owner, #upload-info');
    if (globalOwner) {
      const channelLink = globalOwner.querySelector('a[href*="/@"], a[href*="/channel/"], a[href*="/c/"], a[href*="/user/"]');
      if (channelLink) {
        const href = channelLink.getAttribute('href');
        if (href) {
          return new URL(href, window.location.origin).href;
        }
      }
    }

    return currentUrl;
  };

  const copyToClipboard = (text) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showToast('Channel URL copied to clipboard!'))
        .catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  };

  const fallbackCopy = (text) => {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      showToast('Channel URL copied to clipboard!');
    } catch (err) {
      console.error('[TM Script] Clipboard copy failed:', err);
    }
  };

  const isBellButton = (element) => {
    if (!element || !element.tagName) return false;
    const tag = element.tagName.toLowerCase();
    if (tag.includes('subscription-notification') || tag.includes('notification-toggle')) {
      return true;
    }
    const ariaLabel = (element.getAttribute && element.getAttribute('aria-label')) || '';
    const elementId = element.id || '';
    if (
      ariaLabel.toLowerCase().includes('notification') ||
      ariaLabel.toLowerCase().includes('upozornenia') ||
      elementId.toLowerCase().includes('notification')
    ) {
      return true;
    }
    return false;
  };

  let lastBellChannelUrl = null;

  document.body.addEventListener('click', (event) => {
    const path = event.composedPath();
    let contextElement = null;
    for (const el of path) {
      if (el.tagName) {
        const tag = el.tagName.toLowerCase();
        if (
          tag === 'yt-subscribe-button-view-model' ||
          tag === 'ytd-subscribe-button-renderer' ||
          isBellButton(el)
        ) {
          contextElement = el;
          break;
        }
      }
    }

    if (contextElement) {
      const channelUrl = getChannelUrl(contextElement);
      lastBellChannelUrl = channelUrl;
      console.log(`[TM Script] Clicked subscription/bell control. Registered channel URL: ${channelUrl}`);
      return;
    }

    let menuItem = null;
    for (const el of path) {
      if (el.tagName) {
        const tag = el.tagName.toLowerCase();
        if (
          tag === 'yt-list-item-view-model' ||
          tag === 'ytd-menu-service-item-renderer' ||
          tag === 'tp-yt-paper-item' ||
          (el.getAttribute && el.getAttribute('role') === 'menuitem')
        ) {
          menuItem = el;
          break;
        }
      }
    }

    if (menuItem) {
      // Check if it's the "All" option using the unique SVG path of the ringing bell icon,
      // or as a fallback check if it's the first menuitem in the notification settings list.
      const hasAllBellIcon = menuItem.querySelector('path[d*="M19.395"]');
      let isAllOption = false;

      if (hasAllBellIcon) {
        isAllOption = true;
      } else {
        // Fallback: check index in notification dropdown
        const menuContainer = menuItem.closest('[role="menu"], ytd-menu-popup-renderer, tp-yt-paper-listbox, yt-list-view-model');
        if (menuContainer) {
          const items = Array.from(menuContainer.querySelectorAll('[role="menuitem"], [role="menuitemradio"], yt-list-item-view-model'));
          const index = items.indexOf(menuItem);
          if (index === 0) {
            isAllOption = true;
          }
        }
      }

      if (isAllOption) {
        const channelUrl = lastBellChannelUrl || getChannelUrl(menuItem);
        console.log(`[TM Script] Manual click on "All" notification detected. Copying channel URL: ${channelUrl}`);
        copyToClipboard(channelUrl);
        lastBellChannelUrl = null;
      }
    }
  }, { capture: true });

})();