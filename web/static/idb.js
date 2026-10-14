/**
 * IndexedDB storage helper for Reddit Memory PWA offline library.
 */
const DB_NAME = 'RedditMemoryDB';
const DB_VERSION = 1;
const STORE_NAME = 'library_items';
const MAX_CACHE_ITEMS = 25;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'slug' });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

async function saveLibraryItems(items) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    // Keep max N items
    const sorted = [...items].sort((a, b) => (b.created_utc || 0) - (a.created_utc || 0)).slice(0, MAX_CACHE_ITEMS);

    for (const item of sorted) {
      store.put(item);
    }
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
    });
  } catch (e) {
    console.error('IndexedDB saveLibraryItems error:', e);
    return false;
  }
}

async function saveLibraryItem(item) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(item);
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
    });
  } catch (e) {
    console.error('IndexedDB saveLibraryItem error:', e);
    return false;
  }
}

async function getLibraryItems() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    return new Promise((resolve) => {
      request.onsuccess = () => {
        const items = request.result || [];
        items.sort((a, b) => (b.created_utc || 0) - (a.created_utc || 0));
        resolve(items);
      };
      request.onerror = () => resolve([]);
    });
  } catch (e) {
    console.error('IndexedDB getLibraryItems error:', e);
    return [];
  }
}

async function getLibraryItem(slug) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(slug);
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  } catch (e) {
    console.error('IndexedDB getLibraryItem error:', e);
    return null;
  }
}

async function deleteLibraryItem(slug) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(slug);
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
    });
  } catch (e) {
    console.error('IndexedDB deleteLibraryItem error:', e);
    return false;
  }
}

window.IDBStorage = {
  saveLibraryItems,
  saveLibraryItem,
  getLibraryItems,
  getLibraryItem,
  deleteLibraryItem
};
