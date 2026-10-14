/**
 * Reddit Memory PWA Application Script
 */

let deferredInstallPrompt = null;
let activeTab = 'fetch';
let activePollIntervals = {};
let recentJobs = JSON.parse(localStorage.getItem('reddit_memory_jobs') || '[]');

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initSW();
  initInstallPrompt();
  initTabs();
  initShareTarget();
  initNetworkStatus();
  initFetchUX();
  initLibraryUX();
  initSearchUX();
  initSettingsUX();
  loadRecentJobs();
});

/* --- Theme Management --- */
function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (prefersDark ? 'dark' : 'light');
  setTheme(theme);

  const themeToggle = document.getElementById('theme-toggle-btn');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      setTheme(next);
    });
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute('content', theme === 'dark' ? '#0f172a' : '#f8fafc');
  }
  const themeText = document.getElementById('theme-toggle-text');
  if (themeText) {
    themeText.textContent = theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
  }
}

/* --- Service Worker Registration --- */
function initSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((reg) => console.log('[SW] Registered successfully:', reg.scope))
      .catch((err) => console.error('[SW] Registration failed:', err));
  }
}

/* --- Install Prompt --- */
function initInstallPrompt() {
  const installBtns = document.querySelectorAll('.install-app-btn');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtns.forEach(btn => btn.classList.remove('hidden'));
  });

  installBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      console.log('User choice outcome:', outcome);
      deferredInstallPrompt = null;
      installBtns.forEach(b => b.classList.add('hidden'));
    });
  });

  window.addEventListener('appinstalled', () => {
    console.log('App installed successfully');
    deferredInstallPrompt = null;
    installBtns.forEach(btn => btn.classList.add('hidden'));
  });
}

/* --- Tabs & Navigation --- */
function initTabs() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      switchTab(target);
    });
  });
}

function switchTab(tabName) {
  activeTab = tabName;
  document.querySelectorAll('.nav-tab').forEach(t => {
    const isActive = t.dataset.tab === tabName;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  document.querySelectorAll('.tab-content').forEach(section => {
    const isActive = section.id === `tab-${tabName}`;
    section.classList.toggle('hidden', !isActive);
  });

  if (tabName === 'library') {
    loadLibrary();
  }
}

/* --- Share Target Support --- */
function initShareTarget() {
  const params = new URLSearchParams(window.location.search);
  const sharedUrl = params.get('url') || params.get('text') || params.get('title');
  if (sharedUrl) {
    let urlToFetch = sharedUrl;
    const urlMatch = sharedUrl.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      urlToFetch = urlMatch[1];
    }
    const urlInput = document.getElementById('fetch-url-input');
    if (urlInput) {
      urlInput.value = urlToFetch;
      switchTab('fetch');
      const autoFetchNotice = document.getElementById('share-target-notice');
      if (autoFetchNotice) {
        autoFetchNotice.classList.remove('hidden');
      }
    }
  }
}

/* --- Network Status Pill --- */
function initNetworkStatus() {
  const pill = document.getElementById('offline-pill');

  function updateOnlineStatus() {
    const isOnline = navigator.onLine;
    if (pill) {
      if (!isOnline) {
        pill.classList.remove('hidden');
      } else {
        pill.classList.add('hidden');
      }
    }
  }

  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();
}

/* --- Fetch UX & Job Polling --- */
function initFetchUX() {
  const form = document.getElementById('fetch-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('fetch-url-input');
      const url = input ? input.value.strip ? input.value.strip() : input.value.trim() : '';
      if (!url) return;

      try {
        const res = await fetch('/api/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });

        if (!res.ok) {
          const err = await res.json();
          alert(`Error starting fetch: ${err.detail || 'Server error'}`);
          return;
        }

        const data = await res.json();
        const jobId = data.job_id;

        // Save job locally
        const newJob = {
          job_id: jobId,
          url,
          status: 'running',
          created_at: Date.now()
        };
        recentJobs.unshift(newJob);
        saveRecentJobs();

        // Clear input
        if (input) input.value = '';
        const notice = document.getElementById('share-target-notice');
        if (notice) notice.classList.add('hidden');

        startJobPolling(jobId);
      } catch (err) {
        alert(`Failed to trigger fetch: ${err.message}`);
      }
    });
  }
}

