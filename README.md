# RedMem

A session-only Reddit research workspace. Collect Reddit posts, organize them with tags, search them by keyword, and export your collection to a portable file you can import on another device.

**Nothing is persisted.** All state lives in memory. Refreshing, closing, or navigating away from the page permanently discards the collection. There is no backend, no database, no cookies, no `localStorage`, no `sessionStorage`, no `IndexedDB`, and no service worker caching of user data.

---

## Features

- **Dashboard** with live statistics (total, retrieved, link-only, unique tags).
- **Manual URL entry** with best-effort public retrieval.
- **Link-only records** when retrieval is blocked or unavailable.
- **Keyword search** across titles, text, authors, notes, tags, and URLs.
- **Tags**: create, assign, edit, remove, and filter.
- **Sorting & filtering** by date, title, author, tag, and status.
- **Canonical URL normalization & duplicate detection** based on post ID and cleaned parameters.
- **Link Post Support**: Preserves both external destination link (`url`) and Reddit thread link (`permalink`) across exports/imports.
- **Individual delete** and **confirmed clear-all**.
- **JSON export / import** with validation, capacity enforcement (5,000 max records), and duplicate handling.
- **Optional Markdown export** with escaped content and sanitized URLs.
- **Bookmarklet** for one-click capture from a Reddit post page with auto-fill support.
- **Responsive layout** for desktop and phone.
- **Accessible** keyboard controls, focus styles, and ARIA live regions.
- **Safe rendering**: all user-supplied text is inserted via `textContent` or escaped. Links are sanitized (`sanitizeUrl`) to block `javascript:` and `data:` XSS vectors.

---

## Project structure

```
redmem/
├── index.html          # Markup & structure
├── styles.css          # Responsive, accessible styling
├── app.js              # All application logic (no build step)
├── bookmarklet.js      # Bookmarklet source + app URL detection
├── README.md           # Documentation
├── LICENSE             # MIT License
└── tests/
    └── test-runner.html# Automated integration test runner
```

There is no build step. Everything is plain HTML, CSS, and JavaScript.

---

## Setup

### Option 1 — Open locally

1. Download or clone the project.
2. Open `index.html` in a modern browser.

> Note: some browsers restrict `fetch` from `file://` origins. If you want retrieval to have the best chance of working, serve over HTTP.

### Option 2 — Serve locally

```bash
python3 -m http.server 8080
```

or

```bash
npx serve .
```

Then visit `http://localhost:8080`.

### Option 3 — Static hosting

Upload the folder as-is to GitHub Pages, Netlify, Cloudflare Pages, or any static host. No server runtime is required.

---

## Collection methods

### A. URL entry & retrieval

Paste a Reddit post URL into the **Add a Reddit post** form. RedMem:
1. Validates the URL against an allow-list of Reddit hosts (`reddit.com`, `www.reddit.com`, `old.reddit.com`, `np.reddit.com`, `m.reddit.com`, `redd.it`).
2. Normalizes URL by canonicalizing post IDs and stripping tracking query parameters (`utm_*`, `share_id`, `rdt`, `context`, etc.).
3. Checks for duplicates using normalized URLs.
4. Attempts a `fetch` of the public `.json` endpoint with an 8-second timeout.
5. If retrieval succeeds and response parses, stores title, text, author, subreddit, permalink, and link destination, marked **Retrieved**.
6. If retrieval fails (CORS, HTTP error, timeout, unexpected shape), stores record as **Link-only** / **Failed retrieval** — never claiming success that did not happen.

You can always use **Add as link-only** to skip retrieval entirely.

### B. Bookmarklet

1. Open RedMem in your browser.
2. Go to the **Bookmarklet** section.
3. Show your bookmarks bar (`Ctrl`+`Shift`+`B` on Windows/Linux, `⌘`+`Shift`+`B` on macOS).
4. Drag the **Send to RedMem** button onto the bookmarks bar.
5. While viewing a Reddit post, click the bookmarklet. It copies the URL to your clipboard and opens RedMem with `?redmem=` parameter to auto-fill the URL.

### C. File import

- **RedMem JSON export** — full fidelity. Validated against expected schema, preserves permalinks and external destinations, enforces 5 MB file limit and 5,000 max record limit.
- **Markdown / plain text** — Reddit URLs are extracted and added as link-only records. Markup is never executed.

---

## Data safety & Security

- All content is rendered using safe DOM APIs (`textContent`), never `innerHTML` with user data.
- All clickable links pass through `sanitizeUrl` to block `javascript:` and `data:` schemes.
- URLs are validated to HTTP/HTTPS and restricted to supported Reddit domains.
- No `eval`, no `Function` constructor, no script execution from imports.
- No secrets, no credentials, no Reddit OAuth.
- Session-only isolation: no cookies, no `localStorage`, no `sessionStorage`, no `IndexedDB`.

---

## Testing & Verification

### Automated Integration Tests

Open `tests/test-runner.html` in a browser. The test suite executes directly against `app.js` and `bookmarklet.js` using `window.RedMem`.

**Automated Test Results (19/19 Passed):**
1. Standard Reddit post URL acceptance and comments path canonicalization.
2. `old.reddit.com` post permalink canonicalization.
3. `redd.it` shortlink canonicalization.
4. Stripping tracking parameters (`utm_*`, `context`, `rdt`, `ref`, `share_id`).
5. Non-Reddit domain rejection.
6. `javascript:` URL rejection.
7. `sanitizeUrl` acceptance of safe `http`/`https` URLs.
8. `sanitizeUrl` sanitization of `javascript:` and `data:` URLs to `#`.
9. Duplicate detection across normalized post IDs.
10. External destination URL vs Reddit permalink separation for link posts.
11. `addRecord` enforcement directly at actual `MAX_RECORDS` (5,000) boundary.
12. `importJson` enforcement of actual `MAX_RECORDS` (5,000) capacity limit during bulk import.
13. `importJson` preservation of external destination URLs and Reddit permalinks.
14. `importJson` rejection of invalid Reddit permalinks and safe handling of unsafe destination URLs.
15. `renderStats` accurate rendering of total, retrieved, link-only, and failed counts in DOM elements.
16. Bookmarklet code generation.
17. Tag parsing, deduplication, and length capping.
18. Markdown character escaping.
19. Source code audit confirming complete absence of persistent storage implementations (`localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `serviceWorker`).

### Manual Verification Steps

1. **URL Entry & Retrieval/Link-only**: Paste `https://www.reddit.com/r/test/comments/abc123/title/?utm_source=share` and click "Add as link-only". Record appears as Link-only.
2. **Search & Filter**: Type keywords into search field or select tags/status filters. UI updates live.
3. **JSON Export & Import**: Click "Export JSON", clear collection, import the saved file. Records are restored cleanly.
4. **Duplicate Handling**: Attempt to re-add the same URL; inline error indicates duplicate.
5. **No Persistence Audit**: Inspect DevTools -> Application -> Storage (`localStorage`, `sessionStorage`, `IndexedDB`, `Cookies`). Confirm 0 keys stored.

---

## Known limitations

- **CORS / Reddit access controls**: Browsers block direct `fetch` to Reddit's JSON endpoints on many networks. Retrieval falls back gracefully to link-only.
- **No backend**: RedMem operates entirely client-side.
- **Session-only memory**: Data is permanently discarded on tab close or refresh unless exported.

---

## License

MIT License. See `LICENSE`.
