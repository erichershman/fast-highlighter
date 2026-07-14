// ==UserScript==
// @name         Highlight.js
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Instant keyword highlighting using the CSS Custom Highlight API, with a safe reversible DOM fallback
// @author       Eric Hershman
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @run-at       document-start
// @noframes

// ==/UserScript==

(function() {
    'use strict';

    /* global Highlight */


    // ⎯⎯⎯⎯⎯⎯⎯⎯⎯ Configuration ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

    const STORAGE_KEY = 'fastHighlighterEnabled';
    const LISTS_KEY = 'fastHighlighterLists';
    const HL_PREFIX = 'dfh-hl-';
    const MARK_ATTR = 'data-dfh-mark'; // fallback highlight spans
    const UI_ATTR = 'data-dfh-ui'; // roots of our own UI (popup/dialogs)
    const COLOR_RE = /^#[0-9a-f]{6}$/i;
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'IFRAME']);
    const hasHighlightAPI = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    // Share storage across sites with fallback to localStorage
    const store = {
        get(key) {
            if (hasGM) return GM_getValue(key, null);
            try {
                return localStorage.getItem(key);
            } catch (e) {
                return null;
            }
        },
        set(key, value) {
            if (hasGM) {
                GM_setValue(key, value);
                return;
            }
            try {
                localStorage.setItem(key, value);
            } catch (e) {
                /* ignore */ }
        }
    }

    // Clean and validate a raw list from storage before trusting any of its fields.
    // Returns null if the list has no usable name.

    function sanitizeList(raw) {
        if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) return null;
        return {
            name: raw.name,
            color: (typeof raw.color === 'string' && COLOR_RE.test(raw.color)) ? raw.color : '#ffcc00',
            keywords: Array.isArray(raw.keywords) ?
                raw.keywords.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim()) :
                [],
            wholeWord: raw.wholeWord !== false,
            caseSensitive: raw.caseSensitive === true,
            urlPattern: typeof raw.urlPattern === 'string' ? raw.urlPattern.trim() : ''
        };
    }

    function loadLists() {
        const raw = store.get(LISTS_KEY);
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) return parsed.map(sanitizeList).filter(Boolean);
            } catch (e) {
                /* Return empty if corrupt */ }
        }
        return [];
    }

    let highlightsEnabled = store.get(STORAGE_KEY) !== 'false';
    let lists = loadLists();

    function saveLists() {
        store.set(LISTS_KEY, JSON.stringify(lists));
    }

    // Keyword matching (Aho-Corasick)

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Optional URL filtering, URL Substring + * for wildcard, Empty = matches on all URL's.
    function urlMatches(pattern) {
        if (!pattern) return true;
        try {
            return new RegExp(pattern.split('*').map(escapeRegex).join('.*'), 'i').test(location.href);
        } catch (e) {
            return true;
        }
    }

    // Case fold one character at a time to maintain string length

    let foldTable = null;

    function fold(code) {
        if (foldTable === null) foldTable = new Uint16Array(65536);
        let f = foldTable[code];
        if (f === 0) {
            const lower = String.fromCharCode(code).toLowerCase();
            f = lower.length === 1 ? lower.charCodeAt(0) : code;
            foldTable[code] = f;
        }
        return f;
    }

    function isWordCode(c) {
        return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
    }

    // True if the character at `pos` is on a word boundary
    function boundary(text, pos) {
        const before = pos > 0 && isWordCode(text.charCodeAt(pos - 1));
        const after = pos < text.length && isWordCode(text.charCodeAt(pos));
        return before !== after;
    }

    // Build one Aho-Corasick trie
    // Case sensitive keywords key on different char codes, so each gets its own trie.
    function buildTrie(caseSensitive) {
        const next = [new Map()];
        const fail = [0];
        const out = [null];
        let hasKeywords = false;

        lists.forEach((list, li) => {
            if (!!list.caseSensitive !== caseSensitive || !urlMatches(list.urlPattern)) return;
            for (const kw of list.keywords) {
                if (!kw) continue;
                hasKeywords = true;
                let s = 0;
                for (let i = 0; i < kw.length; i++) {
                    const c = caseSensitive ? kw.charCodeAt(i) : fold(kw.charCodeAt(i));
                    let t = next[s].get(c);
                    if (t === undefined) {
                        t = next.length;
                        next.push(new Map());
                        fail.push(0);
                        out.push(null);
                        next[s].set(c, t);
                    }
                    s = t;
                }
                (out[s] || (out[s] = [])).push({
                    len: kw.length,
                    list: li,
                    whole: list.wholeWord
                });
            }
        });
        if (!hasKeywords) return null;

        // Wire fail links and merge suffix outputs
        const queue = [...next[0].values()];
        for (let qi = 0; qi < queue.length; qi++) {
            const s = queue[qi];
            for (const [c, t] of next[s]) {
                queue.push(t);
                let f = fail[s];
                let ft = next[f].get(c);
                while (ft === undefined && f !== 0) {
                    f = fail[f];
                    ft = next[f].get(c);
                }
                fail[t] = (ft === undefined || ft === t) ? 0 : ft;
                const suffixOut = out[fail[t]];
                if (suffixOut)(out[t] || (out[t] = [])).push(...suffixOut);
            }
        }
        return {
            next,
            fail,
            out
        };
    }

    // Split tries by case sensitivity
    function buildMatcher() {
        const ci = buildTrie(false);
        const cs = buildTrie(true);
        return (ci || cs) ? { ci, cs } : null;
    }

    let matcher = buildMatcher();

    // Scans one trie over the text, appends matches to `found`.
    function scanTrie(trie, text, caseSensitive, found) {
        if (!trie) return;
        const { next, fail, out } = trie;
        let s = 0;
        for (let i = 0; i < text.length; i++) {
            const c = caseSensitive ? text.charCodeAt(i) : fold(text.charCodeAt(i));
            let t = next[s].get(c);
            while (t === undefined && s !== 0) {
                s = fail[s];
                t = next[s].get(c);
            }
            s = t === undefined ? 0 : t;
            const o = out[s];
            if (o) {
                const end = i + 1;
                for (const m of o) {
                    const start = end - m.len;
                    if (m.whole && !(boundary(text, start) && boundary(text, end))) continue;
                    found.push({
                        start,
                        end,
                        list: m.list
                    });
                }
            }
        }
    }

    // Single pass per trie, O(n). Returns sorted matches [{start, end, list}].
    function collectMatches(text) {
        if (!matcher) return [];
        const found = [];
        scanTrie(matcher.ci, text, false, found);
        scanTrie(matcher.cs, text, true, found);
        if (found.length < 2) return found;
        // Sort by start, longest first, keep the first match that doesn't overlap
        found.sort((a, b) => a.start - b.start || b.end - a.end);
        const kept = [found[0]];
        for (let i = 1; i < found.length; i++) {
            if (found[i].start >= kept[kept.length - 1].end) kept.push(found[i]);
        }
        return kept;
    }

    // TreeWalker over text nodes: skips scripts, editable regions, and Highlighter UI elements.
    function* textNodes(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    return (SKIP_TAGS.has(node.tagName) || node.hasAttribute(UI_ATTR) || node.isContentEditable) ?
                        NodeFilter.FILTER_REJECT :
                        NodeFilter.FILTER_SKIP;
                }
                return /\S/.test(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
        });
        let n;
        while ((n = walker.nextNode())) yield n;
    }

    // Parse Hex Color and choose black or white text.
    function textColor(hex) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? '#111' : '#eee';
    }

    // Inject CSS Highlight rule for each list
    function injectHighlightStyles() {
        if (!hasHighlightAPI) return; // fallback spans use inline styles
        const parent = document.head || document.documentElement;
        if (!parent) return; // too early; init() retries on DOMContentLoaded
        let el = document.getElementById('dfh-styles');
        if (!el) {
            el = document.createElement('style');
            el.id = 'dfh-styles';
            parent.appendChild(el);
        }

        // Colors prevalidated as hex, safe to insert directly.
        el.textContent = lists.map((list, i) =>
            `::highlight(${HL_PREFIX}${i}){background-color:${list.color}!important;color:${textColor(list.color)}!important;}`
        ).join('');
    }

    function clearHighlights() {
        // Delete highlight keys, CSS.highlights.clear() would remove the source page's highlights.
        for (const key of [...CSS.highlights.keys()]) {
            if (key.startsWith(HL_PREFIX)) CSS.highlights.delete(key);
        }
    }

    // Incremental highlighting: paint as soon as the parser streams text without rewalking the page.

    const SKIP_SELECTOR = 'script,style,noscript,textarea,input,select,iframe,[' + UI_ATTR + ']';

    function isHighlightable(el) {
        return !!el && !el.closest(SKIP_SELECTOR) && !el.isContentEditable;
    }

    function ensureHighlight(i) {
        let hl = CSS.highlights.get(HL_PREFIX + i);
        if (!hl) {
            hl = new Highlight();
            CSS.highlights.set(HL_PREFIX + i, hl);
        }
        return hl;
    }

    function highlightTextNode(node) {
        for (const m of collectMatches(node.data)) {
            const r = new Range();
            r.setStart(node, m.start);
            r.setEnd(node, m.end);
            ensureHighlight(m.list).add(r);
        }
    }

    function scanAdded(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (/\S/.test(node.data) && isHighlightable(node.parentElement)) highlightTextNode(node);
        } else if (node.nodeType === Node.ELEMENT_NODE && isHighlightable(node)) {
            for (const t of textNodes(node)) highlightTextNode(t);
        }
    }

    // DOM fallback when the Highlight API is not supported.
    function clearMarks() {
        const marks = document.querySelectorAll(`span[${MARK_ATTR}]`);
        if (!marks.length) return;
        const parents = new Set();
        for (const mark of marks) {
            const parent = mark.parentNode;
            if (!parent) continue;
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parents.add(parent);
        }
        parents.forEach(p => p.normalize());
    }

    function highlightDOM() {
        const nodes = [...textNodes(document.body)]; // snapshot before mutating
        for (const node of nodes) {
            const text = node.data;
            const matches = collectMatches(text);
            if (!matches.length) continue;
            const frag = document.createDocumentFragment();
            let pos = 0;
            for (const m of matches) {
                if (m.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, m.start)));
                const span = document.createElement('span');
                span.setAttribute(MARK_ATTR, '');
                span.style.backgroundColor = lists[m.list].color;
                span.style.color = textColor(lists[m.list].color);
                span.textContent = text.slice(m.start, m.end); // treat as plain string so it's not interpreted as markup
                frag.appendChild(span);
                pos = m.end;
            }
            if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
            node.parentNode.replaceChild(frag, node);
        }
    }

    // --- Apply Highlights ---
    function highlightPage() {
        if (!document.body || !isHighlightable(document.body)) return; // don't touch editable documents
        if (hasHighlightAPI) {
            clearHighlights();
            if (!highlightsEnabled || !matcher) return;
            const ranges = lists.map(() => []);
            for (const node of textNodes(document.body)) {
                for (const m of collectMatches(node.data)) {
                    const r = new Range();
                    r.setStart(node, m.start);
                    r.setEnd(node, m.end);
                    ranges[m.list].push(r);
                }
            }
            ranges.forEach((rs, i) => {
                if (!rs.length) return;
                const hl = new Highlight();
                for (const r of rs) hl.add(r);
                CSS.highlights.set(HL_PREFIX + i, hl);
            });
        } else {
            // Pause the observer around our own writes or it triggers indefinitely.
            withObserverPaused(() => {
                clearMarks();
                if (highlightsEnabled && matcher) highlightDOM();
            });
        }
    }

    function toggleHighlights() {
        highlightsEnabled = !highlightsEnabled;
        store.set(STORAGE_KEY, String(highlightsEnabled));
        highlightPage();
    }

    function applyListChanges() {
        saveLists();
        matcher = buildMatcher();
        injectHighlightStyles();
        highlightPage();
    }

    // --- Mutation observer ---
    const OBSERVER_OPTS = {
        childList: true,
        subtree: true,
        characterData: true
    };
    let observer = null;
    let debounceTimer = 0;

    function scheduleRebuild() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(highlightPage, 150);
    }

    function isOwnUI(node) {
        return node.nodeType === Node.ELEMENT_NODE && node.hasAttribute(UI_ATTR);
    }

    function inOwnUI(rec) {
        const el = rec.target.nodeType === Node.ELEMENT_NODE ? rec.target : rec.target.parentElement;
        return !!(el && el.closest(`[${UI_ATTR}]`));
    }

    // Highlight added nodes immediately in Highlighter API mode, everything else schedules a full rebuild.
    function onMutations(records) {
        if (!highlightsEnabled || !matcher) return;
        let needsRebuild = false;
        for (const rec of records) {
            if (inOwnUI(rec)) continue;
            if (rec.type === 'childList') {
                if (rec.removedNodes.length) {
                    for (const n of rec.removedNodes) {
                        if (!isOwnUI(n)) {
                            needsRebuild = true;
                            break;
                        }
                    }
                }
                if (hasHighlightAPI) {
                    for (const n of rec.addedNodes) {
                        if (!isOwnUI(n)) scanAdded(n);
                    }
                } else if (rec.addedNodes.length) {
                    needsRebuild = true;
                }
            } else {
                needsRebuild = true;
            }
        }
        if (needsRebuild) scheduleRebuild();
    }

    function setupObserver() {
        if (observer || !document.documentElement) return;
        observer = new MutationObserver(onMutations);
        observer.observe(document.documentElement, OBSERVER_OPTS);
    }

    function withObserverPaused(fn) {
        if (!observer) {
            fn();
            return;
        }
        const pending = observer.takeRecords();
        if (pending.length) onMutations(pending);
        observer.disconnect();
        try {
            fn();
        } finally {
            observer.observe(document.documentElement, OBSERVER_OPTS);
        }
    }

    // --- UI helpers ---
    const ESC = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };

    function esc(str) {
        return String(str).replace(/[&<>"']/g, c => ESC[c]);
    }

    function parseKeywords(text) {
        return text.split('\n').map(k => k.trim()).filter(Boolean);
    }

    function ensureUIStyles() {
        if (document.getElementById('dfh-ui-styles')) return;
        const style = document.createElement('style');
        style.id = 'dfh-ui-styles';
        style.textContent = `
[${UI_ATTR}]{--bg:#fff;--fg:#333;--panel:#f5f5f5;--border:#ccc;--soft:#eee;--muted:#999;
position:fixed;z-index:2147483646;background:var(--bg);color:var(--fg);border:1px solid var(--border);
border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.3);max-height:80vh;overflow-y:auto;box-sizing:border-box;
font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;text-align:left;}
[${UI_ATTR}].dfh-dark{--bg:#2d2d2d;--fg:#e0e0e0;--panel:#3d3d3d;--border:#555;--soft:#444;--muted:#888;box-shadow:0 4px 20px rgba(0,0,0,.7);}
#dfh-popup{top:20px;right:20px;min-width:280px;max-width:360px;padding:15px;}
.dfh-dialog{top:50%;left:50%;transform:translate(-50%,-50%);min-width:350px;max-width:500px;padding:20px;z-index:2147483647;}
[${UI_ATTR}] h3{margin:0 0 12px;font-size:16px;}
[${UI_ATTR}] label{display:block;margin-bottom:10px;}
[${UI_ATTR}] input[type=text],[${UI_ATTR}] textarea{width:100%;margin-top:4px;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--panel);color:var(--fg);box-sizing:border-box;font-size:13px;}
[${UI_ATTR}] textarea{height:120px;font:12px monospace;resize:vertical;}
.dfh-row{display:flex;justify-content:space-between;align-items:center;gap:8px;}
.dfh-muted{font-size:11px;color:var(--muted);}
.dfh-btn{font-size:11px;padding:2px 8px;border:1px solid var(--border);border-radius:3px;background:var(--panel);color:var(--fg);cursor:pointer;}
.dfh-btn-primary{padding:6px 16px;background:#4caf50;color:#fff;border:none;border-radius:4px;cursor:pointer;}
.dfh-btn-secondary{padding:6px 16px;border:1px solid var(--border);border-radius:4px;background:var(--panel);color:var(--fg);cursor:pointer;}
.dfh-btn-danger{border-color:#f44;color:#f44;background:none;}
.dfh-x{background:none;border:none;font-size:16px;cursor:pointer;color:var(--muted);padding:0 4px;}
.dfh-card{margin-bottom:12px;padding:6px 8px 6px 10px;border-left:3px solid var(--border);background:var(--panel);border-radius:0 4px 4px 0;}
.dfh-actions{margin-top:6px;display:flex;gap:5px;flex-wrap:wrap;align-items:center;}
.dfh-kw{max-height:150px;overflow-y:auto;}
.dfh-kw-item{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:4px 6px;margin-bottom:3px;background:var(--panel);border-radius:4px;font-size:12px;word-break:break-all;}
.dfh-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--soft);}
.dfh-kbd{background:var(--panel);padding:1px 4px;border:1px solid var(--border);border-radius:3px;}`;
        (document.head || document.documentElement).appendChild(style);
    }

    let popupInstance = null;
    let dialogInstance = null;

    function closePopup() {
        if (popupInstance) {
            popupInstance.remove();
            popupInstance = null;
        }
    }

    function closeDialog() {
        if (dialogInstance) {
            dialogInstance.remove();
            dialogInstance = null;
        }
    }

    function uiRoot(id, className) {
        const el = document.createElement('div');
        if (id) el.id = id;
        el.className = className + (matchMedia('(prefers-color-scheme: dark)').matches ? ' dfh-dark' : '');
        el.setAttribute(UI_ATTR, '');
        return el;
    }

    function openDialog(html) {
        ensureUIStyles();
        closePopup();
        closeDialog();
        const dialog = uiRoot(null, 'dfh-dialog');
        dialog.innerHTML = html; // all interpolated user data goes through esc(); colors are validated
        dialog.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                closeDialog();
                createPopupMenu();
            }
        });
        document.body.appendChild(dialog);
        dialogInstance = dialog;
        return dialog;
    }

    // --- Popup menu ---
    function createPopupMenu() {
        ensureUIStyles();
        closePopup();
        closeDialog();
        if (!document.body) return;

        const popup = uiRoot('dfh-popup', '');
        let html = `
            <div class="dfh-row" style="margin-bottom:12px"><h3 style="margin:0">Highlight Manager</h3><button class="dfh-x" data-act="close" title="Close">✕</button></div>
            <label class="dfh-row" style="justify-content:flex-start;cursor:pointer;margin-bottom:4px"><input type="checkbox" id="dfh-toggle"${highlightsEnabled ? ' checked' : ''}>Enable Highlights</label>
            <div class="dfh-muted" style="margin-bottom:12px"><span class="dfh-kbd">Ctrl+Shift+H</span> toggle · <span class="dfh-kbd">Ctrl+Shift+U</span> menu</div>`;
        if (!lists.length) {
            html += '<div class="dfh-muted" style="text-align:center;padding:10px 0 12px">No categories yet. Add one below to start highlighting.</div>';
        }
        lists.forEach((list, i) => {
            const preview = list.keywords.slice(0, 5).map(esc).join(', ') + (list.keywords.length > 5 ? '…' : '');
            const tags = (list.wholeWord ? '' : ' · substring') +
                (list.caseSensitive ? ' · case sensitive' : '') +
                (list.urlPattern ? ` · ${esc(list.urlPattern)}${urlMatches(list.urlPattern) ? '' : ' (inactive here)'}` : '');
            html += `
            <div class="dfh-card" style="border-left-color:${list.color}">
                <div class="dfh-row"><strong>${esc(list.name)}</strong><span class="dfh-muted">${list.keywords.length} terms${tags}</span></div>
                <div class="dfh-muted" style="word-break:break-all">${preview}</div>
                <div class="dfh-actions">
                    <button class="dfh-btn" data-act="edit" data-i="${i}">Edit</button>
                    <button class="dfh-btn" data-act="keywords" data-i="${i}">Keywords</button>
                    <input type="color" value="${list.color}" data-act="color" data-i="${i}" title="Category color">
                    <button class="dfh-btn dfh-btn-danger" data-act="delete" data-i="${i}">Delete</button>
                </div>
            </div>`;
        });
        html += '<button class="dfh-btn-secondary" style="width:100%" data-act="add">+ Add Category</button>';
        popup.innerHTML = html;

        popup.addEventListener('click', e => {
            const act = e.target.dataset ? e.target.dataset.act : null;
            if (!act) return;
            const i = Number(e.target.dataset.i);
            if (act === 'close') {
                closePopup();
            } else if (act === 'edit') {
                showEditDialog(i);
            } else if (act === 'keywords') {
                showKeywordDialog(i);
            } else if (act === 'delete') {
                if (confirm(`Delete category "${lists[i].name}"?`)) {
                    lists.splice(i, 1);
                    applyListChanges();
                    createPopupMenu();
                }
            } else if (act === 'add') {
                showAddCategoryDialog();
            }
        });

        popup.addEventListener('change', e => {
            if (e.target.id === 'dfh-toggle') {
                toggleHighlights();
            } else if (e.target.dataset.act === 'color') {
                lists[Number(e.target.dataset.i)].color = e.target.value;
                applyListChanges();
                createPopupMenu();
            }
        });

        document.body.appendChild(popup);
        popupInstance = popup;
    }

    // Outside click listener, close popup when click occurs outside UI
    document.addEventListener('click', e => {
        if (popupInstance && !popupInstance.contains(e.target)) closePopup();
    }, true);

    // --- Dialogs ---
    function showEditDialog(i) {
        const list = lists[i];
        if (!list) return;
        const d = openDialog(`
            <h3>Edit Category</h3>
            <label><b>Category Name:</b><input type="text" id="dfh-e-name" value="${esc(list.name)}"></label>
            <label><b>Color:</b> <input type="color" id="dfh-e-color" value="${list.color}"></label>
            <label style="cursor:pointer"><input type="checkbox" id="dfh-e-whole"${list.wholeWord ? ' checked' : ''}> Whole words only <span class="dfh-muted">(uncheck to match inside words)</span></label>
            <label style="cursor:pointer"><input type="checkbox" id="dfh-e-case"${list.caseSensitive ? ' checked' : ''}> Case sensitive <span class="dfh-muted">(match exact letter case)</span></label>
            <label><b>URL filter</b> <span class="dfh-muted">(optional · substring of the URL, * = wildcard · empty = all sites)</span>
                <input type="text" id="dfh-e-url" value="${esc(list.urlPattern)}" placeholder="e.g. github.com or *://*.github.com/*"></label>
            <label><b>Keywords (one per line):</b><textarea id="dfh-e-kw" style="height:150px">${esc(list.keywords.join('\n'))}</textarea></label>
            <div class="dfh-footer">
                <button class="dfh-btn-secondary" id="dfh-e-cancel">Cancel</button>
                <button class="dfh-btn-primary" id="dfh-e-save">Save</button>
            </div>`);
        const nameInput = d.querySelector('#dfh-e-name');
        nameInput.focus();
        nameInput.select();
        d.querySelector('#dfh-e-save').addEventListener('click', () => {
            const name = nameInput.value.trim();
            const keywords = parseKeywords(d.querySelector('#dfh-e-kw').value);
            if (!name) {
                alert('Please enter a category name.');
                return;
            }
            if (!keywords.length) {
                alert('Please enter at least one keyword.');
                return;
            }
            list.name = name;
            list.color = d.querySelector('#dfh-e-color').value;
            list.wholeWord = d.querySelector('#dfh-e-whole').checked;
            list.caseSensitive = d.querySelector('#dfh-e-case').checked;
            list.urlPattern = d.querySelector('#dfh-e-url').value.trim();
            list.keywords = keywords;
            applyListChanges();
            closeDialog();
            createPopupMenu();
        });
        d.querySelector('#dfh-e-cancel').addEventListener('click', () => {
            closeDialog();
            createPopupMenu();
        });
    }

    function showKeywordDialog(i) {
        const list = lists[i];
        if (!list) return;
        const items = list.keywords.length ?
            list.keywords.map((k, ki) =>
                `<div class="dfh-kw-item"><span>${esc(k)}</span><button class="dfh-x" style="color:#f44" data-ki="${ki}" title="Delete keyword">✕</button></div>`).join('') :
            '<div class="dfh-muted" style="text-align:center;padding:10px">No keywords yet. Add some below.</div>';
        const d = openDialog(`
            <h3>Manage Keywords <span class="dfh-muted">— ${esc(list.name)}</span></h3>
            <div class="dfh-row" style="margin-bottom:6px">
                <span class="dfh-muted"><b>${list.keywords.length}</b> keywords</span>
                <button class="dfh-btn dfh-btn-danger" id="dfh-k-clear">Clear All</button>
            </div>
            <div class="dfh-kw">${items}</div>
            <label style="margin-top:12px"><b>Add New Keywords</b> <span class="dfh-muted">(one per line · Ctrl+Enter to add)</span>
                <textarea id="dfh-k-new" style="height:80px" placeholder="Enter keyword&#10;Another keyword&#10;Phrase with spaces"></textarea></label>
            <div class="dfh-actions">
                <button class="dfh-btn-primary" id="dfh-k-add">+ Add Keywords</button>
                <button class="dfh-btn-secondary" id="dfh-k-paste">Paste from Clipboard</button>
            </div>
            <div class="dfh-footer"><button class="dfh-btn-secondary" id="dfh-k-done">Done</button></div>`);

        d.querySelector('.dfh-kw').addEventListener('click', e => {
            const ki = e.target.dataset ? e.target.dataset.ki : undefined;
            if (ki === undefined) return;
            const idx = Number(ki);
            if (confirm(`Delete keyword "${list.keywords[idx]}" from "${list.name}"?`)) {
                list.keywords.splice(idx, 1);
                applyListChanges();
                showKeywordDialog(i);
            }
        });
        d.querySelector('#dfh-k-clear').addEventListener('click', () => {
            if (!list.keywords.length) {
                alert('No keywords to clear.');
                return;
            }
            if (confirm(`Remove ALL ${list.keywords.length} keywords from "${list.name}"?`)) {
                list.keywords = [];
                applyListChanges();
                showKeywordDialog(i);
            }
        });
        const textarea = d.querySelector('#dfh-k-new');
        const addKeywords = () => {
            const incoming = parseKeywords(textarea.value);
            if (!incoming.length) {
                alert('Please enter at least one keyword.');
                return;
            }

            const norm = list.caseSensitive ? (k => k) : (k => k.toLowerCase());
            const existing = new Set(list.keywords.map(norm));
            let added = 0;
            for (const k of incoming) {
                const key = norm(k);
                if (!existing.has(key)) {
                    existing.add(key);
                    list.keywords.push(k);
                    added++;
                }
            }
            if (!added) {
                alert(`All ${incoming.length} keyword(s) already exist in this category.`);
                return;
            }
            applyListChanges();
            showKeywordDialog(i);
        };
        d.querySelector('#dfh-k-add').addEventListener('click', addKeywords);
        textarea.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                addKeywords();
            }
        });
        d.querySelector('#dfh-k-paste').addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    textarea.value += (textarea.value ? '\n' : '') + text;
                    textarea.focus();
                }
            } catch (err) {
                alert('Unable to read clipboard. Please paste manually with Ctrl+V.');
            }
        });
        d.querySelector('#dfh-k-done').addEventListener('click', () => {
            closeDialog();
            createPopupMenu();
        });
    }

    function showAddCategoryDialog() {
        const d = openDialog(`
            <h3>Add New Category</h3>
            <label><b>Category Name:</b><input type="text" id="dfh-a-name" placeholder="Category Name"></label>
            <label><b>Color:</b> <input type="color" id="dfh-a-color" value="#ffcc00"></label>
            <label style="cursor:pointer"><input type="checkbox" id="dfh-a-whole" checked> Whole words only <span class="dfh-muted">(uncheck to match inside words)</span></label>
            <label style="cursor:pointer"><input type="checkbox" id="dfh-a-case"> Case sensitive <span class="dfh-muted">(match exact letter case)</span></label>
            <label><b>URL filter</b> <span class="dfh-muted">(optional · substring of the URL, * = wildcard · empty = all sites)</span>
                <input type="text" id="dfh-a-url" placeholder="e.g. github.com · *.github.com to match subdomains only"></label>
            <label><b>Keywords (one per line):</b><textarea id="dfh-a-kw" style="height:100px" placeholder="Keyword 1&#10;Keyword 2&#10;Phrase with spaces"></textarea></label>
            <div class="dfh-footer">
                <button class="dfh-btn-secondary" id="dfh-a-cancel">Cancel</button>
                <button class="dfh-btn-primary" id="dfh-a-save">Add Category</button>
            </div>`);
        d.querySelector('#dfh-a-name').focus();
        d.querySelector('#dfh-a-save').addEventListener('click', () => {
            const name = d.querySelector('#dfh-a-name').value.trim();
            const keywords = parseKeywords(d.querySelector('#dfh-a-kw').value);
            if (!name) {
                alert('Please enter a category name.');
                return;
            }
            if (!keywords.length) {
                alert('Please enter at least one keyword.');
                return;
            }
            lists.push({
                name,
                color: d.querySelector('#dfh-a-color').value,
                keywords,
                wholeWord: d.querySelector('#dfh-a-whole').checked,
                caseSensitive: d.querySelector('#dfh-a-case').checked,
                urlPattern: d.querySelector('#dfh-a-url').value.trim()
            });
            applyListChanges();
            closeDialog();
            createPopupMenu();
        });
        d.querySelector('#dfh-a-cancel').addEventListener('click', () => {
            closeDialog();
            createPopupMenu();
        });
    }

    // --- Keyboard shortcuts ---
    document.addEventListener('keydown', e => {
        if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
        const key = e.key.toLowerCase();
        if (key === 'h') {
            e.preventDefault();
            toggleHighlights();
        } else if (key === 'u') {
            e.preventDefault();
            if (popupInstance) closePopup();
            else createPopupMenu();
        }
    }, true);

    // --- Init (run at document-start, paint content as it's streamed) ---
    function init() {
        injectHighlightStyles();
        setupObserver();
        if (document.body) highlightPage();
        if (document.readyState === 'loading') {
            // Full pass after streamed pass, retries setup if documentElement wasn't ready
            document.addEventListener('DOMContentLoaded', () => {
                injectHighlightStyles();
                setupObserver();
                highlightPage();
            }, {
                once: true
            });
        }
    }

    // Sync edits made in another tab using GM Storage.
    if (hasGM && typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(LISTS_KEY, (key, oldVal, newVal, remote) => {
            if (!remote) return;
            lists = loadLists();
            matcher = buildMatcher();
            injectHighlightStyles();
            highlightPage();
            if (popupInstance) createPopupMenu();
        });
        GM_addValueChangeListener(STORAGE_KEY, (key, oldVal, newVal, remote) => {
            if (!remote) return;
            highlightsEnabled = newVal !== 'false';
            highlightPage();
        });
    }

    init();

})();