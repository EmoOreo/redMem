# Reddit Memory - PWA Guide & Documentation

## Overview
Reddit Memory is a Progressive Web App (PWA) that scrapes Reddit threads using Playwright headless Chromium, saving them as JSON and Markdown files with optional Chroma semantic search and an offline-first web interface.

---

## 1. Installation

### Desktop (Chrome, Edge, Brave)
1. Open the application in your browser (e.g. `http://localhost:8000`).
2. Click the **"Install"** button in the top app header or the browser URL bar install icon.
3. Once installed, Reddit Memory launches in its own standalone window.

### Mobile (Android - Chrome)
1. Navigate to the app URL.
2. Tap the **"Install"** button on the top app header or open Chrome menu (⋮) and select **"Add to Home screen"**.
3. The app installs as a native-feeling app icon on your home screen.

### Mobile (iOS - Safari)
1. Open the app URL in Safari.
2. Tap the **Share** button (box with upward arrow).
3. Scroll down and select **"Add to Home Screen"**.

---

## 2. How Caching & Offline Work

- **App Shell Precaching**: Service Worker (`sw.js`) precaches core assets (`/`, `/offline`, `/manifest.webmanifest`, `/static/tailwind.css`, `/static/app.js`, `/static/idb.js`, and icons).
- **IndexedDB Sync**: The last 25 saved library items are automatically stored in client-side IndexedDB (`IDBStorage`). When offline, the Library tab reads directly from IndexedDB.
- **Stale-While-Revalidate**: `/api/library` and download routes use a stale-while-revalidate caching strategy so saved files are instantly accessible offline.
- **Network-Only Live Actions**: Live scraping requests (`/api/fetch`) and job status polling (`/api/progress/*`) require network connectivity.
- **Offline Fallback**: Failed HTML navigation requests automatically serve the friendly `/offline` page shell.

---

## 3. How to Bump the Service Worker Cache Version

When releasing updates to static CSS, JS, or HTML templates:
1. Open `web/static/sw.js`.
2. Update the `CACHE_NAME` constant:
   ```javascript
   const CACHE_NAME = 'reddit-memory-v2'; // Increment version number
   ```
3. Upon activation, the Service Worker automatically purges old caches (`reddit-memory-v1`) and replaces them with fresh assets.

---

## 4. Reddit DOM & Scraping Caveats

- **No Reddit Credentials Required**: The Playwright scraper drives a headless Chromium instance to interact directly with rendered Web Components (`shreddit-post`, `shreddit-comment`).
- **Dynamic Selectors**: Reddit frequently updates shadow DOM custom element selectors (`shreddit-comment`, `faceplate-tracker`, etc.). The scraper uses resilient fallback query selectors.
- **Job Cancellation**: Fetching long threads with many "more replies" triggers can be cancelled at any time using the **Cancel Job** button. The server fetcher checks `cancel_event` between expansion clicks and stops immediately without saving partial or corrupted state.
- **Rate Limiting**: Executing continuous rapid fetches may cause temporary Reddit rate-limiting or anti-bot verification challenges. Keep fetch requests spaced appropriately.
