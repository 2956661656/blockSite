[中文](README.md) | English

# 🚫 Website Blocker

A Chrome extension (Manifest V3): add domains to the **blacklist** to block access; add specific links to the **whitelist** to let them through as exceptions.

## Features

- **Blacklist**: blocks an entire domain and all of its subdomains (e.g. adding `youtube.com` also blocks `www.youtube.com`, `m.youtube.com`)
- **Whitelist**: allows specific links through, using **strict path-boundary** matching (see the table below)
- **Master switch**: pause or resume blocking with one click from the toolbar popup / the options page
- **Popup quick actions**: check whether the current page is blocked, or add the current page to the whitelist with one click
- **Custom block page**: blocked pages show a custom block page (block.html) — the title, message, button, theme color, logo, and whether to show the blocked URL are all configurable on the options page
- **Block-page background image**: the block page background can be set to an image (URL, supports http(s)/data:/extension resources; leave it blank to use the default dark background, which automatically adds a dark overlay to keep text readable) (when a remote background image is used, each block sends a request to the image server)
- The block page provides a temporary "Still Visit"（仍然访问）button that allows access for 10 minutes
- Up to 4 customizable action buttons (Back（返回）/ Open Settings（打开设置）/ Copy URL（复制网址）/ Still Visit)
- Changes take effect immediately — no page refresh needed

## Matching Rules Example

Behavior when the blacklist contains `youtube.com` and the whitelist contains `youtube.com/watch=1234`:

| Visited link | Result |
| --- | --- |
| `https://www.youtube.com/` | 🔴 Blocked |
| `https://m.youtube.com/feed/subscriptions` | 🔴 Blocked |
| `https://www.youtube.com/watch=1234` | 🟢 Allowed |
| `https://www.youtube.com/watch=1234&t=60` | 🟢 Allowed (trailing parameters permitted) |
| `https://www.youtube.com/watch=12345` | 🔴 Blocked (a shared prefix is not allowed through) |
| `https://notyoutube.com/` | ⚪ Not handled (different domain) |
| `https://youtube.com.evil.com/` | ⚪ Not handled (suffix domains are not affected) |

How it works: the blacklist generates a `||domain^` rule (`||` anchors the domain so subdomains match, `^` marks the boundary), while the whitelist generates a `*link^` rule with higher priority — when both match, the whitelist lets the request through.

## Installation

1. Open `chrome://extensions`
2. Turn on "Developer mode"（开发者模式）in the top-right corner
3. Click "Load unpacked"（加载已解压的扩展程序）and select this project's directory
4. When the toolbar icon (🚫) appears, the installation was successful

## Usage

- Click the toolbar icon → popup: toggle the master switch, view the current page's status, or add the current page to the whitelist with one click
- Right-click the popup and choose "Edit blacklist/whitelist…"（编辑黑白名单…）, or open the extension details → "Extension options"（扩展程序选项）→ manage the blacklist/whitelist on the options page
- Blocked pages are redirected to the **custom block page**, which shows the block notice and the blocked URL; clicking "Still Visit"（仍然访问）temporarily allows access for 10 minutes

Tip: adding a page to the whitelist from the popup keeps all of the current URL's parameters; to allow a page without parameters, manually enter a `domain/path` prefix on the options page.

## Notes

- Entries are automatically normalized: lowercased; the `http(s)://` prefix, leading `www.`, trailing `/`, and `#fragment` are ignored
- Entries may not contain `*`, `|`, or `^` (urlFilter special characters)
- Each blacklist entry generates 2 DNR rules (main-frame redirect + blocking of other resources); each whitelist entry generates 1 allow rule
- Blacklist limit: **1000 entries** (Chrome's hard cap for regex rules); combined blacklist/whitelist rule limit: **4900 rules**; the options page warns when the blacklist reaches **1000 entries** or the combined rules approach **4900 rules**
- Entries only support ASCII; use punycode for Chinese domains (e.g. `xn--fsqu00a.xn--fiqs8s`)
- Blocking applies only to `http(s)` pages; main-frame navigation over other protocols such as `ftp://` is no longer intercepted
- "Still Visit"（仍然访问）temporarily allows the URL for 10 minutes (a session-scoped rule that applies to all tabs); when it expires, blocking resumes automatically
- A whitelist entry that has no overlap with any blacklisted site naturally has no effect — this is expected behavior
- Data is stored in `chrome.storage.local`

## File Structure

```
manifest.json           Extension manifest (MV3)
rule-builder.js         Pure-function core: normalization / rule building / matching (no chrome API, unit-testable)
background.js           Service Worker: syncs blacklist/whitelist → DNR dynamic rules
block.html/css/js       Custom block page that blocked pages are redirected to (content configurable on the options page)
options.html/js/css     Options page
popup.html/js/css       Toolbar popup
icons/                  Icons (generated by scripts/make_icons.py)
test/rule-builder.test.js   Node unit tests: `node test/rule-builder.test.js`
scripts/make_icons.py   Icon generation script (standard library only)
README.md               Chinese documentation (switch to English at the top)
README.en.md            English documentation (switch to Chinese at the top)
```

## Requirements

Chrome / Edge (Chromium-based, Chrome 111+, requires support for `color-mix()` and DNR dynamic rules).