function saveRecentJobs() {
  localStorage.setItem('reddit_memory_jobs', JSON.stringify(recentJobs.slice(0, 10)));
}

function loadRecentJobs() {
  recentJobs.forEach(job => {
    if (job.status === 'running' || job.status === 'queued') {
      startJobPolling(job.job_id);
    } else {
      renderJobCard(job);
    }
  });
}

function startJobPolling(jobId) {
  if (activePollIntervals[jobId]) return;

  const poll = async () => {
    try {
      const res = await fetch(`/api/progress/${jobId}`);
      if (!res.ok) {
        stopJobPolling(jobId);
        updateJobCardStatus(jobId, { status: 'failed', error: 'Job not found on server (server restarted)' });
        return;
      }
      const data = await res.json();
      updateJobCardStatus(jobId, data);

      if (['completed', 'failed', 'cancelled'].includes(data.status)) {
        stopJobPolling(jobId);
        if (data.status === 'completed') {
          loadLibrary(); // refresh library
        }
      }
    } catch (err) {
      console.warn('Job progress poll error:', err);
    }
  };

  poll();
  activePollIntervals[jobId] = setInterval(poll, 1500);
}

function stopJobPolling(jobId) {
  if (activePollIntervals[jobId]) {
    clearInterval(activePollIntervals[jobId]);
    delete activePollIntervals[jobId];
  }
}

function updateJobCardStatus(jobId, data) {
  // Update in recentJobs array
  const idx = recentJobs.findIndex(j => j.job_id === jobId);
  if (idx !== -1) {
    recentJobs[idx] = { ...recentJobs[idx], ...data };
    saveRecentJobs();
  }

  renderJobCard(data);
}

function renderJobCard(jobData) {
  const container = document.getElementById('job-cards-container');
  if (!container) return;

  const existing = document.getElementById(`job-card-${jobData.job_id}`);

  const statusBadges = {
    queued: '<span class="badge">Queued</span>',
    running: '<span class="badge" style="color:var(--accent);">Fetching...</span>',
    completed: '<span class="badge badge-success">Completed</span>',
    failed: '<span class="badge badge-danger">Failed</span>',
    cancelled: '<span class="badge">Cancelled</span>',
    cancelling: '<span class="badge">Cancelling...</span>'
  };

  const progress = jobData.progress || { stage: jobData.status, count: 0, total: 100, elapsed: 0, message: '' };
  const percent = Math.min(100, Math.max(0, Math.round((progress.count / progress.total) * 100))) || (jobData.status === 'completed' ? 100 : 10);

  const title = jobData.result ? jobData.result.title : (jobData.url || `Job ${jobData.job_id.slice(0, 8)}`);

  let actionsHtml = '';
  if (jobData.status === 'running' || jobData.status === 'queued') {
    actionsHtml = `<button class="btn btn-danger" style="min-height:36px; padding:0.25rem 0.75rem; font-size:0.85rem;" onclick="cancelJob('${jobData.job_id}')">Cancel Job</button>`;
  } else if (jobData.status === 'completed' && jobData.result) {
    actionsHtml = `
      <a href="/api/library/${jobData.result.slug}/download/json" class="btn btn-secondary" style="min-height:36px; padding:0.25rem 0.75rem; font-size:0.85rem;" download>JSON</a>
      <a href="/api/library/${jobData.result.slug}/download/md" class="btn btn-secondary" style="min-height:36px; padding:0.25rem 0.75rem; font-size:0.85rem;" download>MD</a>
      <button class="btn btn-primary" style="min-height:36px; padding:0.25rem 0.75rem; font-size:0.85rem;" onclick="viewPost('${jobData.result.slug}')">View Thread</button>
    `;
  } else if (jobData.error && jobData.error.includes('server restarted')) {
    actionsHtml = `<span style="font-size:0.8rem; color:var(--text-secondary);">Notice: Server restarted, file available in Library if completed previously.</span>`;
  }

  const logsHtml = (jobData.logs || []).join('\n');

  const cardHtml = `
    <div class="card-title" style="display:flex; justify-content:space-between; align-items:flex-start;">
      <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:70%;">${escapeHtml(title)}</span>
      ${statusBadges[jobData.status] || '<span class="badge">' + jobData.status + '</span>'}
    </div>
    <div class="card-meta">
      <span>Stage: ${escapeHtml(progress.stage)}</span>
      <span>Elapsed: ${progress.elapsed || 0}s</span>
    </div>
    ${jobData.status === 'running' ? `
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: ${percent}%;"></div>
      </div>
      <p style="font-size:0.825rem; color:var(--text-secondary); margin-bottom:0.5rem;">${escapeHtml(progress.message)}</p>
    ` : ''}
    ${jobData.error ? `<p style="font-size:0.85rem; color:var(--danger); margin-bottom:0.5rem;">${escapeHtml(jobData.error)}</p>` : ''}
    <div class="card-actions">
      ${actionsHtml}
    </div>
    <details style="margin-top:0.5rem;">
      <summary class="collapsible-header" style="font-size:0.8rem; color:var(--text-secondary);">
        Show raw logs (${(jobData.logs || []).length} entries)
      </summary>
      <pre style="font-size:0.75rem; background:var(--bg-input); padding:0.5rem; border-radius:0.375rem; overflow-x:auto; max-height:150px; color:var(--text-primary); margin-top:0.25rem;">${escapeHtml(logsHtml)}</pre>
    </details>
  `;

  if (existing) {
    existing.innerHTML = cardHtml;
  } else {
    const cardEl = document.createElement('div');
    cardEl.className = 'card';
    cardEl.id = `job-card-${jobData.job_id}`;
    cardEl.innerHTML = cardHtml;
    container.prepend(cardEl);
  }
}

