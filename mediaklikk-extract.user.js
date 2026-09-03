// ==UserScript==
// @name         MediaKlikk Stream Extractor
// @namespace    mediaklikk-tools
// @version      1.4.4
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

// ============================================================================

(function() {
    'use strict';

    var STORAGE_PREFIX = 'mkext_';
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

    function fetchURL(url, referer, callback) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: referer ? { 'Referer': referer } : {},
            onload: function(resp) {
                var text = '';
                if (typeof resp.responseText === 'string') {
                    text = resp.responseText;
                } else if (typeof resp.response === 'string') {
                    text = resp.response;
                }
                callback(null, text);
            },
            onerror: function(err) { callback(err || 'request failed'); }
        });
    }

    // --- M3U8 parsing ---

    // Normalize protocol-relative URLs (//cdn...) to absolute https URLs.
    function normalizeUrl(url) {
        if (!url) return url;
        if (url.indexOf('//') === 0) return 'https:' + url;
        return url;
    }

    function parseM3U8Variants(content, baseUrl) {
        var lines = content.split('\n');
        var variants = [];
        var baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/\r/g, '');
            if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
                var bwMatch = line.match(/BANDWIDTH=(\d+)/);
                var resMatch = line.match(/RESOLUTION=([^\s,]+)/);
                var nextLine = (i + 1 < lines.length) ? lines[i + 1].replace(/\r/g, '').trim() : '';
                if (nextLine && nextLine.indexOf('#') !== 0) {
                    var u = nextLine;
                    if (u.indexOf('http') !== 0) {
                        u = baseDir + nextLine;
                    }
                    u = normalizeUrl(u);
                    variants.push({
                        bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
                        resolution: resMatch ? resMatch[1] : 'unknown',
                        url: u,
                        label: (resMatch ? resMatch[1] : '') + ' (' + (bwMatch ? Math.round(parseInt(bwMatch[1], 10) / 1000) + 'kbps' : '?') + ')'
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
        var lines = content.split('\n');
        var baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/\r/g, '');
            if (line.indexOf('#EXT-X-MEDIA:TYPE=SUBTITLES') === 0) {
                var langMatch = line.match(/LANGUAGE="([^"]+)"/);
                var nameMatch = line.match(/NAME="([^"]+)"/);
                var uriMatch = line.match(/URI="([^"]+)"/);
                if (uriMatch && uriMatch[1]) {
                    var u = uriMatch[1];
                    if (u.indexOf('http') !== 0) {
                        u = baseDir + u;
                    }
                    u = normalizeUrl(u);
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

    // Strip WebVTT headers and join all subtitle segments into one VTT document.
    function assembleVtt(parts) {
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var lines = (parts[i] || '').replace(/\r/g, '').split('\n');
            for (var j = 0; j < lines.length; j++) {
                var line = lines[j];
                if (j === 0 && line.indexOf('WEBVTT') === 0) continue;
                if (line.indexOf('X-TIMESTAMP-MAP') === 0) continue;
                if (line.indexOf('WEBVTT') === 0) continue;
                if (line.indexOf('NOTE') === 0 && line.indexOf('-->') < 0) continue;
                out.push(line);
            }
        }
        // Drop any leading blank lines
        while (out.length > 0 && out[0] === '') out.shift();
        return 'WEBVTT\n' + out.join('\n');
    }

    // Convert assembled WebVTT to SRT (timestamps . -> , and cue numbers).
    function vttToSrt(vtt) {
        var lines = vtt.replace(/\r/g, '').split('\n');
        var out = [];
        var cueIndex = 0;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('WEBVTT') === 0) continue;
            if (line.indexOf('-->') >= 0) {
                cueIndex++;
                out.push(String(cueIndex));
                out.push(line.replace(/\.(\d{3})/g, ',$1'));
                continue;
            }
            out.push(line);
        }
        return out.join('\n');
    }

    // Save a text string as a downloaded file (Firefox 52 compatible).
    function saveTextFile(filename, text) {
        var blob = new Blob([text], { type: 'text/plain' });
        var blobUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        }, 200);
    }

    // Fetch an HLS subtitle playlist, download every WebVTT segment and
    // assemble a single .srt file.
    function downloadHlsSubtitle(playlistUrl, filename) {
        fetchURL(playlistUrl, window.location.href, function(err, content) {
            if (err || !content) {
                window.open(playlistUrl, '_blank');
                return;
            }
            var baseDir = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
            var segments = [];
            var lines = content.split('\n');
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].replace(/\r/g, '').trim();
                if (line && line.indexOf('#') !== 0) {
                    var u = line;
                    if (u.indexOf('http') !== 0) {
                        u = baseDir + u;
                    }
                    segments.push(u);
                }
            }
            if (segments.length === 0) {
                window.open(playlistUrl, '_blank');
                return;
            }
            var parts = [];
            var idx = 0;
            function fetchNext() {
                if (idx >= segments.length) {
                    var vtt = assembleVtt(parts);
                    var srt = vttToSrt(vtt);
                    var fname = filename;
                    if (!/\.srt$/i.test(fname)) fname += '.srt';
                    saveTextFile(fname, srt);
                    return;
                }
                fetchURL(segments[idx], window.location.href, function(err2, segText) {
                    if (!err2 && segText) parts.push(segText);
                    idx++;
                    fetchNext();
                });
            }
            fetchNext();
        });
    }

    // --- JSON extraction with balanced brace/bracket matching ---

    function extractBalancedJson(str, startPos) {
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
                            var item = playData[0];
                            if (item.file) result.m3u8 = item.file.replace(/\\\//g, '/');
                            if (item.tracks) {
                                for (var t = 0; t < item.tracks.length; t++) {
                                    result.srt.push({
                                        url: item.tracks[t].file.replace(/\\\//g, '/'),
                                        label: item.tracks[t].label || ('Track ' + (t + 1)),
                                        lang: item.tracks[t].srclang || 'hu'
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
                                var item2 = setup.playlist[0];
                                if (item2.file) result.m3u8 = item2.file.replace(/\\\//g, '/');
                                if (item2.tracks) {
                                    for (var t2 = 0; t2 < item2.tracks.length; t2++) {
                                        result.srt.push({
                                            url: item2.tracks[t2].file.replace(/\\\//g, '/'),
                                            label: item2.tracks[t2].label || ('Track ' + (t2 + 1)),
                                            lang: item2.tracks[t2].srclang || 'hu'
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
                var base = result.m3u8.split('/');
                base.pop();
                result.srt.push({
                    url: base.join('/') + decodeURIComponent(sp[1]).replace(/\\\//g, '/'),
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

    function copyToClipboard(text) {
        if (typeof GM_setClipboard === 'function') {
            try {
                GM_setClipboard(text, 'text');
                return;
            } catch(e) {}
        }
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:none;outline:none;box-shadow:none;background:transparent;color:transparent;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand('copy'); } catch(e) {}
        document.body.removeChild(ta);
    }

    // --- Download via GM_xmlhttpRequest (bypasses CORS) ---

    function downloadFile(url, filename) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            responseType: 'blob',
            onload: function(resp) {
                var blob = resp.response;
                // Duck-type check: some Violentmonkey versions return text even when
                // responseType is requested. If we don't have a real Blob, open in a tab.
                if (blob && typeof blob === 'object' && typeof blob.size === 'number') {
                    var blobUrl = URL.createObjectURL(blob);
                    var a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(function() {
                        document.body.removeChild(a);
                        URL.revokeObjectURL(blobUrl);
                    }, 200);
                } else {
                    window.open(url, '_blank');
                }
            },
            onerror: function() {
                window.open(url, '_blank');
            }
        });
    }

    // --- UI: Panel ---

    function closePanel() {
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        panel = null;
        allUrlSpans = [];
    }

    function createPanel() {
        closePanel();

        var savedX = getVal('posX', 10);
        var savedY = getVal('posY', 10);
        var savedMin = getVal('minimized', false);
        var savedW = getVal('winW', 360);
        var savedH = getVal('winH', 480);

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
        var showUrls = getVal('showUrls', true);

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
            closePanel();
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

        // Drag
        header.addEventListener('mousedown', function(e) {
            if (e.target === minBtn || e.target === closeBtn || e.target === cb) return;
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
                setVal('winW', panel.offsetWidth);
                setVal('winH', panel.offsetHeight);
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
            panel.style.width = getVal('winW', 360) + 'px';
            panel.style.height = getVal('winH', 480) + 'px';
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
        btn.textContent = label || 'Copy';
        btn.style.cssText = 'background:rgba(80,140,220,0.25);border:1px solid rgba(80,140,220,0.4);' +
            'color:#8ac;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-left:6px;' +
            'flex-shrink:0;';
        btn.addEventListener('click', function() {
            copyToClipboard(text);
            var orig = btn.textContent;
            btn.textContent = 'Copied!';
            btn.style.background = 'rgba(80,200,120,0.3)';
            btn.style.borderColor = 'rgba(80,200,120,0.5)';
            btn.style.color = '#8c8';
            setTimeout(function() {
                btn.textContent = orig;
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
            downloadFile(url, filename);
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
            downloadHlsSubtitle(playlistUrl, filename);
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

        var showUrls = getVal('showUrls', true);
        if (!showUrls) urlSpan.style.display = 'none';
        allUrlSpans.push(urlSpan);

        wrap.appendChild(urlSpan);
        wrap.appendChild(makeCopyBtn(fullUrl, 'Copy'));
        return wrap;
    }

    // --- Subtitle filename helper ---

    // Use the original SRT filename as served by mediaklikk (e.g. 1983-100161-M0001-05_3700_hun.srt)
    function getSrtFilename(url) {
        try {
            var fn = url.split('?')[0].split('/').pop();
            if (fn) return fn;
        } catch(e) {}
        return 'subtitle.srt';
    }

    // --- Render results ---

    function renderResults(data) {
        var body = createPanel();
        body.innerHTML = '';

        if (!data.m3u8 && data.srt.length === 0) {
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

    function showError(msg) {
        var body = createPanel();
        body.innerHTML = '<div style="text-align:center;padding:16px;color:#f88;">' +
            '<div>' + msg + '</div></div>';
    }

    // --- Core logic ---

    // Master playlist URL currently shown in the panel.
    var currentM3u8 = null;
    var lastVideoToken = null;
    var lastVideoPermalink = null;
    // Render generation: only the newest requested render may paint the panel,
    // so a slow fetch from a previous video can never overwrite a newer one.
    var renderGen = 0;

    function processPlayerPage(html, referer) {
        var data = extractFromPlayerPage(html);
        if (data.m3u8) {
            currentM3u8 = data.m3u8;
            var gen = ++renderGen;
            fetchURL(data.m3u8, referer, function(err, content) {
                if (gen !== renderGen) return;
                if (!err && content) {
                    data.qualities = parseM3U8Variants(content, data.m3u8);
                    data.hlsSubtitles = parseM3U8Subtitles(content, data.m3u8);
                }
                renderResults(data);
            });
        } else {
            var gen2 = ++renderGen;
            if (gen2 !== renderGen) return;
            renderResults(data);
        }
    }

    // Render a newly loaded video (recommended / direct change inside the iframe).
    // Optionally also fetches the subtitle for the given token.
    function renderNewVideo(m3u8Url, token) {
        if (!m3u8Url) return;
        m3u8Url = normalizeUrl(m3u8Url);
        if (m3u8Url === currentM3u8) return;
        currentM3u8 = m3u8Url;
        var gen = ++renderGen;
        showLoading();

        fetchURL(m3u8Url, window.location.href, function(err, content) {
            if (gen !== renderGen) return;
            var data = { m3u8: m3u8Url, srt: [], qualities: [], hlsSubtitles: [] };
            if (!err && content) {
                data.qualities = parseM3U8Variants(content, m3u8Url);
                data.hlsSubtitles = parseM3U8Subtitles(content, m3u8Url);
            }
            if (token) {
                // Try to also grab this video's sidecar subtitle.
                if (lastVideoPermalink) {
                    // Recommended videos: recover it via the video's page.
                    fetchSubtitleFromPermalink(lastVideoPermalink, token, data, gen);
                } else {
                    var playerUrl = 'https://player.mediaklikk.hu/playernew/player.php?video=' + token;
                    fetchURL(playerUrl, window.location.href, function(err2, html) {
                        if (gen !== renderGen) return;
                        if (!err2 && html) {
                            var sub = extractFromPlayerPage(html);
                            if (sub && sub.srt.length > 0) data.srt = sub.srt;
                        }
                        renderResults(data);
                    });
                }
            } else {
                renderResults(data);
            }
        });
    }

    // Normalize a token captured from a message or a get_video_url URL.
    // get_video_url.php double-encodes the token, so decode it once to the
    // single-encoded form that player.php?video= expects.
    function normalizeToken(str) {
        if (!str) return null;
        try {
            return decodeURIComponent(str);
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
        if (typeof sp === 'string') return sp;
        if (Array.isArray(sp)) return (sp.length > 0 ? sp[0] : null);
        return null;
    }

    // For recommended videos the player page is never re-rendered, so the
    // sidecar subtitle must be recovered via the video's own page: fetch the
    // permalink, read subtitlePath from its loadPlayer config, then ask
    // player.php for the playData (which contains the full srt URL).
    function fetchSubtitleFromPermalink(permalink, token, data, gen) {
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
                });
            } else {
                renderResults(data);
            }
        });
    }

    // Detect when the player loads a new video without the iframe URL changing
    // (recommended videos / direct video changes from the parent page).
    function hookVideoChanges() {
        // 1. get_video_url.php XHR returns {"url": "...index.m3u8"} for the new video.
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            var self = this;
            if (typeof url === 'string' && url.indexOf('get_video_url.php') >= 0) {
                var token = '';
                var tm = url.match(/[?&]token=([^&]+)/);
                if (tm) token = normalizeToken(tm[1]);
                this.addEventListener('load', function() {
                    try {
                        var d = JSON.parse(self.responseText);
                        if (d && d.url) {
                            renderNewVideo(d.url, token || lastVideoToken);
                        }
                    } catch(e) {}
                });
            }
            return origOpen.apply(this, arguments);
        };

        // 2. The player dispatches "video-url-loaded" after pl.load(). Backup path:
        //    read the current file from the player instance.
        document.addEventListener('video-url-loaded', function() {
            setTimeout(function() {
                var w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
                try {
                    if (w.pl && w.pl.getPlaylistItem) {
                        var it = w.pl.getPlaylistItem();
                        if (it && it.file) {
                            renderNewVideo(it.file, lastVideoToken);
                        }
                    }
                } catch(e) {}
            }, 250);
        });

        // 3. Parent tells the iframe to play a video -> remember its token and
        //    the video's page URL (permalink), which is needed to recover the
        //    sidecar subtitle for recommended videos.
        window.addEventListener('message', function(event) {
            if (!event.data || event.data.type !== 'load-video') return;
            if (event.data.data) {
                if (event.data.data.token) lastVideoToken = event.data.data.token;
                if (event.data.data.file) lastVideoPermalink = event.data.data.file;
            }
        });
    }

    // --- Init ---

    var extractDone = false;
    var attempts = 0;
    var MAX_ATTEMPTS = 30;
    var lastUrl = window.location.href;

    // Reset so a new video / new player URL triggers a fresh extraction
    function resetExtraction() {
        extractDone = false;
        attempts = 0;
        closePanel();
        setTimeout(tryExtract, 400);
    }

    function tryExtract() {
        if (extractDone) return;
        var html = document.documentElement.innerHTML || '';
        // Only start once the player data is actually present in the page.
        // Retry for up to ~30s to cover slow computers / slow network.
        if (html.indexOf('pl.setup') < 0 && html.indexOf('playData') < 0 && html.indexOf('"file"') < 0) {
            if (attempts < MAX_ATTEMPTS) {
                attempts++;
                setTimeout(tryExtract, 1000);
            }
            return;
        }
        extractDone = true;
        showLoading();
        processPlayerPage(html, window.location.href);
    }

    // Detect when the iframe navigates to a new video (new player.php URL)
    // without a full script re-run (e.g. sandbox reuse, SPA-style updates).
    // Also polls the player instance to catch recommended/direct video changes
    // where the iframe URL stays the same.
    function monitorUrlChanges() {
        window.setInterval(function() {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                resetExtraction();
                return;
            }
            var w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            try {
                if (w.pl && w.pl.getPlaylistItem) {
                    var it = w.pl.getPlaylistItem();
                    if (it && it.file && it.file !== currentM3u8) {
                        renderNewVideo(it.file, lastVideoToken);
                    }
                }
            } catch(e) {}
        }, 1500);
    }

    function init() {
        lastUrl = window.location.href;
        hookVideoChanges();
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