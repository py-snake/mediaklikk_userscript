# MediaKlikk Stream Extractor

A **userscript** for [mediaklikk.hu](https://mediaklikk.hu), [m4sport.hu](https://m4sport.hu), and [hirado.hu](https://hirado.hu) that extracts:

- **Master m3u8** (all qualities in one playlist)
- **Quality variants** (up to 6 HLS renditions with bandwidth/resolution labels)
- **Sidecar SRT subtitles** (when available on VOD)
- **HLS-embedded subtitles** (for live/M1 archives — assembles WebVTT segments into a single `.srt`)

All links get a **Copy** button; subtitles also get a **Download** button that assembles/convertes on the fly.

---

## Installation

### Requirements
- **Firefox 52+** (ES5 compatible — works on Windows XP with Firefox 52 ESR)
- **Violentmonkey 2.13+** (also works in Tampermonkey / Greasemonkey 4)

### Install
1. Open the userscript file: [`mediaklikk-extract.user.js`](mediaklikk-extract.user.js)
2. Click **Raw** → your userscript manager will prompt **Install**
3. Or copy the contents and create a new script in your userscript manager

---

## Usage

1. Open any video page on **mediaklikk.hu**, **m4sport.hu**, or **hirado.hu**
2. Start playing the video
3. A floating **Extractor** panel appears (top-left by default)
3. Panel shows:
   - **Master Playlist (all qualities)** — Copy button
   - **Quality Variants (N)** — each with resolution/bandwidth + Copy
   - **Subtitles (SRT)** — sidecar SRT (VOD) with Copy + Download
   - **Subtitles (HLS embedded)** — HLS-embedded DFXP/WebVTT (live archives) with Copy + Download (assembles `.srt` on click)
4. Drag the header to move; click **−** to minimize; **×** to close
5. **Resize** by dragging the bottom-right corner; size is remembered

### Features
- **Generation guard** — rapid video switches never mix subtitles/qualities
- **URL normalization** — `//cdn...` → `https://cdn...` everywhere
- **Per-window memory** — position, minimized state, and **window size** persisted via `GM_setValue`
- **Resizable** — drag the bottom-right corner triangle; size is saved
- **Minimize** — header-only mode; restore restores exact size

---

## Supported Sites
| Domain | Notes |
|--------|-------|
| `mediaklikk.hu` | VOD + live archives (M1, Duna, Duna World, M5) |
| `m4sport.hu` | Sports VOD + live (M4 Sport, M4 Sport+) |
| `hirado.hu` | News videos |

---

## How It Works

1. Runs **inside the player iframe** (`player.mediaklikk.hu/*`)
2. Detects video loads via:
   - `get_video_url.php` XHR hook (recommended/direct changes)
   - `video-url-loaded` custom event
   - JWPlayer `pl.getPlaylistItem()` polling (backup)
4. Extracts master m3u8 → fetches variants → parses `#EXT-X-MEDIA:TYPE=SUBTITLES` for HLS subs
5. For **sidecar SRT on recommended videos**: captures the permalink from the parent `load-video` message → fetches the video page → extracts `subtitlePath` from its `loadPlayer` config → queries `player.php?video=<token>&subtitlePath=<path>` for the full SRT URL
6. Renders everything in a draggable, resizable, minimizable panel with copy/download buttons

---

## Configuration (edit top of script)

```js
var PANEL_BG           = 'rgba(20,20,30,0.88)';   // panel background
var HEADER_BG          = 'rgba(40,50,70,0.95)';   // header background
var PANEL_MINIMIZED_BG = 'rgba(40,50,70,0.95)';   // minimized header bg
```

Defaults: dark semi-transparent. Change alpha (0–1) for more/less transparency.

---

## Permissions (auto-declared)

| Grant | Purpose |
|-------|---------|
| `GM_setValue` / `GM_getValue` | Persist panel position, size, minimized state, "Show URLs" checkbox |
| `GM_setClipboard` | Copy links to clipboard (falls back to `execCommand`/`prompt`) |
| `GM_xmlhttpRequest` | Cross-origin fetches (m3u8, subtitle playlist, permalink page, player.php) |
| `unsafeWindow` | Access JWPlayer instance (`pl.getPlaylistItem()`) for backup detection |

---

## File Structure
```
mediaklikk_userscript/
├── mediaklikk-extract.user.js   # The userscript (install this)
├── mediaklikk.hu.har            # Sample HAR (first video, VOD with SRT)
├── mediaklikk.hu2.har           # Sample HAR (recommended click, HLS-embedded subs)
└── README.md                    # This file
```

---

## Changelog

| Version | Changes |
|---------|---------|
| **1.4.4** | URL normalization (`//` → `https:`); resizable panel with saved size; flex-body scrolling |
| **1.4.3** | Per-recommended-video SRT recovery via permalink → `subtitlePath` → `player.php` |
| **1.4.2** | Generation guard (`renderGen`) to prevent stale subtitle/quality overwrites |
| **1.4.1** | `@grant unsafeWindow` added |
| **1.4.0** | HLS-embedded subtitle detection (`#EXT-X-MEDIA:TYPE=SUBTITLES`) + WebVTT→SRT assembly |
| **1.3.x** | Initial extraction, gen-guard, panel, gen-guard |

---

## License

MIT License — see [LICENSE](LICENSE) for full text.

```
MIT License

Copyright (c) 2024 py-snake and opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Credits

- **Author**: py-snake and opencode
- **Site reverse-engineering**: based on HAR analysis of `mediaklikk.hu`, `player.mediaklikk.hu`, `SideRecommender.js`, `mtva-player.js`
- **Inspired by**: yt-dlp / streamlink MediaKlikk extractors

---

## Disclaimer

This script is for personal/educational use. Respect the site's terms of service and copyright. The author is not responsible for any misuse.