async function cancelJob(jobId) {
  try {
    await fetch(`/api/fetch/${jobId}/cancel`, { method: 'POST' });
    updateJobCardStatus(jobId, { status: 'cancelling', progress: { stage: 'cancelling', count: 0, total: 100, elapsed: 0, message: 'Cancelling job...' } });
  } catch (e) {
    alert('Failed to request cancellation');
  }
}

/* --- Library UX --- */
async function loadLibrary() {
  const container = document.getElementById('library-container');
  if (!container) return;

  // 1. Read from IndexedDB first for instant offline view
  if (window.IDBStorage) {
    const cachedItems = await window.IDBStorage.getLibraryItems();
    if (cachedItems && cachedItems.length > 0) {
      renderLibraryItems(cachedItems, true);
    }
  }

  // 2. Fetch fresh items if online
  if (navigator.onLine) {
    try {
      const res = await fetch('/api/library');
      if (res.ok) {
        const serverItems = await res.json();
        renderLibraryItems(serverItems, false);
        if (window.IDBStorage) {
          window.IDBStorage.saveLibraryItems(serverItems);
        }
      }
    } catch (e) {
      console.warn('Failed to fetch library from server:', e);
    }
  }
}

function renderLibraryItems(items, isOfflineSource = false) {
  const container = document.getElementById('library-container');
  if (!container) return;

  if (!items || items.length === 0) {
    container.innerHTML = `
      <div class="card" style="text-align:center; padding:2rem;">
        <p style="color:var(--text-secondary);">No saved Reddit threads yet.</p>
        <p style="font-size:0.875rem; margin-top:0.5rem;">Use the Fetch tab to save a Reddit thread.</p>
      </div>
    `;
    return;
  }

  const searchFilter = (document.getElementById('library-filter-input')?.value || '').toLowerCase();
  const sortSelect = document.getElementById('library-sort-select')?.value || 'date_desc';

  let filtered = items.filter(item => {
    if (!searchFilter) return true;
    return (item.title || '').toLowerCase().includes(searchFilter) ||
           (item.subreddit || '').toLowerCase().includes(searchFilter) ||
           (item.author || '').toLowerCase().includes(searchFilter);
  });

  filtered.sort((a, b) => {
    if (sortSelect === 'score_desc') return (b.score || 0) - (a.score || 0);
    if (sortSelect === 'comments_desc') return (b.num_comments || 0) - (a.num_comments || 0);
    return (b.created_utc || 0) - (a.created_utc || 0);
  });

  container.innerHTML = filtered.map(item => `
    <div class="card" id="lib-card-${item.slug}">
      <div class="card-title">${escapeHtml(item.title)}</div>
      <div class="card-meta">
        <span>r/${escapeHtml(item.subreddit || 'reddit')}</span>
        <span>u/${escapeHtml(item.author || 'unknown')}</span>
        <span>${item.score || 0} pts</span>
        <span>${item.num_comments || 0} comments</span>
      </div>
      <div class="card-actions">
        <button class="btn btn-primary" style="min-height:36px; padding:0.25rem 0.75rem; font-size:0.85rem;" onclick="viewPost('${item.slug}')">View</button>
        <a href="/api/library/${item.slug}/download/json" class="btn btn-secondary" style="min-height:36px; padding:0.25rem 0.75rem; font-size:0.85rem;" download>JSON</a>
        <a href="/api/library/${item.slug}/download/md" class="btn btn-secondary" style="min-height:36px; padding:0.25rem 0.75rem; font-size:0.85rem;" download>MD</a>
        <button class="btn btn-danger" style="min-height:36px; padding:0.25rem 0.75rem; font-size:0.85rem;" onclick="deletePost('${item.slug}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function initLibraryUX() {
  const filterInput = document.getElementById('library-filter-input');
  const sortSelect = document.getElementById('library-sort-select');

  if (filterInput) filterInput.addEventListener('input', loadLibrary);
  if (sortSelect) sortSelect.addEventListener('change', loadLibrary);
}

async function viewPost(slug) {
  let post = null;

  // Try fetching post from server
  if (navigator.onLine) {
    try {
      const res = await fetch(`/api/library/${slug}`);
      if (res.ok) {
        post = await res.json();
      }
    } catch (e) {}
  }

  // Fallback to IndexedDB
  if (!post && window.IDBStorage) {
    post = await window.IDBStorage.getLibraryItem(slug);
  }

  if (!post) {
    alert('Post content not available offline.');
    return;
  }

  // Render post detail in modal
  const modal = document.getElementById('post-modal');
  const modalContent = document.getElementById('post-modal-content');
  if (!modal || !modalContent) return;

  const commentsTreeHtml = renderCommentsTree(post.comments || []);

  modalContent.innerHTML = `
    <h2 style="font-size:1.25rem; font-weight:700; margin-bottom:0.5rem; color:var(--text-primary);">${escapeHtml(post.title)}</h2>
    <div style="font-size:0.825rem; color:var(--text-secondary); margin-bottom:1rem; display:flex; flex-wrap:wrap; gap:0.75rem;">
      <span>r/${escapeHtml(post.subreddit)}</span>
      <span>u/${escapeHtml(post.author)}</span>
      <span>${post.score} points</span>
      <span>${post.num_comments} comments</span>
    </div>
    ${post.selftext ? `<div style="background:var(--bg-input); padding:0.875rem; border-radius:0.5rem; font-size:0.95rem; margin-bottom:1rem; white-space:pre-wrap;">${escapeHtml(post.selftext)}</div>` : ''}
    <h3 style="font-size:1rem; font-weight:700; border-bottom:1px solid var(--border); padding-bottom:0.5rem; margin-bottom:0.75rem;">Comments</h3>
    <div style="max-height:50vh; overflow-y:auto; padding-right:0.25rem;">
      ${commentsTreeHtml || '<p style="color:var(--text-secondary); font-size:0.9rem;">No comments saved.</p>'}
    </div>
  `;

  modal.classList.add('active');
}

function renderCommentsTree(comments, depth = 0) {
  if (!comments || comments.length === 0) return '';
  return comments.map(c => `
    <div style="margin-left:${depth * 0.75}rem; border-left: 2px solid var(--border); padding-left:0.5rem; margin-bottom:0.75rem;">
      <div style="font-size:0.8rem; font-weight:700; color:var(--accent);">
        u/${escapeHtml(c.author)} <span style="color:var(--text-secondary); font-weight:normal;">(${c.score} pts)</span>
      </div>
      <div style="font-size:0.9rem; margin-top:0.25rem; white-space:pre-wrap;">${escapeHtml(c.body)}</div>
      ${c.replies && c.replies.length > 0 ? renderCommentsTree(c.replies, depth + 1) : ''}
    </div>
  `).join('');
}

function closePostModal() {
  const modal = document.getElementById('post-modal');
  if (modal) modal.classList.remove('active');
}

async function deletePost(slug) {
  if (!confirm(`Delete thread '${slug}'?`)) return;

  if (navigator.onLine) {
    try {
      await fetch(`/api/library/${slug}`, { method: 'DELETE' });
    } catch (e) {}
  }

  if (window.IDBStorage) {
    await window.IDBStorage.deleteLibraryItem(slug);
  }

  loadLibrary();
}

/* --- Search UX --- */
function initSearchUX() {
  const form = document.getElementById('search-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('search-input');
      const query = input ? input.value.trim() : '';
      if (!query) return;

      const container = document.getElementById('search-results-container');
      if (!container) return;

      container.innerHTML = '<p style="color:var(--text-secondary);">Searching...</p>';

      try {
        if (navigator.onLine) {
          const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
          if (res.ok) {
            const results = await res.json();
            renderSearchResults(results);
            return;
          }
        }

        // Offline search using IDB
        if (window.IDBStorage) {
          const items = await window.IDBStorage.getLibraryItems();
          const qLower = query.toLowerCase();
          const filtered = items.filter(i =>
            (i.title || '').toLowerCase().includes(qLower) ||
            (i.selftext || '').toLowerCase().includes(qLower)
          );
          renderSearchResults(filtered);
        }
      } catch (err) {
        container.innerHTML = `<p style="color:var(--danger);">Search failed: ${escapeHtml(err.message)}</p>`;
      }
    });
  }
}

function renderSearchResults(results) {
  const container = document.getElementById('search-results-container');
  if (!container) return;

  if (!results || results.length === 0) {
    container.innerHTML = '<p style="color:var(--text-secondary);">No matching results found.</p>';
    return;
  }

  container.innerHTML = results.map(item => `
    <div class="card">
      <div class="card-title">${escapeHtml(item.title)}</div>
      <div class="card-meta">
        <span>r/${escapeHtml(item.subreddit || 'reddit')}</span>
        <span>u/${escapeHtml(item.author || 'unknown')}</span>
      </div>
      ${item.snippet ? `<p style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:0.5rem; background:var(--bg-input); padding:0.5rem; border-radius:0.375rem;">${escapeHtml(item.snippet)}</p>` : ''}
      <div class="card-actions">
        <button class="btn btn-primary" style="min-height:36px; padding:0.25rem 0.75rem; font-size:0.85rem;" onclick="viewPost('${item.slug}')">View Thread</button>
      </div>
    </div>
  `).join('');
}

/* --- Settings UX --- */
function initSettingsUX() {
  const settingsBtn = document.getElementById('settings-btn');
  const modal = document.getElementById('settings-modal');
  const closeBtn = document.getElementById('close-settings-btn');
  const clearCacheBtn = document.getElementById('clear-cache-btn');

  if (settingsBtn && modal) {
    settingsBtn.addEventListener('click', () => modal.classList.add('active'));
  }
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.remove('active'));
  }

  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', async () => {
      if (confirm('Clear local app storage and cached library files?')) {
        localStorage.clear();
        if (window.indexedDB) {
          indexedDB.deleteDatabase('RedditMemoryDB');
        }
        if ('caches' in window) {
          const names = await caches.keys();
          for (const name of names) await caches.delete(name);
        }
        alert('Local cache cleared successfully.');
        window.location.reload();
      }
    });
  }
}

/* Helper functions */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
