// ==UserScript==
// @name         MediaKlikk Stream Extractor
// @namespace    mediaklikk-tools
// @version      1.7.3
// @description  Extract m3u8 (all qualities), master m3u8, and SRT subtitle links from MediaKlikk videos (runs inside the player iframe)
// @author       py-snake and opencode
// @match        https://player.mediaklikk.hu/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

// ============================================================================
// CONFIGURATION - edit these values to customize the panel appearance
// ============================================================================

// Panel background: "rgba(R, G, B, ALPHA)"
//   ALPHA = 1.0 fully opaque, 0.0 fully transparent
//   Examples:
//     rgba(20,20,30,0.88)  - dark, mostly opaque (default)
//     rgba(20,20,30,0.60)  - dark, semi-transparent
//     rgba(20,20,30,0.35)  - dark, very transparent
var PANEL_BG = 'rgba(20,20,30,0.88)';

// Header background
var HEADER_BG = 'rgba(40,50,70,0.95)';

// Panel opacity when minimized
var PANEL_MINIMIZED_BG = 'rgba(40,50,70,0.95)';

// Set to true to print internal decisions to the browser console with the
// "[MediaKlikk-Extractor]" prefix. Flip to false (or just leave true and
// filter in devtools) once you're done investigating.
var DEBUG = true;

// ============================================================================

