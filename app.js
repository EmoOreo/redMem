/* =========================================================
   RedMem — session-only Reddit research
   No persistence. All state lives in memory and is discarded on refresh / navigation.
   ========================================================= */

(function () {
  "use strict";

  /* ---------------------------------------------------------
     Constants & limits
     --------------------------------------------------------- */
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB
  const MAX_RECORDS = 5000;
  const MAX_TEXT_LENGTH = 20000; // per field, on import

  const ALLOWED_REDDIT_HOSTS = new Set([
    "reddit.com",
    "www.reddit.com",
    "old.reddit.com",
    "np.reddit.com",
    "m.reddit.com",
    "redd.it",
  ]);

  /* ---------------------------------------------------------
     In-memory state (the ONLY place records live)
     --------------------------------------------------------- */
  const state = {
    records: [], // array of record objects
    tags: new Set(), // unique tag strings
    nextId: 1,
  };

  /* ---------------------------------------------------------
     Utilities
     --------------------------------------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function nowISO() {
    return new Date().toISOString();
  }

  function uid() {
    return "r" + (state.nextId++) + "-" + Date.now().toString(36);
  }

  function safeString(v, max = MAX_TEXT_LENGTH) {
    if (v == null) return "";
    let s = String(v);
    if (s.length > max) s = s.slice(0, max);
    return s;
  }

  /** Sanitize URL to ensure it uses http or https protocol to prevent XSS links */
  function sanitizeUrl(raw) {
    if (!raw || typeof raw !== "string") return "#";
    const trimmed = raw.trim();
    try {
      const parsed = new URL(trimmed, window.location.href);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.href;
      }
    } catch {
      /* invalid URL */
    }
    return "#";
  }

  /** Normalize a Reddit URL for dedupe. Returns null if invalid. */
  function normalizeRedditUrl(raw) {
    if (!raw || typeof raw !== "string") return null;
    let url;
    try {
      url = new URL(raw.trim());
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    let host = url.hostname.toLowerCase();
    if (!ALLOWED_REDDIT_HOSTS.has(host)) return null;

    let path = url.pathname.replace(/\/+$/, "");

    // Match Reddit post permalink structures:
    // e.g. /r/sub/comments/post_id/slug or /comments/post_id/slug or redd.it/post_id
    let postId = null;
    let subMatch = path.match(/^\/r\/[^\/]+\/comments\/([a-z0-9]+)/i);
    if (subMatch) {
      postId = subMatch[1].toLowerCase();
    } else {
      let commMatch = path.match(/^\/comments\/([a-z0-9]+)/i);
      if (commMatch) {
        postId = commMatch[1].toLowerCase();
      } else if (host === "redd.it") {
        let reddMatch = path.match(/^\/([a-z0-9]+)/i);
        if (reddMatch) {
          postId = reddMatch[1].toLowerCase();
        }
      }
    }

    // Remove tracking query params
    const params = new URLSearchParams(url.search);
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","share_id","correlation_id","ref","ref_source","context","rdt","embed_host_url"]
      .forEach(p => params.delete(p));

    const query = params.toString();

    if (postId) {
      return `https://www.reddit.com/comments/${postId}${query ? "?" + query : ""}`;
    }

    // Fallback for general Reddit URLs (e.g. subreddit or root)
    if (host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it") {
      host = "www.reddit.com";
    }
    return `https://${host}${path}${query ? "?" + query : ""}`;
  }

  function isRedditUrl(raw) {
    return normalizeRedditUrl(raw) !== null;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeMarkdown(s) {
    if (s == null) return "";
    return String(s)
      .replace(/\\/g, "\\\\")
      .replace(/([`*_{}\[\]()#+\-.!|>])/g, "\\$1")
      .replace(/\n/g, " \n");
  }

  function truncate(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  /* ---------------------------------------------------------
     Tag management
     --------------------------------------------------------- */
  function parseTags(input) {
    if (!input) return [];
    const parts = String(input).split(/[,\n]/);
    const out = [];
    const seen = new Set();
    for (let p of parts) {
      p = p.trim().replace(/\s+/g, " ");
      if (!p) continue;
      if (p.length > 40) p = p.slice(0, 40);
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }

  function registerTags(tags) {
    for (const t of tags) state.tags.add(t);
    renderTagFilter();
  }

  function unregisterUnusedTags() {
    const used = new Set();
    for (const r of state.records) for (const t of r.tags) used.add(t);
    state.tags = used;
    renderTagFilter();
  }

  /* ---------------------------------------------------------
     Duplicate detection
     --------------------------------------------------------- */
  function findDuplicate(normalizedUrl) {
    if (!normalizedUrl) return null;
    return state.records.find(r => r.normalizedUrl === normalizedUrl) || null;
  }

  /* ---------------------------------------------------------
     Retrieval (browser-compatible, best-effort)
     ---------------------------------------------------------
     We attempt a public fetch of the post's .json endpoint.
     Many browsers will block this due to CORS and Reddit's access
     controls. We NEVER claim success unless we actually parsed a response.
     --------------------------------------------------------- */
  async function tryRetrieve(url) {
    const normalized = normalizeRedditUrl(url);
    if (!normalized) return { ok: false, reason: "invalid-url" };

    // Build the .json endpoint. Reddit accepts appending .json to the permalink.
    let jsonUrl;
    try {
      const u = new URL(normalized);
      let p = u.pathname.replace(/\/+$/, "");
      jsonUrl = `https://${u.hostname}${p}.json${u.search || ""}`;
    } catch {
      return { ok: false, reason: "invalid-url" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(jsonUrl, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        headers: { "Accept": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) return { ok: false, reason: "http-" + res.status };

      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("json")) return { ok: false, reason: "not-json" };

      const data = await res.json();
      const parsed = parseRedditJson(data, normalized);
      if (!parsed) return { ok: false, reason: "unexpected-shape" };

      return { ok: true, data: parsed };
    } catch (err) {
      clearTimeout(timeout);
      if (err && err.name === "AbortError") return { ok: false, reason: "timeout" };
      return { ok: false, reason: "network" };
    }
  }

  function parseRedditJson(data, fallbackUrl) {
    try {
      // Reddit returns an array: [postListing, commentsListing]
      const listing = Array.isArray(data) ? data[0] : data;
      const children = listing && listing.data && listing.data.children;
      if (!Array.isArray(children) || children.length === 0) return null;

      const post = children[0].data;
      if (!post) return null;

      const title = safeString(post.title, 500);
      const author = post.author ? safeString(post.author, 100) : "";
      const selftext = post.selftext ? safeString(post.selftext) : "";
      const subreddit = post.subreddit_name_prefixed || (post.subreddit ? "r/" + post.subreddit : "");
      const permalink = post.permalink ? "https://www.reddit.com" + post.permalink : fallbackUrl;
      const url = post.url_overridden_by_dest || permalink;

      return {
        title: title || "(untitled)",
        url: safeString(url, 2000),
        permalink: safeString(permalink, 2000),
        text: selftext,
        author,
        subreddit: safeString(subreddit, 120),
      };
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------
     Record model
     --------------------------------------------------------- */
  function createRecord({ url, permalink, title, text, author, subreddit, status, tags, notes, source }) {
    const redditPermalink = safeString(permalink || url, 2000);
    const normalizedUrl = normalizeRedditUrl(redditPermalink) || normalizeRedditUrl(url) || "";
    const destinationUrl = safeString(url || permalink, 2000);

    const rec = {
      id: uid(),
      title: safeString(title, 500) || "Reddit post",
      url: destinationUrl,
      permalink: redditPermalink,
      normalizedUrl: normalizedUrl,
      text: safeString(text),
      author: safeString(author, 200),
      subreddit: safeString(subreddit, 200),
      tags: Array.isArray(tags) ? tags.slice(0, 50) : [],
      notes: safeString(notes, 5000),
      status: status || "link-only", // retrieved | link-only | failed
      addedAt: nowISO(),
      source: source || "manual", // manual | bookmarklet | import
    };
    return rec;
  }

  function addRecord(rec) {
    if (state.records.length >= MAX_RECORDS) {
      return { error: "limit" };
    }
    if (rec.normalizedUrl) {
      const dup = findDuplicate(rec.normalizedUrl);
      if (dup) return { duplicate: dup };
    }
    state.records.push(rec);
    registerTags(rec.tags);
    return true;
  }

  function removeRecord(id) {
    const idx = state.records.findIndex(r => r.id === id);
    if (idx === -1) return false;
    const [removed] = state.records.splice(idx, 1);

    // Remove tags that are no longer used
    for (const t of removed.tags) {
      if (!state.records.some(r => r.tags.includes(t))) state.tags.delete(t);
    }
    renderTagFilter();
    return true;
  }

  function clearAll() {
    state.records = [];
    state.tags = new Set();
    renderTagFilter();
  }

  /* ---------------------------------------------------------
     Rendering
     --------------------------------------------------------- */
  function renderStats() {
    if ($("#stat-total")) $("#stat-total").textContent = String(state.records.length);
    if ($("#stat-retrieved")) $("#stat-retrieved").textContent = String(state.records.filter(r => r.status === "retrieved").length);
    // Link-only includes manually added link-only as well as failed retrievals stored as link-only
    if ($("#stat-linkonly")) $("#stat-linkonly").textContent = String(state.records.filter(r => r.status === "link-only" || r.status === "failed").length);
    if ($("#stat-tags")) $("#stat-tags").textContent = String(state.tags.size);
  }

  function renderTagFilter() {
    const sel = $("#filter-tag");
    if (!sel) return;
    const current = sel.value;
    const tags = Array.from(state.tags).sort((a, b) => a.localeCompare(b));

    sel.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All tags";
    sel.appendChild(all);

    for (const t of tags) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }

    if (tags.includes(current)) sel.value = current;
  }

  function getFilteredRecords() {
    const searchInput = $("#search-input");
    const tagSelect = $("#filter-tag");
    const statusSelect = $("#filter-status");
    const sortSelect = $("#sort-by");

    const q = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const tagFilter = tagSelect ? tagSelect.value : "";
    const statusFilter = statusSelect ? statusSelect.value : "";
    const sortBy = sortSelect ? sortSelect.value : "added-desc";

    let list = state.records.slice();

    if (q) {
      list = list.filter(r => {
        const hay = [
          r.title,
          r.text,
          r.author,
          r.notes,
          r.subreddit,
          r.tags.join(" "),
          r.url,
          r.permalink
        ].join(" ").toLowerCase();
        return hay.includes(q);
      });
    }

    if (tagFilter) list = list.filter(r => r.tags.includes(tagFilter));
    if (statusFilter) list = list.filter(r => r.status === statusFilter);

    switch (sortBy) {
      case "added-asc":
        list.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
        break;
      case "title-asc":
        list.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "title-desc":
        list.sort((a, b) => b.title.localeCompare(a.title));
        break;
      case "author-asc":
        list.sort((a, b) => (a.author || "").localeCompare(b.author || ""));
        break;
      case "added-desc":
      default:
        list.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
        break;
    }

    return list;
  }

  function renderRecords() {
    const ul = $("#record-list");
    if (!ul) {
      renderStats();
      return;
    }

    const list = getFilteredRecords();
    ul.innerHTML = "";

    const countEl = $("#results-count");
    if (countEl) countEl.textContent = list.length + " record" + (list.length === 1 ? "" : "s");

    const emptyState = $("#empty-state");
    if (list.length === 0) {
      if (emptyState) {
        emptyState.hidden = false;
        const emptyTitle = emptyState.querySelector(".empty-title");
        const emptyBody = emptyState.querySelector(".empty-body");
        if (state.records.length === 0) {
          if (emptyTitle) emptyTitle.textContent = "No records yet";
          if (emptyBody) emptyBody.textContent = "Add a Reddit post URL above, import a JSON export, or use the bookmarklet while viewing a Reddit post.";
        } else {
          if (emptyTitle) emptyTitle.textContent = "No matching records";
          if (emptyBody) emptyBody.textContent = "Try adjusting your search, tag filter, or status filter.";
        }
      }
      renderStats();
      return;
    }

    if (emptyState) emptyState.hidden = true;
    const frag = document.createDocumentFragment();
    for (const r of list) frag.appendChild(renderRecord(r));
    ul.appendChild(frag);

    renderStats();
  }

  function renderRecord(r) {
    const li = document.createElement("li");
    li.className = "record";
    li.dataset.id = r.id;

    // Head
    const head = document.createElement("div");
    head.className = "record-head";

    const titleWrap = document.createElement("div");
    const h3 = document.createElement("h3");
    h3.className = "record-title";

    const titleLink = document.createElement("a");
    titleLink.href = sanitizeUrl(r.url || r.permalink);
    titleLink.target = "_blank";
    titleLink.rel = "noopener noreferrer nofollow";
    titleLink.textContent = r.title || "Reddit post";
    h3.appendChild(titleLink);
    titleWrap.appendChild(h3);

    const meta = document.createElement("div");
    meta.className = "record-meta";
    if (r.author) meta.appendChild(metaSpan("u/" + r.author));
    if (r.subreddit) meta.appendChild(metaSpan(r.subreddit));
    meta.appendChild(metaSpan("Added " + formatDate(r.addedAt)));
    titleWrap.appendChild(meta);

    head.appendChild(titleWrap);

    const badge = document.createElement("span");
    badge.className = "badge " + r.status;
    badge.textContent = r.status === "retrieved" ? "Retrieved" : r.status === "failed" ? "Retrieval failed" : "Link-only";
    head.appendChild(badge);

    li.appendChild(head);

    // Body
    const bodyText = r.text || r.notes || "";
    if (bodyText) {
      const body = document.createElement("p");
      body.className = "record-body clamped";
      body.textContent = truncate(bodyText, 600);
      li.appendChild(body);
    }

    // Notes (if separate from text)
    if (r.notes && r.text) {
      const notes = document.createElement("div");
      notes.className = "record-notes";
      notes.textContent = r.notes;
      li.appendChild(notes);
    }

    // Tags
    if (r.tags.length) {
      const tags = document.createElement("div");
      tags.className = "record-tags";
      for (const t of r.tags) {
        const chip = document.createElement("span");
        chip.className = "tag-chip";

        const label = document.createElement("span");
        label.textContent = t;
        chip.appendChild(label);

        const rm = document.createElement("button");
        rm.type = "button";
        rm.title = "Remove tag";
        rm.setAttribute("aria-label", "Remove tag " + t);
        rm.textContent = "×";
        rm.addEventListener("click", () => {
          r.tags = r.tags.filter(x => x !== t);
          unregisterUnusedTags();
          renderRecords();
          renderStats();
        });
        chip.appendChild(rm);

        tags.appendChild(chip);
      }
      li.appendChild(tags);
    }

    // Actions
    const actions = document.createElement("div");
    actions.className = "record-actions";

    const openBtn = document.createElement("a");
    openBtn.className = "btn btn-icon";
    openBtn.href = sanitizeUrl(r.url || r.permalink);
    openBtn.target = "_blank";
    openBtn.rel = "noopener noreferrer nofollow";
    openBtn.textContent = "Open";
    actions.appendChild(openBtn);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn btn-icon";
    copyBtn.textContent = "Copy URL";
    copyBtn.addEventListener("click", () => {
      copyToClipboard(r.url || r.permalink || "");
    });
    actions.appendChild(copyBtn);

    const editTagsBtn = document.createElement("button");
    editTagsBtn.type = "button";
    editTagsBtn.className = "btn btn-icon";
    editTagsBtn.textContent = "Edit tags";
    editTagsBtn.addEventListener("click", () => editTags(r));
    actions.appendChild(editTagsBtn);

    const editNotesBtn = document.createElement("button");
    editNotesBtn.type = "button";
    editNotesBtn.className = "btn btn-icon";
    editNotesBtn.textContent = "Edit notes";
    editNotesBtn.addEventListener("click", () => editNotes(r));
    actions.appendChild(editNotesBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-icon";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      confirmDialog("Delete this record?", r.title || "Reddit post", () => {
        removeRecord(r.id);
        renderRecords();
        renderStats();
        toast("Record deleted.", "ok");
      });
    });
    actions.appendChild(delBtn);

    li.appendChild(actions);

    return li;
  }

  function metaSpan(text) {
    const s = document.createElement("span");
    s.textContent = text;
    return s;
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString();
    } catch {
      return iso;
    }
  }

  /* ---------------------------------------------------------
     Inline editing (tags / notes)
     --------------------------------------------------------- */
  function editTags(r) {
    const current = r.tags.join(", ");
    const next = window.prompt("Edit tags (comma separated):", current);
    if (next === null) return;
    r.tags = parseTags(next);
    registerTags(r.tags);
    unregisterUnusedTags();
    renderRecords();
    renderStats();
    toast("Tags updated.", "ok");
  }

  function editNotes(r) {
    const current = r.notes || "";
    const next = window.prompt("Edit notes:", current);
    if (next === null) return;
    r.notes = safeString(next, 5000);
    renderRecords();
    toast("Notes updated.", "ok");
  }

  /* ---------------------------------------------------------
     Add flow
     --------------------------------------------------------- */
  async function handleAdd(asLinkOnly) {
    const urlInput = $("#url-input");
    const tagsInput = $("#tags-input");
    const notesInput = $("#notes-input");
    const statusEl = $("#add-status");
    const errEl = $("#url-error");
    const addBtn = $("#add-btn");
    const linkBtn = $("#add-linkonly-btn");

    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
    if (statusEl) { statusEl.className = "status"; statusEl.textContent = ""; }

    const rawUrl = urlInput ? urlInput.value.trim() : "";

    if (!rawUrl) {
      if (errEl) { errEl.textContent = "Please enter a Reddit post URL."; errEl.hidden = false; }
      if (urlInput) urlInput.focus();
      return;
    }

    if (!isRedditUrl(rawUrl)) {
      if (errEl) { errEl.textContent = "That does not look like a supported Reddit post URL. Only reddit.com and redd.it links are accepted."; errEl.hidden = false; }
      if (urlInput) urlInput.focus();
      return;
    }

    const normalized = normalizeRedditUrl(rawUrl);
    const dup = findDuplicate(normalized);
    if (dup) {
      if (errEl) { errEl.textContent = "This post is already in your collection (duplicate URL)."; errEl.hidden = false; }
      toast("Duplicate detected — not added.", "warn");
      return;
    }

    const tags = parseTags(tagsInput ? tagsInput.value : "");
    const notes = safeString(notesInput ? notesInput.value : "", 5000);

    if (asLinkOnly) {
      const rec = createRecord({
        url: rawUrl,
        permalink: rawUrl,
        title: "Reddit post (link-only)",
        text: "",
        author: "",
        subreddit: "",
        status: "link-only",
        tags,
        notes,
        source: "manual",
      });
      const res = addRecord(rec);
      if (res && res.duplicate) {
        if (errEl) { errEl.textContent = "This post is already in your collection."; errEl.hidden = false; }
        return;
      }
      if (res && res.error === "limit") {
        if (errEl) { errEl.textContent = "Collection limit reached (" + MAX_RECORDS + " records)."; errEl.hidden = false; }
        toast("Collection limit reached.", "warn");
        return;
      }
      if (statusEl) { statusEl.className = "status ok"; statusEl.textContent = "Saved as link-only record."; }
      resetAddForm();
      renderRecords();
      toast("Link-only record added.", "ok");
      return;
    }

    // Attempt retrieval
    if (addBtn) addBtn.disabled = true;
    if (linkBtn) linkBtn.disabled = true;
    if (statusEl) { statusEl.className = "status"; statusEl.textContent = "Attempting retrieval…"; }

    let result;
    try {
      result = await tryRetrieve(rawUrl);
    } catch (e) {
      result = { ok: false, reason: "network" };
    } finally {
      if (addBtn) addBtn.disabled = false;
      if (linkBtn) linkBtn.disabled = false;
    }

    if (result.ok) {
      const d = result.data;
      const rec = createRecord({
        url: d.url || rawUrl,
        permalink: d.permalink || rawUrl,
        title: d.title,
        text: d.text,
        author: d.author,
        subreddit: d.subreddit,
        status: "retrieved",
        tags,
        notes,
        source: "manual",
      });

      const res = addRecord(rec);
      if (res && res.duplicate) {
        if (errEl) { errEl.textContent = "This post is already in your collection."; errEl.hidden = false; }
        return;
      }
      if (res && res.error === "limit") {
        if (errEl) { errEl.textContent = "Collection limit reached (" + MAX_RECORDS + " records)."; errEl.hidden = false; }
        toast("Collection limit reached.", "warn");
        return;
      }

      if (statusEl) { statusEl.className = "status ok"; statusEl.textContent = "Retrieved and saved successfully."; }
      resetAddForm();
      renderRecords();
      toast("Post retrieved and added.", "ok");
    } else {
      // Retrieval failed — save as link-only, clearly marked
      const rec = createRecord({
        url: rawUrl,
        permalink: rawUrl,
        title: "Reddit post (link-only)",
        text: "",
        author: "",
        subreddit: "",
        status: "failed",
        tags,
        notes,
        source: "manual",
      });
      const res = addRecord(rec);
      if (res && res.duplicate) {
        if (errEl) { errEl.textContent = "This post is already in your collection."; errEl.hidden = false; }
        return;
      }
      if (res && res.error === "limit") {
        if (errEl) { errEl.textContent = "Collection limit reached (" + MAX_RECORDS + " records)."; errEl.hidden = false; }
        toast("Collection limit reached.", "warn");
        return;
      }

      const reasonText = retrievalReasonText(result.reason);
      if (statusEl) { statusEl.className = "status warn"; statusEl.textContent = "Retrieval blocked or unavailable (" + reasonText + "). Saved as link-only."; }
      resetAddForm();
      renderRecords();
      toast("Saved as link-only (retrieval unavailable).", "warn");
    }
  }

  function retrievalReasonText(reason) {
    switch (reason) {
      case "timeout": return "timed out";
      case "network": return "network/CORS blocked";
      case "not-json": return "unexpected response";
      case "unexpected-shape": return "unexpected response shape";
      case "invalid-url": return "invalid URL";
      default:
        if (reason && reason.startsWith("http-")) return "HTTP " + reason.slice(5);
        return "unavailable";
    }
  }

  function resetAddForm() {
    const urlInput = $("#url-input");
    const tagsInput = $("#tags-input");
    const notesInput = $("#notes-input");
    if (urlInput) urlInput.value = "";
    if (tagsInput) tagsInput.value = "";
    if (notesInput) notesInput.value = "";
    if (urlInput) urlInput.focus();
  }

  /* ---------------------------------------------------------
     Export
     --------------------------------------------------------- */
  function buildExportObject() {
    return {
      app: "RedMem",
      format: "redmem-collection",
      version: 1,
      exportedAt: nowISO(),
      recordCount: state.records.length,
      records: state.records.map(r => ({
        title: r.title,
        url: r.url,
        permalink: r.permalink,
        normalizedUrl: r.normalizedUrl,
        text: r.text,
        author: r.author,
        subreddit: r.subreddit,
        tags: r.tags,
        notes: r.notes,
        status: r.status,
        addedAt: r.addedAt,
        source: r.source,
      })),
    };
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportJSON() {
    if (state.records.length === 0) {
      toast("Nothing to export — collection is empty.", "warn");
      return;
    }
    const obj = buildExportObject();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    download("redmem-collection-" + stamp + ".json", JSON.stringify(obj, null, 2), "application/json");
    toast("Exported " + state.records.length + " record(s).", "ok");
  }

  function exportMarkdown() {
    if (state.records.length === 0) {
      toast("Nothing to export — collection is empty.", "warn");
      return;
    }
    const lines = [];
    lines.push("# RedMem Collection");
    lines.push("");
    lines.push("Exported: " + new Date().toISOString());
    lines.push("Records: " + state.records.length);
    lines.push("");
    lines.push("---");
    lines.push("");

    for (const r of state.records) {
      lines.push("## " + escapeMarkdown(r.title || "Reddit post"));
      lines.push("");
      lines.push("- URL: " + sanitizeUrl(r.url || r.permalink));
      if (r.permalink && r.permalink !== r.url) {
        lines.push("- Reddit Permalink: " + sanitizeUrl(r.permalink));
      }
      if (r.author) lines.push("- Author: u/" + escapeMarkdown(r.author));
      if (r.subreddit) lines.push("- Subreddit: " + escapeMarkdown(r.subreddit));
      lines.push("- Status: " + r.status);
      lines.push("- Added: " + r.addedAt);
      if (r.tags.length) lines.push("- Tags: " + r.tags.map(escapeMarkdown).join(", "));
      lines.push("");

      if (r.text) {
        lines.push("### Text");
        lines.push("");
        lines.push(escapeMarkdown(r.text));
        lines.push("");
      }

      if (r.notes) {
        lines.push("### Notes");
        lines.push("");
        lines.push(escapeMarkdown(r.notes));
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    download("redmem-collection-" + stamp + ".md", lines.join("\n"), "text/markdown");
    toast("Markdown exported.", "ok");
  }

  /* ---------------------------------------------------------
     Import
     --------------------------------------------------------- */
  function handleImport(file) {
    const status = $("#import-status");
    if (status) { status.className = "status"; status.textContent = ""; }

    if (!file) return;

    if (file.size > MAX_IMPORT_BYTES) {
      if (status) {
        status.className = "status err";
        status.textContent = "File too large (" + Math.round(file.size / 1024) + " KB). Maximum is 5 MB.";
      }
      return;
    }

    const name = file.name.toLowerCase();
    const isJson = name.endsWith(".json") || file.type === "application/json";
    const isMd = name.endsWith(".md") || file.type === "text/markdown";
    const isTxt = name.endsWith(".txt") || file.type === "text/plain";

    if (!isJson && !isMd && !isTxt) {
      if (status) {
        status.className = "status err";
        status.textContent = "Unsupported file type. Use .json, .md, or .txt.";
      }
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      if (status) {
        status.className = "status err";
        status.textContent = "Could not read the file.";
      }
    };
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        if (isJson) importJson(text, status);
        else importText(text, status, isMd ? "markdown" : "text");
      } catch (e) {
        if (status) {
          status.className = "status err";
          status.textContent = "Import failed: " + (e && e.message ? e.message : "unknown error");
        }
      }
    };
    reader.readAsText(file);
  }

  function importJson(text, statusElement) {
    const status = statusElement || $("#import-status");
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      if (status) {
        status.className = "status err";
        status.textContent = "Invalid JSON: " + e.message;
      }
      return;
    }

    // Accept either the RedMem envelope or a bare array of records
    let records = null;
    if (Array.isArray(data)) records = data;
    else if (data && Array.isArray(data.records)) records = data.records;
    else if (data && data.format === "redmem-collection" && Array.isArray(data.records)) records = data.records;

    if (!records) {
      if (status) {
        status.className = "status err";
        status.textContent = "Unrecognized JSON structure. Expected a RedMem export or an array of records.";
      }
      return;
    }

    let added = 0, dupes = 0, invalid = 0, limitReached = false;

    for (const raw of records) {
      if (!raw || typeof raw !== "object") {
        invalid++;
        continue;
      }

      // Check permalink first, then url for Reddit validity
      const permalink = safeString(raw.permalink || raw.url, 2000);
      const destinationUrl = safeString(raw.url || raw.permalink, 2000);

      if (!permalink || !isRedditUrl(permalink)) {
        invalid++;
        continue;
      }

      const normalized = normalizeRedditUrl(permalink);
      if (findDuplicate(normalized)) {
        dupes++;
        continue;
      }

      const rec = createRecord({
        url: destinationUrl,
        permalink: permalink,
        title: safeString(raw.title, 500) || "Reddit post (imported)",
        text: safeString(raw.text, MAX_TEXT_LENGTH),
        author: safeString(raw.author, 200),
        subreddit: safeString(raw.subreddit, 200),
        status: ["retrieved","link-only","failed"].includes(raw.status) ? raw.status : "link-only",
        tags: parseTags(Array.isArray(raw.tags) ? raw.tags.join(", ") : raw.tags),
        notes: safeString(raw.notes, 5000),
        source: "import",
      });
      if (raw.addedAt) rec.addedAt = safeString(raw.addedAt, 40);

      const result = addRecord(rec);
      if (result === true) {
        added++;
      } else if (result && result.duplicate) {
        dupes++;
      } else if (result && result.error === "limit") {
        limitReached = true;
        break;
      }
    }

    if (status) {
      if (limitReached) {
        status.className = "status warn";
        status.textContent = "Import partially completed. Collection limit reached (" + MAX_RECORDS + " records). Imported " + added + " record(s).";
        toast("Limit reached (" + MAX_RECORDS + " records max).", "warn");
      } else {
        status.className = added > 0 ? "status ok" : "status warn";
        status.textContent = "Imported " + added + " record(s). Skipped " + dupes + " duplicate(s), " + invalid + " invalid.";
        if (added > 0) toast("Imported " + added + " record(s).", "ok");
      }
    }
    renderRecords();
    renderStats();
  }

  function importText(text, statusElement, kind) {
    const status = statusElement || $("#import-status");
    // Extract Reddit URLs from Markdown or plain text. Never execute markup.
    const urlRegex = /https?:\/\/(?:www\.|old\.|np\.|m\.)?reddit\.com\/[^\s)\]"'<>]+|https?:\/\/redd\.it\/[^\s)\]"'<>]+/gi;
    const found = text.match(urlRegex) || [];

    const unique = [];
    const seen = new Set();
    for (const u of found) {
      const clean = u.replace(/[.,;:]+$/, "");
      const n = normalizeRedditUrl(clean);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      unique.push(clean);
    }

    if (unique.length === 0) {
      if (status) {
        status.className = "status warn";
        status.textContent = "No Reddit URLs found in the " + kind + " file.";
      }
      return;
    }

    let added = 0, dupes = 0, limitReached = false;
    for (const u of unique) {
      const n = normalizeRedditUrl(u);
      if (findDuplicate(n)) {
        dupes++;
        continue;
      }

      const rec = createRecord({
        url: u,
        permalink: u,
        title: "Imported from " + kind,
        text: "",
        author: "",
        subreddit: "",
        status: "link-only",
        tags: [],
        notes: "",
        source: "import",
      });

      const result = addRecord(rec);
      if (result === true) {
        added++;
      } else if (result && result.duplicate) {
        dupes++;
      } else if (result && result.error === "limit") {
        limitReached = true;
        break;
      }
    }

    if (status) {
      if (limitReached) {
        status.className = "status warn";
        status.textContent = "Extraction partially completed. Collection limit reached (" + MAX_RECORDS + " records). Added " + added + " link(s).";
        toast("Limit reached (" + MAX_RECORDS + " records max).", "warn");
      } else {
        status.className = added > 0 ? "status ok" : "status warn";
        status.textContent = "Extracted " + added + " link(s) from " + kind + ". Skipped " + dupes + " duplicate(s).";
        if (added > 0) toast("Imported " + added + " link(s).", "ok");
      }
    }
    renderRecords();
    renderStats();
  }

  /* ---------------------------------------------------------
     Confirm dialog
     --------------------------------------------------------- */
  let confirmCallback = null;

  function confirmDialog(title, message, onConfirm) {
    const dlg = $("#confirm-dialog");
    if (!dlg) {
      if (window.confirm(title + "\n\n" + message)) onConfirm();
      return;
    }
    const titleEl = $("#confirm-title");
    const msgEl = $("#confirm-message");
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    confirmCallback = onConfirm;

    if (typeof dlg.showModal === "function") dlg.showModal();
    else if (window.confirm(title + "\n\n" + message)) {
      onConfirm();
      confirmCallback = null;
    }
  }

  function initDialog() {
    const dlg = $("#confirm-dialog");
    if (!dlg) return;
    dlg.addEventListener("close", () => {
      if (dlg.returnValue === "confirm" && typeof confirmCallback === "function") {
        confirmCallback();
      }
      confirmCallback = null;
    });
  }

  /* ---------------------------------------------------------
     Toast
     --------------------------------------------------------- */
  function toast(message, kind) {
    const region = $("#toast-region");
    if (!region) return;
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = message;
    region.appendChild(el);

    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 200);
    }, 3200);
  }

  /* ---------------------------------------------------------
     Clipboard
     --------------------------------------------------------- */
  function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => toast("Copied to clipboard.", "ok"))
        .catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      toast("Copied to clipboard.", "ok");
    } catch {
      toast("Copy failed — please copy manually.", "err");
    }
  }

  /* ---------------------------------------------------------
     Bookmarklet wiring
     --------------------------------------------------------- */
  function initBookmarklet() {
    const link = $("#bookmarklet-link");
    const code = window.RedMemBookmarklet && window.RedMemBookmarklet.code;
    if (!code) return;

    if (link) link.setAttribute("href", code);
    const codeEl = $("#bookmarklet-code");
    if (codeEl) codeEl.textContent = code;

    // If the URL has a ?redmem= parameter (from the bookmarklet), prefill.
    try {
      const params = new URLSearchParams(location.search);
      const incoming = params.get("redmem");
      if (incoming && isRedditUrl(incoming)) {
        const urlInput = $("#url-input");
        if (urlInput) {
          urlInput.value = incoming;
          toast("URL received from bookmarklet — review and add.", "ok");
          urlInput.focus();
        }
      }
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------
     Init
     --------------------------------------------------------- */
  function init() {
    // Add form
    const addForm = $("#add-form");
    if (addForm) {
      addForm.addEventListener("submit", (e) => {
        e.preventDefault();
        handleAdd(false);
      });
    }
    const addLinkBtn = $("#add-linkonly-btn");
    if (addLinkBtn) {
      addLinkBtn.addEventListener("click", () => handleAdd(true));
    }

    // Search / filters
    const searchInput = $("#search-input");
    if (searchInput) searchInput.addEventListener("input", renderRecords);
    const filterTag = $("#filter-tag");
    if (filterTag) filterTag.addEventListener("change", renderRecords);
    const filterStatus = $("#filter-status");
    if (filterStatus) filterStatus.addEventListener("change", renderRecords);
    const sortBy = $("#sort-by");
    if (sortBy) sortBy.addEventListener("change", renderRecords);

    // Clear all
    const clearBtn = $("#clear-all-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        if (state.records.length === 0) {
          toast("Collection is already empty.", "warn");
          return;
        }
        confirmDialog(
          "Clear all records?",
          "This will permanently remove all " + state.records.length + " record(s) from this session. This cannot be undone.",
          () => {
            clearAll();
            renderRecords();
            renderStats();
            toast("Collection cleared.", "ok");
          }
        );
      });
    }

    // Export / import
    const expJsonBtn = $("#export-json-btn");
    if (expJsonBtn) expJsonBtn.addEventListener("click", exportJSON);
    const expMdBtn = $("#export-md-btn");
    if (expMdBtn) expMdBtn.addEventListener("click", exportMarkdown);
    const impFile = $("#import-file");
    if (impFile) {
      impFile.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        handleImport(file);
        e.target.value = ""; // allow re-importing same file
      });
    }

    initDialog();
    initBookmarklet();
    if ($("#filter-tag")) renderTagFilter();
    if ($("#record-list")) renderRecords();
    if ($("#stat-total")) renderStats();

    // Warn on unload (defensive; browsers may ignore)
    window.addEventListener("beforeunload", (e) => {
      if (state.records.length > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  // Expose API for direct integration testing
  window.RedMem = {
    state,
    MAX_RECORDS,
    ALLOWED_REDDIT_HOSTS,
    normalizeRedditUrl,
    isRedditUrl,
    parseTags,
    escapeMarkdown,
    safeString,
    sanitizeUrl,
    findDuplicate,
    createRecord,
    addRecord,
    removeRecord,
    clearAll,
    buildExportObject,
    importJson,
    importText,
    tryRetrieve,
    renderRecords,
    renderStats,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