(function() {
    'use strict';

    var STORAGE_PREFIX = 'mkext_';
    var LOG_PREFIX = '[MediaKlikk-Extractor]';

    // Lightweight logger: gated by the DEBUG constant, no-op otherwise.
    // Safe to call from anywhere in the script.
    function dlog()  { if (DEBUG && console.log)   console.log.apply(console,   [LOG_PREFIX].concat([].slice.call(arguments))); }
    function dinfo() { if (DEBUG && console.info)  console.info.apply(console,  [LOG_PREFIX].concat([].slice.call(arguments))); }
    function dwarn() { if (DEBUG && console.warn)  console.warn.apply(console,  [LOG_PREFIX].concat([].slice.call(arguments))); }
    function derr()  { if (DEBUG && console.error) console.error.apply(console, [LOG_PREFIX].concat([].slice.call(arguments))); }

    var panel = null;
    var isDragging = false;
    var dragOffsetX = 0;
    var dragOffsetY = 0;
    var isResizing = false;
    var resizeStartW = 0;
    var resizeStartH = 0;
    var resizeStartX = 0;
    var resizeStartY = 0;
    var allUrlSpans = [];

    // --- Storage helpers ---

    function getVal(key, def) {
        try { return GM_getValue(STORAGE_PREFIX + key, def); }
        catch(e) { return def; }
    }

    function setVal(key, val) {
        try { GM_setValue(STORAGE_PREFIX + key, val); }
        catch(e) {}
    }

    // --- Network ---

    // Optional timeoutMs: hung requests report 'timeout' instead of hanging.
    function fetchURL(url, referer, callback, timeoutMs) {
        if (typeof GM_xmlhttpRequest !== 'function') {
            callback('GM_xmlhttpRequest unavailable');
            return;
        }
        var details = {
            method: 'GET',
            url: url,
            headers: referer ? { 'Referer': referer } : {},
            onload: function(resp) {
                if (!resp) {
                    callback('request failed');
                    return;
                }
                // Treat HTTP errors as failures, not success (an error page
                // must never be parsed as m3u8/subtitle data).
                if (typeof resp.status === 'number' && resp.status !== 0 &&
                        (resp.status < 200 || resp.status >= 300)) {
                    callback('http ' + resp.status);
                    return;
                }
                var text = '';
                if (typeof resp.responseText === 'string') {
                    text = resp.responseText;
                } else if (typeof resp.response === 'string') {
                    text = resp.response;
                }
                callback(null, text);
            },
            onerror: function(err) { callback(err || 'request failed'); }
        };
        if (timeoutMs) {
            details.timeout = timeoutMs;
            details.ontimeout = function() { callback('timeout'); };
        }
        GM_xmlhttpRequest(details);
    }

    // --- M3U8 parsing ---

    // Normalize protocol-relative URLs (//cdn...) to absolute https URLs.
    function normalizeUrl(url) {
        if (!url) return url;
        if (url.indexOf('//') === 0) return 'https:' + url;
        return url;
    }

    // Resolve a possibly-relative URL against a base directory.
    // Order matters: protocol-relative (//host/...) must not get baseDir prepended.
    // Root-absolute (/path/...) resolves against the origin root, not baseDir.
    function resolveUrl(url, baseDir) {
        if (!url) return url;
        if (url.indexOf('//') === 0) return 'https:' + url;
        if (/^https?:\/\//i.test(url)) return url;
        if (url.charAt(0) === '/') {
            var m = (typeof baseDir === 'string' ? baseDir : '').match(/^(https?:\/\/[^\/]+)/i);
            if (m) return m[1] + url;
            return url;
        }
        if (typeof baseDir !== 'string' || !baseDir) return url;
        return baseDir + url;
    }

    function parseM3U8Variants(content, baseUrl) {
        var lines = [];
        var variants = [];
        if (typeof content !== 'string' || !content) return variants;
        if (typeof baseUrl !== 'string' || !baseUrl) return variants;
        lines = content.split('\n');
        var baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/\r/g, '');
            if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
                var bwMatch = line.match(/BANDWIDTH=(\d+)/);
                var resMatch = line.match(/RESOLUTION=([^\s,]+)/);
                var nextLine = (i + 1 < lines.length) ? lines[i + 1].replace(/\r/g, '').trim() : '';
                if (nextLine && nextLine.indexOf('#') !== 0) {
                    var u = resolveUrl(nextLine, baseDir);
                    var bwPart = bwMatch ? Math.round(parseInt(bwMatch[1], 10) / 1000) + 'kbps' : '?';
                    variants.push({
                        bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
                        resolution: resMatch ? resMatch[1] : 'unknown',
                        url: u,
                        label: resMatch ? (resMatch[1] + ' (' + bwPart + ')') : bwPart
                    });
                }
            }
        }
        variants.sort(function(a, b) { return b.bandwidth - a.bandwidth; });
        return variants;
    }

    // Parse HLS-embedded subtitle tracks (#EXT-X-MEDIA:TYPE=SUBTITLES)
    // from a master playlist. These are DFXP/WebVTT subtitle playlists.
    function parseM3U8Subtitles(content, baseUrl) {
        var result = [];
        if (typeof content !== 'string' || !content) return result;
        if (typeof baseUrl !== 'string' || !baseUrl) return result;
        var lines = content.split('\n');
        var baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/\r/g, '');
            if (line.indexOf('#EXT-X-MEDIA:TYPE=SUBTITLES') === 0) {
                var langMatch = line.match(/LANGUAGE="([^"]+)"/);
                var nameMatch = line.match(/NAME="([^"]+)"/);
                var uriMatch = line.match(/URI="([^"]+)"/);
                if (uriMatch && uriMatch[1]) {
                    var u = resolveUrl(uriMatch[1], baseDir);
                    result.push({
                        url: u,
                        lang: langMatch ? langMatch[1] : 'hu',
                        name: nameMatch ? nameMatch[1] : 'Subtitles'
                    });
                }
            }
        }
        return result;
    }

    // Parse "HH:MM:SS.mmm", "MM:SS.mmm" (or comma variants) to milliseconds.
    function parseVttTime(s) {
        if (typeof s !== 'string') return 0;
        var m = s.match(/(?:^|\s|>)(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
        if (!m) return 0;
        var h = m[1] ? parseInt(m[1], 10) : 0;
        var ms = parseInt((m[4] + '000').substring(0, 3), 10);
        return ((h * 3600) + (parseInt(m[2], 10) * 60) + parseInt(m[3], 10)) * 1000 + ms;
    }

    // Format milliseconds as SRT timestamp "HH:MM:SS,mmm".
    function formatSrtTime(ms) {
        if (typeof ms !== 'number' || !isFinite(ms)) ms = 0;
        if (ms < 0) ms = 0;
        ms = Math.round(ms);
        var h = Math.floor(ms / 3600000); ms -= h * 3600000;
        var m = Math.floor(ms / 60000); ms -= m * 60000;
        var s = Math.floor(ms / 1000); var milli = ms - s * 1000;
        function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
        function pad3(n) { n = String(n); while (n.length < 3) n = '0' + n; return n; }
        return pad2(h) + ':' + pad2(m) + ':' + pad2(s) + ',' + pad3(milli);
    }

    // Shift a VTT cue timing line by offsetMs and emit clean SRT timing
    // (VTT cue settings after the end timestamp are stripped).
    // Returns null when the line has no parseable timestamps.
    function shiftTimingLine(line, offsetMs) {
        var parts = line.split('-->');
        if (parts.length < 2) return null;
        var start = parts[0].replace(/^\s+|\s+$/g, '');
        var end = parts[1].replace(/^\s+|\s+$/g, '').split(/\s+/)[0];
        var tsRe = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/;
        if (!tsRe.test(start) || !tsRe.test(end)) return null;
        var off = offsetMs;
        if (typeof off !== 'number' || !isFinite(off)) off = 0;
        return formatSrtTime(parseVttTime(start) + off) +
            ' --> ' + formatSrtTime(parseVttTime(end) + off);
    }

    // Build a single SRT document from segments with per-segment offsets.
    // Each segment's cues are relative to that segment, so every cue timing
    // is shifted by the cumulative #EXTINF duration of prior segments.
    function buildSrt(segTexts) {
        var out = [];
        var cueIndex = 0;
        if (!segTexts || !segTexts.length) return '';
        for (var i = 0; i < segTexts.length; i++) {
            var seg = segTexts[i] || {};
            var off = seg.offsetMs;
            if (typeof off !== 'number' || !isFinite(off)) off = 0;
            var lines = String(seg.text || '').replace(/\r/g, '').split('\n');
            var skipText = false;
            for (var j = 0; j < lines.length; j++) {
                var line = lines[j].replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
                if (line.indexOf('WEBVTT') === 0) continue;
                if (line.indexOf('X-TIMESTAMP-MAP') === 0) continue;
                if (line.replace(/\s+$/g, '') === 'STYLE') { skipText = true; continue; }
                if (line.indexOf('NOTE') === 0 && line.indexOf('-->') < 0) { skipText = true; continue; }
                if (line === '') { skipText = false; continue; }
                if (skipText) continue;
                if (line.indexOf('-->') >= 0) {
                    var shifted = shiftTimingLine(line, off);
                    // Skip malformed timing lines instead of emitting garbage cues,
                    // and suppress any orphan text that belonged to them.
                    if (!shifted) { skipText = true; continue; }
                    cueIndex++;
                    if (out.length > 0) out.push('');
                    out.push(String(cueIndex));
                    out.push(shifted);
                    continue;
                }
                // Cue identifier (a text line directly before a timing line)
                // belongs to the cue header, not the body. Skip it.
                if (j + 1 < lines.length && lines[j + 1].indexOf('-->') >= 0) continue;
                // Strip voice/style span tags (<c.white.bg_black>...</c>) and
                // trim, to match plain SRT text.
                var clean = line.replace(/<[^>]*>/g, '').replace(/^\s+|\s+$/g, '');
                if (clean === '') continue;
                out.push(clean);
            }
        }
        return out.length ? (out.join('\n') + '\n') : '';
    }

    // Save a text string as a downloaded file (Firefox 52 compatible).
    // Returns true on success, false if the save could not be triggered.
    function saveTextFile(filename, text) {
        try {
            var blob = new Blob([text], { type: 'text/plain' });
            var blobUrl = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            // Long delay: slow machines need time to start the download.
            setTimeout(function() {
                try { document.body.removeChild(a); } catch(e) {}
                try { URL.revokeObjectURL(blobUrl); } catch(e2) {}
            }, 1000);
            return true;
        } catch(e) {
            return false;
        }
    }

    // Fetch an HLS subtitle playlist, download every WebVTT segment and
    // assemble a single .srt file. Segments are fetched strictly one by
    // one (never parallel) so the CDN does not rate-limit/ban the client.
    // Each segment's cues are relative to that segment, so every cue timing
    // is shifted by the cumulative #EXTINF duration of prior segments.
    function downloadHlsSubtitle(playlistUrl, filename, btn) {
        if (!tryStartDownload(btn)) return;
        dlog('downloadHlsSubtitle: start, playlist=' + playlistUrl.substring(0, 90));
        var orig = btn ? btn.textContent : null;
        function setBtn(t) { if (btn) btn.textContent = t; }
        function finishBtn(t, ms) {
            endDownload();
            setBtn(t);
            setTimeout(function() {
                setBtn(orig);
                if (btn) btn.disabled = false;
            }, ms || 1500);
        }
        setBtn('Loading...');
        fetchURL(playlistUrl, window.location.href, function(err, content) {
            if (err || !content) {
                dwarn('downloadHlsSubtitle: playlist fetch failed err=' + err);
                openFallbackTab(playlistUrl);
                finishBtn('Error', 2000);
                return;
            }
            var baseDir = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
            var segments = [];
            var lines = content.split('\n');
            var pendingDur = 0;
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].replace(/\r/g, '').trim();
                if (line.indexOf('#EXTINF:') === 0) {
                    var dm = line.match(/#EXTINF:([\d.]+)/);
                    pendingDur = dm ? parseFloat(dm[1]) : 0;
                    // Reject NaN/negative/huge durations; clamp to sane max.
                    if (!isFinite(pendingDur) || pendingDur < 0 || pendingDur > 86400) pendingDur = 0;
                } else if (line && line.indexOf('#') !== 0) {
                    segments.push({ url: resolveUrl(line, baseDir), dur: pendingDur });
                    pendingDur = 0;
                }
            }
            if (segments.length === 0) {
                dwarn('downloadHlsSubtitle: playlist has zero segments');
                finishBtn('No segments', 2000);
                return;
            }
            dlog('downloadHlsSubtitle: ' + segments.length + ' segments to fetch');
            var segData = [];
            var idx = 0;
            var cumMs = 0;
            var failedSegs = 0;
            setBtn('0/' + segments.length);
            function fetchNext() {
                if (idx >= segments.length) {
                    dlog('downloadHlsSubtitle: done, segments=' + segments.length + ' failed=' + failedSegs);
                    try {
                        var srt = buildSrt(segData);
                        // Sanity: refuse to save garbage when no cues were found
                        // (e.g. binary/fmp4 segments instead of WebVTT text).
                        if (srt.indexOf('-->') < 0) {
                            finishBtn('Error', 2000);
                        } else {
                            var fname = filename;
                            if (!/\.srt$/i.test(fname)) fname += '.srt';
                            if (saveTextFile(fname, srt)) {
                                finishBtn(failedSegs > 0 ? ('Saved (' + failedSegs + ' failed)') : 'Saved!', 2000);
                            } else {
                                finishBtn('Error', 2000);
                            }
                        }
                    } catch(e) {
                        finishBtn('Error', 2000);
                    }
                    return;
                }
                var seg = segments[idx];
                var myOffset = cumMs;
                cumMs += Math.round((seg.dur || 0) * 1000);
                fetchURL(seg.url, window.location.href, function(err2, segText) {
                    if (!err2 && segText) {
                        segData.push({ text: segText, offsetMs: myOffset });
                    } else {
                        failedSegs++;
                    }
                    idx++;
                    setBtn(idx + '/' + segments.length);
                    fetchNext();
                }, 30000);
            }
            fetchNext();
        }, 30000);
    }

    // --- JSON extraction with balanced brace/bracket matching ---

    function extractBalancedJson(str, startPos) {
        if (typeof str !== 'string' || !str) return null;
        if (typeof startPos !== 'number' || startPos < 0 || startPos >= str.length) return null;
        var startCh = str.charAt(startPos);
        if (startCh !== '{' && startCh !== '[') return null;
        var openCh = startCh;
        var closeCh = openCh === '{' ? '}' : ']';
        var depth = 0;
        var inString = false;
        var escaped = false;
        for (var i = startPos; i < str.length; i++) {
            var ch = str.charAt(i);
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;
            if (ch === openCh) {
                depth++;
            } else if (ch === closeCh) {
                depth--;
                if (depth === 0) {
                    return str.substring(startPos, i + 1);
                }
            }
        }
        return null;
    }

    // --- Extraction from the player.php page HTML ---

    // Pick the HLS playlist entry; prefer explicit type=hls, then a .m3u8 file,
    // and only then fall back to the first non-null entry.
    function pickHlsItem(list) {
        if (!list || !list.length) return null;
        var first = null;
        var m3u8Item = null;
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (!it) continue;
            if (!first) first = it;
            var ty = it.type;
            if (typeof ty === 'string' && ty.toLowerCase() === 'hls') return it;
            if (typeof it.file === 'string' && /\.m3u8(\?|#|$)/i.test(it.file) && !m3u8Item) m3u8Item = it;
        }
        // Prefer an explicit .m3u8 entry over a non-HLS first entry (e.g. ad/mp4).
        return m3u8Item || first;
    }

    function extractFromPlayerPage(html) {
        var result = { m3u8: null, srt: [], qualities: [], hlsSubtitles: [] };

        // Method 1: var playData = [...];  (contains file + tracks directly)
        var pdIdx = html.indexOf('var playData');
        if (pdIdx >= 0) {
            var arrStart = html.indexOf('[', pdIdx);
            if (arrStart >= 0) {
                var arrStr = extractBalancedJson(html, arrStart);
                if (arrStr) {
                    try {
                        var playData = JSON.parse(arrStr);
                        if (playData && playData.length > 0) {
                            var item = pickHlsItem(playData);
                            if (item && typeof item.file === 'string' && item.file) {
                                result.m3u8 = item.file.replace(/\\\//g, '/');
                            }
                            if (item && item.tracks && item.tracks.length) {
                                for (var t = 0; t < item.tracks.length; t++) {
                                    var tr = item.tracks[t];
                                    if (!tr || typeof tr.file !== 'string' || !tr.file) continue;
                                    result.srt.push({
                                        url: tr.file.replace(/\\\//g, '/'),
                                        label: tr.label || ('Track ' + (t + 1)),
                                        lang: tr.srclang || 'hu'
                                    });
                                }
                            }
                        }
                    } catch(e) {}
                }
            }
        }

        // Method 2: pl.setup({...});  (contains playlist array)
        if (!result.m3u8) {
            var psIdx = html.indexOf('pl.setup(');
            if (psIdx >= 0) {
                var jsonStart = html.indexOf('{', psIdx);
                if (jsonStart >= 0) {
                    var jsonStr = extractBalancedJson(html, jsonStart);
                    if (jsonStr) {
                        try {
                            var setup = JSON.parse(jsonStr);
                            if (setup.playlist && setup.playlist.length > 0) {
                                var item2 = pickHlsItem(setup.playlist);
                                if (item2 && typeof item2.file === 'string' && item2.file) {
                                    result.m3u8 = item2.file.replace(/\\\//g, '/');
                                }
                                if (item2 && item2.tracks && item2.tracks.length) {
                                    for (var t2 = 0; t2 < item2.tracks.length; t2++) {
                                        var tr2 = item2.tracks[t2];
                                        if (!tr2 || typeof tr2.file !== 'string' || !tr2.file) continue;
                                        result.srt.push({
                                            url: tr2.file.replace(/\\\//g, '/'),
                                            label: tr2.label || ('Track ' + (t2 + 1)),
                                            lang: tr2.srclang || 'hu'
                                        });
                                    }
                                }
                            }
                        } catch(e) {}
                    }
                }
            }
        }

        // Method 3: fallback regex for m3u8
        if (!result.m3u8) {
            var fileMatch = html.match(/"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/);
            if (fileMatch) {
                result.m3u8 = fileMatch[1].replace(/\\\//g, '/');
            }
        }

        // Method 4: fallback for srt
        if (result.srt.length === 0) {
            var srtMatches = html.match(/"file"\s*:\s*"([^"]+\.srt[^"]*)"/g);
            if (srtMatches) {
                for (var s = 0; s < srtMatches.length; s++) {
                    var sUrl = srtMatches[s].match(/"file"\s*:\s*"([^"]+)"/);
                    if (sUrl) {
                        result.srt.push({ url: sUrl[1].replace(/\\\//g, '/'), label: 'Magyar', lang: 'hu' });
                    }
                }
            }
        }

        // Method 5: subtitlePath query param on the page URL (fallback)
        if (result.srt.length === 0 && result.m3u8) {
            var q = window.location.search || '';
            var sp = q.match(/[?&]subtitlePath=([^&]+)/);
            if (sp) {
                var subPath = sp[1];
                try { subPath = decodeURIComponent(subPath); }
                catch(e) {}
                subPath = subPath.replace(/\\\//g, '/');
                var fullSrt;
                if (subPath.indexOf('http://') === 0 || subPath.indexOf('https://') === 0 || subPath.indexOf('//') === 0) {
                    fullSrt = subPath;
                } else {
                    var base = result.m3u8.split('/');
                    base.pop();
                    fullSrt = base.join('/') + subPath;
                }
                result.srt.push({
                    url: fullSrt,
                    label: 'Magyar',
                    lang: 'hu'
                });
            }
        }

        // Normalize any protocol-relative URLs (//cdn...) to https.
        if (result.m3u8) result.m3u8 = normalizeUrl(result.m3u8);
        for (var n = 0; n < result.srt.length; n++) {
            result.srt[n].url = normalizeUrl(result.srt[n].url);
        }

        return result;
    }

    // --- Clipboard ---

    // Returns true when the copy is believed to have succeeded.
    function copyToClipboard(text) {
        if (typeof GM_setClipboard === 'function') {
            try {
                GM_setClipboard(text);
                return true;
            } catch(e) {}
        }
        var ok = false;
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:none;outline:none;box-shadow:none;background:transparent;color:transparent;';
        try {
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            ok = document.execCommand('copy') ? true : false;
        } catch(e) {
            ok = false;
        }
        try {
            document.body.removeChild(ta);
        } catch(e2) {}
        return ok;
    }

    // --- Download via GM_xmlhttpRequest (bypasses CORS) ---

    // done codes: null = saved, 'opened' = fallback tab opened,
    // 'blocked' = popup blocked, anything else = error text.
    function openFallbackTab(url) {
        var w = null;
        try { w = window.open(url, '_blank'); }
        catch(e) { w = null; }
        return w ? 'opened' : 'blocked';
    }

    function downloadFile(url, filename, done) {
        if (!tryStartDownload()) {
            dwarn('downloadFile: blocked, another download in progress');
            if (done) done('busy');
            return;
        }
        dlog('downloadFile: start direct download of ' + filename);
        if (typeof GM_xmlhttpRequest !== 'function') {
            endDownload();
            if (done) done('gm-missing');
            return;
        }
        try {
            GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            responseType: 'blob',
            timeout: 60000,
            onload: function(resp) {
                var blob = resp ? resp.response : null;
                // Duck-type check: some Violentmonkey versions return text even when
                // responseType is requested. If we don't have a real Blob, open in a tab.
                if (blob && typeof blob === 'object' && typeof blob.size === 'number') {
                    try {
                        var blobUrl = URL.createObjectURL(blob);
                        var a = document.createElement('a');
                        a.href = blobUrl;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        // Long delay: slow machines need time to start the download.
                        setTimeout(function() {
                            try { document.body.removeChild(a); } catch(e) {}
                            URL.revokeObjectURL(blobUrl);
                        }, 1000);
                        endDownload();
                        if (done) done(null);
                    } catch(e) {
                        endDownload();
                        if (done) done(openFallbackTab(url));
                    }
                } else {
                    endDownload();
                    if (done) done(openFallbackTab(url));
                }
            },
            ontimeout: function() {
                endDownload();
                if (done) done(openFallbackTab(url));
            },
            onerror: function() {
                endDownload();
                if (done) done(openFallbackTab(url));
            }
        });
        } catch(e) {
            endDownload();
            if (done) done('gm-error');
        }
    }

    // --- UI: Panel ---

    // invalidate=true cancels pending async paints (explicit dismiss or
    // navigation). Internal re-creation via createPanel must NOT bump,
    // or it would invalidate the render that is about to paint.
    function closePanel(invalidate) {
        if (invalidate) {
            renderGen++;
            currentData = null;
        }
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        panel = null;
        allUrlSpans = [];
    }

    function createPanel() {
        closePanel();

        var savedX = getVal('posX', 10);
        var savedY = getVal('posY', 10);
        var savedMin = getVal('minimized', false) === true;
        var savedW = getVal('winW', 360);
        var savedH = getVal('winH', 480);
        // Clamp stored size/position: corrupt values or a smaller viewport
        // must not collapse, explode, or push the panel off-screen.
        if (typeof savedW !== 'number' || !isFinite(savedW) || savedW < 240) savedW = 360;
        if (typeof savedH !== 'number' || !isFinite(savedH) || savedH < 120) savedH = 480;
        try {
            var vw = window.innerWidth || 1024;
            var vh = window.innerHeight || 768;
            if (typeof savedX !== 'number' || !isFinite(savedX)) savedX = 10;
            if (typeof savedY !== 'number' || !isFinite(savedY)) savedY = 10;
            savedX = Math.max(0, Math.min(savedX, vw - 60));
            savedY = Math.max(0, Math.min(savedY, vh - 30));
            savedW = Math.min(savedW, vw - 20);
            savedH = Math.min(savedH, vh - 20);
        } catch(e) {}

        panel = document.createElement('div');
        panel.id = 'mkext-panel';
        panel.style.cssText = 'position:fixed;z-index:2147483647;background:' + PANEL_BG + ';' +
            'border:1px solid rgba(100,140,200,0.4);border-radius:8px;color:#e0e0e0;' +
            'font-family:Arial,Helvetica,sans-serif;font-size:13px;padding:0;' +
            'box-shadow:0 4px 20px rgba(0,0,0,0.5);min-width:240px;overflow:hidden;' +
            'display:flex;flex-direction:column;';

        panel.style.width = savedW + 'px';
        panel.style.height = savedH + 'px';

        // Header
        var header = document.createElement('div');
        header.style.cssText = 'background:' + HEADER_BG + ';padding:6px 10px;cursor:move;' +
            'display:flex;align-items:center;justify-content:space-between;border-radius:7px 7px 0 0;' +
            'user-select:none;-moz-user-select:none;flex-shrink:0;';

        var title = document.createElement('span');
        title.style.cssText = 'font-weight:bold;font-size:13px;color:#7ab8ff;flex:1;';
        title.textContent = 'Extractor';

        var btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display:flex;align-items:center;';

        // Show URLs checkbox
        var showUrls = getVal('showUrls', true) === true;

        var cbWrap = document.createElement('label');
        cbWrap.style.cssText = 'display:flex;align-items:center;font-size:11px;color:#aaa;cursor:pointer;margin-right:8px;';

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = showUrls;
        cb.style.cssText = 'margin:0;cursor:pointer;';
        cb.addEventListener('change', function() {
            setVal('showUrls', cb.checked);
            for (var i = 0; i < allUrlSpans.length; i++) {
                allUrlSpans[i].style.display = cb.checked ? '' : 'none';
            }
        });

        var cbText = document.createElement('span');
        cbText.textContent = 'URLs';
        cbWrap.appendChild(cb);
        cbWrap.appendChild(cbText);
        btnGroup.appendChild(cbWrap);

        // Minimize button
        var minBtn = document.createElement('button');
        minBtn.textContent = '-';
        minBtn.title = 'Minimize';
        minBtn.style.cssText = 'width:22px;height:22px;border:none;border-radius:4px;' +
            'background:rgba(255,255,255,0.1);color:#ccc;font-size:15px;cursor:pointer;line-height:1;margin-right:4px;';
        minBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleMinimize();
        });

        // Close button
        var closeBtn = document.createElement('button');
        closeBtn.textContent = 'x';
        closeBtn.title = 'Close';
        closeBtn.style.cssText = 'width:22px;height:22px;border:none;border-radius:4px;' +
            'background:rgba(255,100,100,0.2);color:#f88;font-size:15px;cursor:pointer;line-height:1;';
        closeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            closePanel(true);
        });

        btnGroup.appendChild(minBtn);
        btnGroup.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(btnGroup);

        // Body
        var body = document.createElement('div');
        body.id = 'mkext-body';
        body.style.cssText = 'padding:8px 10px;overflow-y:auto;flex:1;min-height:0;';

        if (savedMin) {
            body.style.display = 'none';
            panel.style.minWidth = 'auto';
            panel.style.width = 'auto';
            panel.style.height = 'auto';
        }

        // Resize handle (bottom-right corner)
        var resizeHandle = document.createElement('div');
        resizeHandle.style.cssText = 'position:absolute;right:2px;bottom:2px;width:16px;height:16px;' +
            'cursor:nwse-resize;z-index:20;opacity:0.5;background:' +
            'linear-gradient(135deg, transparent 0 50%, #7ab8ff 50% 100%);' +
            'background-size:10px 10px;background-repeat:no-repeat;background-position:right bottom;';
        resizeHandle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            e.stopPropagation();
            isResizing = true;
            resizeStartW = panel.offsetWidth;
            resizeStartH = panel.offsetHeight;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;
        });

        panel.appendChild(header);
        panel.appendChild(body);
        panel.appendChild(resizeHandle);

        panel.style.left = savedX + 'px';
        panel.style.top = savedY + 'px';

        // Drag (but never when interacting with header controls)
        header.addEventListener('mousedown', function(e) {
            var t = e.target;
            if (t === minBtn || t === closeBtn || t === cb || t === cbWrap || t === cbText) return;
            isDragging = true;
            dragOffsetX = e.clientX - panel.offsetLeft;
            dragOffsetY = e.clientY - panel.offsetTop;
            e.preventDefault();
        });

        setupDragListeners();
        document.body.appendChild(panel);
        return body;
    }

    // Register the document-level drag/resize listeners exactly once
    function setupDragListeners() {
        if (setupDragListeners.done) return;
        setupDragListeners.done = true;

        document.addEventListener('mousemove', function(e) {
            if (isResizing && panel) {
                var w = resizeStartW + (e.clientX - resizeStartX);
                var h = resizeStartH + (e.clientY - resizeStartY);
                w = Math.max(240, Math.min(w, window.innerWidth - 20));
                h = Math.max(120, Math.min(h, window.innerHeight - 20));
                panel.style.width = w + 'px';
                panel.style.height = h + 'px';
                return;
            }
            if (!isDragging || !panel) return;
            var nx = e.clientX - dragOffsetX;
            var ny = e.clientY - dragOffsetY;
            nx = Math.max(0, Math.min(nx, window.innerWidth - 60));
            ny = Math.max(0, Math.min(ny, window.innerHeight - 30));
            panel.style.left = nx + 'px';
            panel.style.top = ny + 'px';
        });

        document.addEventListener('mouseup', function() {
            if (isResizing && panel) {
                isResizing = false;
                // Never persist the collapsed header-only size.
                var bd = document.getElementById('mkext-body');
                if (!bd || bd.style.display !== 'none') {
                    setVal('winW', panel.offsetWidth);
                    setVal('winH', panel.offsetHeight);
                }
                return;
            }
            if (isDragging && panel) {
                isDragging = false;
                setVal('posX', panel.offsetLeft);
                setVal('posY', panel.offsetTop);
            }
        });
    }

    function toggleMinimize() {
        if (!panel) return;
        var body = document.getElementById('mkext-body');
        if (!body) return;
        var minimized = body.style.display === 'none';
        if (minimized) {
            body.style.display = '';
            panel.style.minWidth = '240px';
            var rw = getVal('winW', 360);
            var rh = getVal('winH', 480);
            try {
                var vw2 = window.innerWidth || 1024;
                var vh2 = window.innerHeight || 768;
                if (typeof rw !== 'number' || !isFinite(rw) || rw < 240) rw = 360;
                if (typeof rh !== 'number' || !isFinite(rh) || rh < 120) rh = 480;
                rw = Math.min(rw, vw2 - 20);
                rh = Math.min(rh, vh2 - 20);
            } catch(e) {
                rw = 360; rh = 480;
            }
            panel.style.width = rw + 'px';
            panel.style.height = rh + 'px';
            panel.style.background = PANEL_BG;
            setVal('minimized', false);
        } else {
            body.style.display = 'none';
            panel.style.minWidth = 'auto';
            panel.style.width = 'auto';
            panel.style.height = 'auto';
            panel.style.background = PANEL_MINIMIZED_BG;
            setVal('minimized', true);
        }
    }

    // --- UI: Buttons ---

    function makeCopyBtn(text, label) {
        var btn = document.createElement('button');
        var canonical = label || 'Copy';
        btn.textContent = canonical;
        btn.style.cssText = 'background:rgba(80,140,220,0.25);border:1px solid rgba(80,140,220,0.4);' +
            'color:#8ac;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-left:6px;' +
            'flex-shrink:0;';
        btn.addEventListener('click', function() {
            var ok = false;
            try { ok = copyToClipboard(text) ? true : false; }
            catch(e) { ok = false; }
            if (ok) {
                btn.textContent = 'Copied!';
                btn.style.background = 'rgba(80,200,120,0.3)';
                btn.style.borderColor = 'rgba(80,200,120,0.5)';
                btn.style.color = '#8c8';
            } else {
                btn.textContent = 'Copy failed';
                btn.style.background = 'rgba(200,80,80,0.3)';
                btn.style.borderColor = 'rgba(200,80,80,0.5)';
                btn.style.color = '#f88';
            }
            setTimeout(function() {
                btn.textContent = canonical;
                btn.style.background = '';
                btn.style.borderColor = '';
                btn.style.color = '';
            }, 1500);
        });
        return btn;
    }

    function makeDownloadBtn(url, filename) {
        var btn = document.createElement('button');
        btn.textContent = 'Download';
        btn.style.cssText = 'background:rgba(220,140,40,0.25);border:1px solid rgba(220,140,40,0.4);' +
            'color:#da8;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-left:6px;' +
            'flex-shrink:0;';
        btn.addEventListener('click', function() {
            if (btn.disabled) return;
            btn.disabled = true;
            btn.textContent = 'Loading...';
            try {
                downloadFile(url, filename, function(err) {
                    btn.disabled = false;
                    if (!err) {
                        btn.textContent = 'Saved!';
                    } else if (err === 'opened') {
                        btn.textContent = 'Opened in tab';
                    } else if (err === 'blocked') {
                        btn.textContent = 'Popup blocked';
                    } else if (err === 'busy') {
                        btn.textContent = 'Busy';
                    } else {
                        btn.textContent = 'Error';
                    }
                    setTimeout(function() { btn.textContent = 'Download'; }, 2000);
                });
            } catch(e) {
                btn.disabled = false;
                btn.textContent = 'Error';
                setTimeout(function() { btn.textContent = 'Download'; }, 2000);
            }
        });
        return btn;
    }

    // Download button for HLS-embedded subtitles: assembles the WebVTT
    // segments into a single .srt file instead of downloading the .m3u8.
    function makeHlsDownloadBtn(playlistUrl, filename) {
        var btn = document.createElement('button');
        btn.textContent = 'Download';
        btn.style.cssText = 'background:rgba(220,140,40,0.25);border:1px solid rgba(220,140,40,0.4);' +
            'color:#da8;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-left:6px;' +
            'flex-shrink:0;';
        btn.addEventListener('click', function() {
            if (btn.disabled) return;
            btn.disabled = true;
            downloadHlsSubtitle(playlistUrl, filename, btn);
        });
        return btn;
    }

    // --- UI: URL row ---

    function buildUrlRow(fullUrl) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;';

        var urlSpan = document.createElement('span');
        urlSpan.style.cssText = 'word-break:break-all;font-size:10px;color:#999;flex:1;min-width:80px;';
        urlSpan.textContent = fullUrl;

        var showUrls = getVal('showUrls', true) === true;
        if (!showUrls) urlSpan.style.display = 'none';
        allUrlSpans.push(urlSpan);

        wrap.appendChild(urlSpan);
        wrap.appendChild(makeCopyBtn(fullUrl, 'Copy'));
        return wrap;
    }

    // --- Subtitle filename helper ---

    // Use the original SRT filename as served by mediaklikk (e.g. 1983-100161-M0001-05_3700_hun.srt).
    // Ensures an .srt extension and a safe, bounded filename for the save dialog.
    function getSrtFilename(url) {
        try {
            if (typeof url !== 'string' || !url) return 'subtitle.srt';
            var fn = url.split('?')[0].split('#')[0].split('/').pop();
            if (!fn) return 'subtitle.srt';
            // Strip illegal Windows characters and control chars.
            fn = fn.replace(/[\\/:*?"<>|\x00-\x1F]/g, '-');
            if (fn.length > 120) {
                var ext = /\.srt$/i.test(fn) ? fn.substring(fn.length - 4) : '';
                fn = fn.substring(0, 120 - ext.length) + ext;
            }
            if (fn.indexOf('.') < 0) fn += '.srt';
            return fn || 'subtitle.srt';
        } catch(e) {}
        return 'subtitle.srt';
    }

    // --- Render results ---

    // Re-fetch a failed master playlist and re-render with fresh gen.
    function retryMasterFetch(data) {
        if (!data || !data.m3u8) return;
        var gen = ++renderGen;
        showLoading();
        fetchURL(data.m3u8, window.location.href, function(err, content) {
            if (gen !== renderGen) return;
            if (!err && content && content.indexOf('#EXTM3U') >= 0) {
                data.qualities = parseM3U8Variants(content, data.m3u8);
                data.hlsSubtitles = parseM3U8Subtitles(content, data.m3u8);
                data.loadError = false;
            } else {
                data.loadError = true;
            }
            renderResults(data);
        }, 30000);
    }

    function renderResults(data) {
        dlog('renderResults: m3u8=' + (data.m3u8 ? 'yes' : 'no') +
             ' srtTracks=' + data.srt.length + ' hlsSubtitles=' + data.hlsSubtitles.length +
             ' qualities=' + data.qualities.length +
             ' loadError=' + (data.loadError ? 'yes' : 'no'));
        currentData = data;
        var body = createPanel();
        body.innerHTML = '';

        if (!data.m3u8 && data.srt.length === 0 && data.hlsSubtitles.length === 0) {
            var noRes = document.createElement('div');
            noRes.style.cssText = 'color:#f88;padding:10px;text-align:center;';
            noRes.textContent = 'No streams found in player.';
            body.appendChild(noRes);
            return;
        }

        // Master playlist
        if (data.m3u8) {
            var masterSection = document.createElement('div');
            masterSection.style.cssText = 'margin-bottom:10px;';

            var masterLabel = document.createElement('div');
            masterLabel.style.cssText = 'font-weight:bold;color:#7ab8ff;margin-bottom:4px;font-size:12px;';
            masterLabel.textContent = 'Master Playlist (all qualities)';
            masterSection.appendChild(masterLabel);
            masterSection.appendChild(buildUrlRow(data.m3u8));
            body.appendChild(masterSection);
        }

        // Master fetch failed: warn but keep the master link usable.
        if (data.loadError) {
            var warnSection = document.createElement('div');
            warnSection.style.cssText = 'background:rgba(200,80,80,0.12);border:1px solid rgba(200,80,80,0.4);' +
                'border-radius:4px;padding:6px 8px;margin-bottom:10px;font-size:12px;color:#f88;';
            warnSection.textContent = 'Quality list failed to load. ';
            var retryBtn = document.createElement('button');
            retryBtn.textContent = 'Retry';
            retryBtn.style.cssText = 'background:rgba(80,140,220,0.25);border:1px solid rgba(80,140,220,0.4);' +
                'color:#8ac;padding:2px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-left:6px;';
            retryBtn.addEventListener('click', function() {
                retryMasterFetch(data);
            });
            warnSection.appendChild(retryBtn);
            body.appendChild(warnSection);
        }

        // Quality variants
        if (data.qualities.length > 0) {
            var qSection = document.createElement('div');
            qSection.style.cssText = 'margin-bottom:10px;';

            var qLabel = document.createElement('div');
            qLabel.style.cssText = 'font-weight:bold;color:#7ab8ff;margin-bottom:6px;font-size:12px;';
            qLabel.textContent = 'Quality Variants (' + data.qualities.length + ')';
            qSection.appendChild(qLabel);

            for (var q = 0; q < data.qualities.length; q++) {
                var v = data.qualities[q];
                var vRow = document.createElement('div');
                vRow.style.cssText = 'background:rgba(255,255,255,0.04);border-radius:4px;padding:6px 8px;margin-bottom:4px;';

                var vTitle = document.createElement('div');
                vTitle.style.cssText = 'font-weight:bold;font-size:12px;color:#ccc;margin-bottom:3px;';
                vTitle.textContent = v.label;
                vRow.appendChild(vTitle);
                vRow.appendChild(buildUrlRow(v.url));
                qSection.appendChild(vRow);
            }
            body.appendChild(qSection);
        }

        // Subtitles
        var sSection = document.createElement('div');
        var sLabel = document.createElement('div');
        sLabel.style.cssText = 'font-weight:bold;color:#7ab8ff;margin-bottom:6px;font-size:12px;';

        var hasAnySub = (data.srt.length > 0) || (data.hlsSubtitles.length > 0);

        if (data.srt.length > 0) {
            sLabel.textContent = 'Subtitles (SRT)';
            sSection.appendChild(sLabel);

            for (var s = 0; s < data.srt.length; s++) {
                var sub = data.srt[s];
                var sRow = document.createElement('div');
                sRow.style.cssText = 'background:rgba(255,255,255,0.04);border-radius:4px;padding:6px 8px;margin-bottom:4px;';

                var sTitle = document.createElement('div');
                sTitle.style.cssText = 'font-weight:bold;font-size:12px;color:#ccc;margin-bottom:3px;';
                sTitle.textContent = sub.label + (sub.lang ? ' [' + sub.lang + ']' : '');
                sRow.appendChild(sTitle);

                var sUrlWrap = buildUrlRow(sub.url);
                sUrlWrap.appendChild(makeDownloadBtn(sub.url, getSrtFilename(sub.url)));
                sRow.appendChild(sUrlWrap);
                sSection.appendChild(sRow);
            }
        }

        if (data.hlsSubtitles.length > 0) {
            if (data.srt.length > 0) {
                sLabel = document.createElement('div');
                sLabel.style.cssText = 'font-weight:bold;color:#7ab8ff;margin-top:8px;margin-bottom:6px;font-size:12px;';
            }
            sLabel.textContent = 'Subtitles (HLS embedded)';
            sSection.appendChild(sLabel);

            for (var h = 0; h < data.hlsSubtitles.length; h++) {
                var hsub = data.hlsSubtitles[h];
                var hRow = document.createElement('div');
                hRow.style.cssText = 'background:rgba(255,255,255,0.04);border-radius:4px;padding:6px 8px;margin-bottom:4px;';

                var hTitle = document.createElement('div');
                hTitle.style.cssText = 'font-weight:bold;font-size:12px;color:#ccc;margin-bottom:3px;';
                hTitle.textContent = hsub.name + ' [' + hsub.lang + ']';
                hRow.appendChild(hTitle);

                var hUrlWrap = buildUrlRow(hsub.url);
                hUrlWrap.appendChild(makeHlsDownloadBtn(hsub.url, 'subtitle_' + hsub.lang + '.srt'));
                hRow.appendChild(hUrlWrap);
                sSection.appendChild(hRow);
            }
        }

        if (!hasAnySub) {
            sLabel.style.cssText = 'font-weight:bold;color:#888;margin-bottom:6px;font-size:12px;';
            sLabel.textContent = 'No subtitles available';
            sSection.appendChild(sLabel);
        }
        body.appendChild(sSection);
    }

    // --- Loading / Error states ---

    function showLoading() {
        var body = createPanel();
        body.innerHTML = '<div style="text-align:center;padding:16px;color:#7ab8ff;">' +
            '<div>Extracting streams...</div></div>';
    }

    // --- Core logic ---

    // Master playlist URL currently shown in the panel.
    var currentM3u8 = null;
    var lastVideoToken = null;
    var lastVideoPermalink = null;
    // Timestamp of the last trusted load-video message. Token/permalink are
    // only trusted while fresh, so a new video never inherits stale ones.
    var lastVideoMsgAt = 0;
    // Last data object painted by renderResults (for late enrichment).
    var currentData = null;
    // Only one heavy download at a time. Running a local slice merge AND a
    // proxy merge simultaneously hammers the same CDN from the same client
    // IP and triggers throttling that hangs the local chain.
    var downloadBusy = false;

    function tryStartDownload(btn) {
        if (downloadBusy) {
            dwarn('tryStartDownload: REJECTED - another download in progress');
            if (btn) {
                var orig = btn.textContent;
                btn.textContent = 'Busy';
                btn.disabled = false;
                setTimeout(function() { btn.textContent = orig; }, 1500);
            }
            return false;
        }
        downloadBusy = true;
        return true;
    }
    function endDownload() {
        if (downloadBusy) dlog('endDownload: download slot released');
        downloadBusy = false;
    }
    // Render generation: only the newest requested render may paint the panel,
    // so a slow fetch from a previous video can never overwrite a newer one.
    var renderGen = 0;

    function processPlayerPage(html, referer) {
        dlog('processPlayerPage: initial extraction from player page HTML');
        var data = extractFromPlayerPage(html);
        dlog('processPlayerPage: m3u8=' + (data.m3u8 ? 'yes' : 'no') +
             ' srtTracks=' + data.srt.length + ' hlsSubtitles=' + data.hlsSubtitles.length);
        if (data.m3u8) {
            currentM3u8 = data.m3u8;
            var gen = ++renderGen;
            fetchURL(data.m3u8, referer, function(err, content) {
                if (gen !== renderGen) return;
                if (!err && content && content.indexOf('#EXTM3U') >= 0) {
                    data.qualities = parseM3U8Variants(content, data.m3u8);
                    data.hlsSubtitles = parseM3U8Subtitles(content, data.m3u8);
                } else {
                    if (err) dwarn('processPlayerPage: master fetch err=' + err);
                    else dwarn('processPlayerPage: master fetch returned non-m3u8 body (' + (content ? content.length : 0) + ' bytes)');
                    data.loadError = true;
                }
                renderResults(data);
            }, 30000);
        } else {
            ++renderGen;
            renderResults(data);
        }
    }

    // Render a newly loaded video (recommended / direct change inside the iframe).
    // Optionally also fetches the subtitle for the given token.
    function renderNewVideo(m3u8Url, token) {
        if (typeof m3u8Url !== 'string' || !m3u8Url) return;
        m3u8Url = normalizeUrl(m3u8Url);
        if (m3u8Url === currentM3u8) return;
        dlog('renderNewVideo: new video detected, m3u8=' + m3u8Url.substring(0, 80) + '... token=' + (token ? 'yes' : 'no'));
        currentM3u8 = m3u8Url;
        var gen = ++renderGen;
        // Bind token + permalink to THIS render only when they come from a
        // recent trusted message; otherwise render m3u8-derived data only.
        var freshMsg = (Date.now() - lastVideoMsgAt) < 15000;
        var tok = token || (freshMsg ? lastVideoToken : null);
        var pageUrl = freshMsg ? lastVideoPermalink : null;
        dlog('renderNewVideo: freshMsg=' + freshMsg + ' tok=' + (tok ? 'yes' : 'no') + ' pageUrl=' + (pageUrl ? 'yes' : 'no'));
        showLoading();

        fetchURL(m3u8Url, window.location.href, function(err, content) {
            if (gen !== renderGen) return;
            var data = { m3u8: m3u8Url, srt: [], qualities: [], hlsSubtitles: [] };
            if (!err && content && content.indexOf('#EXTM3U') >= 0) {
                data.qualities = parseM3U8Variants(content, m3u8Url);
                data.hlsSubtitles = parseM3U8Subtitles(content, m3u8Url);
            } else {
                if (err) dwarn('renderNewVideo: master fetch err=' + err);
                else dwarn('renderNewVideo: master returned non-m3u8 body (' + (content ? content.length : 0) + ' bytes)');
                data.loadError = true;
            }
            if (tok) {
                // Try to also grab this video's sidecar subtitle.
                if (pageUrl) {
                    // Recommended videos: recover it via the video's page.
                    fetchSubtitleFromPermalink(pageUrl, tok, data, gen);
                } else {
                    var playerUrl = 'https://player.mediaklikk.hu/playernew/player.php?video=' + tok;
                    fetchURL(playerUrl, window.location.href, function(err2, html) {
                        if (gen !== renderGen) return;
                        if (!err2 && html) {
                            var sub = extractFromPlayerPage(html);
                            if (sub && sub.srt.length > 0) data.srt = sub.srt;
                        }
                        renderResults(data);
                    }, 30000);
                }
            } else {
                renderResults(data);
            }
        });
    }

    // Normalize a token captured from a message or a get_video_url URL.
    // get_video_url.php double-encodes the token, so decode it once to the
    // single-encoded form that player.php?video= expects. If decoding would
    // produce raw whitespace (i.e. input was only single-encoded), keep the
    // input unchanged so the URL never breaks. Non-strings pass through.
    function normalizeToken(str) {
        if (!str || typeof str !== 'string') return str;
        try {
            var dec = decodeURIComponent(str);
            if (/[\s]/.test(dec)) return str;
            return dec;
        } catch(e) {
            return str;
        }
    }

    // Extract the loadPlayer(...) config object from a video's page HTML.
    function extractLoadPlayerFromPage(html) {
        var lpIdx = html.indexOf('loadPlayer(');
        if (lpIdx >= 0) {
            var jsonStart = html.indexOf('{', lpIdx);
            if (jsonStart >= 0) {
                var jsonStr = extractBalancedJson(html, jsonStart);
                if (jsonStr) {
                    try {
                        return JSON.parse(jsonStr);
                    } catch(e) {}
                }
            }
        }
        return null;
    }

    // Normalize subtitlePath which may be a string or an array.
    function getFirstSubtitlePath(cfg) {
        if (!cfg) return null;
        var sp = cfg.subtitlePath;
        if (sp === null || sp === undefined) return null;
        if (typeof sp === 'string') return sp || null;
        if (Array.isArray(sp) && sp.length > 0 && typeof sp[0] === 'string' && sp[0]) return sp[0];
        return null;
    }

    // For recommended videos the player page is never re-rendered, so the
    // sidecar subtitle must be recovered via the video's own page: fetch the
    // permalink, read subtitlePath from its loadPlayer config, then ask
    // player.php for the playData (which contains the full srt URL).
    function fetchSubtitleFromPermalink(permalink, token, data, gen) {
        if (typeof permalink !== 'string' || !permalink) {
            renderResults(data);
            return;
        }
        fetchURL(permalink, window.location.href, function(err, html) {
            if (gen !== renderGen) return;
            if (err || !html) {
                renderResults(data);
                return;
            }
            var cfg = extractLoadPlayerFromPage(html);
            var subtitlePath = getFirstSubtitlePath(cfg);
            var tk = token || (cfg ? cfg.token : null);
            if (subtitlePath && tk) {
                var playerUrl = 'https://player.mediaklikk.hu/playernew/player.php?video=' + tk +
                    '&subtitlePath=' + encodeURIComponent(subtitlePath);
                fetchURL(playerUrl, window.location.href, function(err2, html2) {
                    if (gen !== renderGen) return;
                    if (!err2 && html2) {
                        var sub = extractFromPlayerPage(html2);
                        if (sub && sub.srt.length > 0) data.srt = sub.srt;
                    }
                    renderResults(data);
                }, 30000);
            } else {
                renderResults(data);
            }
        }, 30000);
    }

    // Detect when the player loads a new video without the iframe URL changing
    // (recommended videos / direct video changes from the parent page).
    function hookVideoChanges() {
        if (hookVideoChanges.done) return;
        hookVideoChanges.done = true;
        // Shared sentinel: if the manager injects this script twice into the
        // same document, never wrap the shared XHR prototype twice.
        try {
            if (window.__mkextHooked) return;
            window.__mkextHooked = true;
        } catch(e) {}

        // 1. get_video_url.php XHR returns {"url": "...index.m3u8"} for the new video.
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function() {
            var self = this;
            var url = arguments.length > 1 ? arguments[1] : null;
            if (typeof url === 'string' && url.indexOf('get_video_url.php') >= 0) {
                var token = '';
                var tm = url.match(/[?&]token=([^&]+)/);
                if (tm) token = normalizeToken(tm[1]);
                this.addEventListener('load', function() {
                    try {
                        var d = JSON.parse(self.responseText);
                        if (d && d.url) {
                            dlog('XHR hook: get_video_url.php -> new video url=' + d.url.substring(0, 80));
                            renderNewVideo(d.url, token || lastVideoToken);
                        } else {
                            dwarn('XHR hook: get_video_url.php response had no url');
                        }
                    } catch(e) {
                        derr('XHR hook: bad JSON from get_video_url.php: ' + e);
                    }
                });
            }
            return origOpen.apply(this, arguments);
        };

        // 2. The player dispatches "video-url-loaded" after pl.load(). Backup path:
        //    read the current file from the player instance.
        document.addEventListener('video-url-loaded', function() {
            var schedGen = renderGen;
            var schedUrl = window.location.href;
            setTimeout(function() {
                if (schedGen !== renderGen) return;
                if (window.location.href !== schedUrl) return;
                var w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
                try {
                    if (w.pl && w.pl.getPlaylistItem) {
                        var it = w.pl.getPlaylistItem();
                        if (it && it.file) {
                            dlog('video-url-loaded: fallback read new file=' + it.file.substring(0, 80));
                            renderNewVideo(it.file, lastVideoToken);
                        }
                    }
                } catch(e) {
                    derr('video-url-loaded: pl read failed: ' + e);
                }
            }, 250);
        });

        // 3. Parent tells the iframe to play a video -> remember its token and
        //    the video's page URL (permalink), which is needed to recover the
        //    sidecar subtitle for recommended videos. Only accept messages
        //    from MTVA origins so third-party frames cannot trigger fetches.
        window.addEventListener('message', function(event) {
            if (!event.data || event.data.type !== 'load-video') return;
            if (!isTrustedOrigin(event.origin)) return;
            if (event.data.data) {
                var dd = event.data.data;
                var msgToken = (typeof dd.token === 'string' && dd.token && dd.token.length <= 1024) ? dd.token : null;
                var msgPermalink = (typeof dd.file === 'string' && /^https?:\/\//i.test(dd.file) && dd.file.length <= 4096) ? dd.file : null;
                dlog('message: load-video from ' + event.origin + ' token=' + (msgToken ? 'yes' : 'no') + ' permalink=' + (msgPermalink ? 'yes' : 'no'));
                if (msgToken) lastVideoToken = msgToken;
                if (msgPermalink) lastVideoPermalink = msgPermalink;
                lastVideoMsgAt = Date.now();
                // Late-message reconciliation: if the XHR hook already rendered
                // this video WITHOUT subtitle info (message arrived after the
                // render), enrich the current display now.
                var schedGen = renderGen;
                var schedData = currentData;
                setTimeout(function() {
                    if (schedGen !== renderGen) return;
                    if (!schedData || !schedData.m3u8) return;
                    if (currentData !== schedData) return;
                    if (schedData.srt.length > 0) return;
                    if (!msgToken && !msgPermalink) return;
                    var gen = ++renderGen;
                    if (msgPermalink) {
                        fetchSubtitleFromPermalink(msgPermalink, msgToken, schedData, gen);
                    } else {
                        var playerUrl = 'https://player.mediaklikk.hu/playernew/player.php?video=' + msgToken;
                        fetchURL(playerUrl, window.location.href, function(err, html) {
                            if (gen !== renderGen) return;
                            if (!err && html) {
                                var sub = extractFromPlayerPage(html);
                                if (sub && sub.srt.length > 0) schedData.srt = sub.srt;
                            }
                            renderResults(schedData);
                        }, 30000);
                    }
                }, 2000);
            }
        });
    }

    function isTrustedOrigin(origin) {
        return origin === 'https://mediaklikk.hu' ||
               origin === 'https://www.mediaklikk.hu' ||
               origin === 'https://m4sport.hu' ||
               origin === 'https://www.m4sport.hu' ||
               origin === 'https://hirado.hu' ||
               origin === 'https://www.hirado.hu';
    }

    // --- Init ---

    var extractDone = false;
    var attempts = 0;
    var MAX_ATTEMPTS = 30;
    var lastUrl = window.location.href;

    // Reset so a new video / new player URL triggers a fresh extraction.
    // Clears per-video state so a previous video's token, permalink or
    // playlist URL can never leak into the next render, and invalidates
    // any in-flight async callbacks via the render generation.
    function resetExtraction() {
        dlog('resetExtraction: resetting state (URL/navigation change)');
        renderGen++;
        extractDone = false;
        attempts = 0;
        currentM3u8 = null;
        lastVideoToken = null;
        lastVideoPermalink = null;
        closePanel(true);
        setTimeout(tryExtract, 400);
    }

    // Cheap pre-check: scan inline scripts for player markers without
    // serializing the whole document (expensive on slow machines).
    function pageHasPlayerData() {
        try {
            var scripts = document.scripts || document.getElementsByTagName('script');
            for (var i = 0; i < scripts.length; i++) {
                var txt = scripts[i].textContent || '';
                if (txt.indexOf('pl.setup') >= 0 || txt.indexOf('playData') >= 0) return true;
            }
        } catch(e) {}
        return false;
    }

    function tryExtract() {
        dlog('tryExtract: start, attempt=' + attempts);
        if (extractDone) return;
        if (!pageHasPlayerData()) {
            if (attempts < MAX_ATTEMPTS) {
                attempts++;
                setTimeout(tryExtract, 1000);
            } else {
                dlog('tryExtract: exhausted after ' + MAX_ATTEMPTS + ' attempts');
                showExhausted();
            }
            return;
        }
        var html = document.documentElement.innerHTML || '';
        // Only start once the player data is actually present in the page.
        // Retry for up to ~30s to cover slow computers / slow network.
        if (html.indexOf('pl.setup') < 0 && html.indexOf('playData') < 0 && html.indexOf('"file"') < 0) {
            if (attempts < MAX_ATTEMPTS) {
                attempts++;
                setTimeout(tryExtract, 1000);
            } else {
                showExhausted();
            }
            return;
        }
        extractDone = true;
        dlog('tryExtract: player data present, calling processPlayerPage');
        showLoading();
        processPlayerPage(html, window.location.href);
    }

    // Shown when player data never appeared: error + manual retry.
    function showExhausted() {
        if (extractDone) return;
        extractDone = true;
        var body = createPanel();
        body.innerHTML = '';
        var msg = document.createElement('div');
        msg.style.cssText = 'color:#f88;padding:10px;text-align:center;';
        msg.textContent = 'No player data found.';
        body.appendChild(msg);
        var wrap = document.createElement('div');
        wrap.style.cssText = 'text-align:center;padding-bottom:10px;';
        var btn = document.createElement('button');
        btn.textContent = 'Retry';
        btn.style.cssText = 'background:rgba(80,140,220,0.25);border:1px solid rgba(80,140,220,0.4);' +
            'color:#8ac;padding:5px 16px;border-radius:4px;cursor:pointer;font-size:12px;';
        btn.addEventListener('click', function() {
            resetExtraction();
        });
        wrap.appendChild(btn);
        body.appendChild(wrap);
    }

    // Detect when the iframe navigates to a new video (new player.php URL)
    // without a full script re-run (e.g. sandbox reuse, SPA-style updates).
    // Also polls the player instance to catch recommended/direct video changes
    // where the iframe URL stays the same.
    function monitorUrlChanges() {
        window.setInterval(function() {
            if (window.location.href !== lastUrl) {
                dlog('monitorUrlChanges: iframe URL changed -> ' + window.location.href.substring(0, 80));
                lastUrl = window.location.href;
                resetExtraction();
                return;
            }
            var w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            try {
                if (w.pl && w.pl.getPlaylistItem) {
                    var it = w.pl.getPlaylistItem();
                    if (it && it.file && normalizeUrl(it.file) !== currentM3u8) {
                        dlog('monitorUrlChanges: poll detected new file=' + it.file.substring(0, 80));
                        renderNewVideo(it.file, lastVideoToken);
                    }
                }
            } catch(e) {
                derr('monitorUrlChanges: poll read failed: ' + e);
            }
        }, 1500);
    }

    function init() {
        dlog('init: starting, url=' + window.location.href.substring(0, 80));
        lastUrl = window.location.href;
        hookVideoChanges();
        // Immediate feedback so slow loads never look dead.
        try {
            if (document.body) showLoading();
        } catch(e) {}
        setTimeout(tryExtract, 2000);
        monitorUrlChanges();
        // Back/forward cache restore: re-extract even if the URL is unchanged
        window.addEventListener('pageshow', function(e) {
            if (e.persisted) resetExtraction();
        });
    }

    if (document.body) {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', function() {
            setTimeout(init, 200);
        });
    }
})();