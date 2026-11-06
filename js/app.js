// ==========================================================================
// NETRON — app logic (Guerrilla Mail client)
// ==========================================================================
'use strict';

// ==================== CONFIG ====================
const GM_API = 'https://api.guerrillamail.com/ajax.php';
const LIFETIME = 60 * 60;            // 60 minutes, seconds
const REFRESH_MS = 10000;            // inbox poll interval
const KEEPALIVE_MS = 4 * 60 * 1000;  // session keep-alive ping
const QR_API = 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&qzone=2&data=';

// ==================== STATE ====================
let sid = null;              // guerrilla sid_token
let address = null;          // current email address
let createdAt = 0;           // ms timestamp
let timeRemaining = LIFETIME;
let messages = [];           // mapped message objects
let readIds = new Set();     // locally-marked-read mail ids
let knownIds = new Set();    // ids seen in previous poll
let favorites = new Set();   // mail ids
let favMeta = {};            // id -> {from, subject, excerpt} snapshot for favorites
let selected = new Set();
let currentTab = 'inbox';
let currentMessageId = null;
let autoRefresh = localStorage.getItem('netron_autorefresh') !== 'off';
let soundOn = localStorage.getItem('netron_sound') !== 'off';
let searchQuery = '';
let busy = false;

let refreshTimer = null;
let countdownTimer = null;
let keepAliveTimer = null;
let userInteracted = false;

const LS_SESSION = 'netron_session_v2';

// stats
let stats = {
    emails: parseInt(localStorage.getItem('netron_stats_emails') || '0', 10),
    messages: parseInt(localStorage.getItem('netron_stats_messages') || '0', 10)
};

// ==================== DOM SHORTCUTS ====================
const $ = (id) => document.getElementById(id);

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => {
    restoreSession();
    bindControls();
    updateOnlineBanner();
    window.addEventListener('online', updateOnlineBanner);
    window.addEventListener('offline', () => showBanner('No internet connection.', true));
    document.addEventListener('pointerdown', () => { userInteracted = true; }, { once: true });
});

function bindControls() {
    $('generateBtn').addEventListener('click', () => createEmail());
    $('copyBtn').addEventListener('click', copyEmail);
    $('qrBtn').addEventListener('click', toggleQr);
    $('refreshBtn').addEventListener('click', refreshInbox);
    $('selectAllBtn').addEventListener('click', toggleSelectAll);

    const searchInput = $('inboxSearch');
    searchInput.addEventListener('input', (e) => {
        searchQuery = String(e.target.value || '');
        selected.clear();
        render();
        renderBatchBar();
    });

    const autoToggle = $('autoToggle');
    autoToggle.setAttribute('aria-pressed', String(autoRefresh));
    autoToggle.addEventListener('click', () => {
        autoRefresh = !autoRefresh;
        localStorage.setItem('netron_autorefresh', autoRefresh ? 'on' : 'off');
        autoToggle.setAttribute('aria-pressed', String(autoRefresh));
        if (autoRefresh) startPolling(); else stopPolling();
        toast(autoRefresh ? 'Auto-refresh enabled' : 'Auto-refresh paused');
    });

    const soundToggle = $('soundToggle');
    const paintSound = () => soundToggle.classList.toggle('active', soundOn);
    paintSound();
    soundToggle.addEventListener('click', () => {
        soundOn = !soundOn;
        localStorage.setItem('netron_sound', soundOn ? 'on' : 'off');
        paintSound();
        toast(soundOn ? 'Sound notifications on' : 'Sound notifications off');
    });

    // customize block
    $('customizeToggle').addEventListener('click', () => $('customize').classList.toggle('open'));
    $('customName').addEventListener('input', (e) => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''); });
    $('customName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createEmail(); });

    // tabs
    $('tabInbox').addEventListener('click', () => switchTab('inbox'));
    $('tabFav').addEventListener('click', () => switchTab('fav'));

    // batch
    $('batchFavBtn').addEventListener('click', batchFavorite);
    $('batchDelBtn').addEventListener('click', batchDelete);

    // modal
    document.querySelectorAll('.modal').forEach((m) => {
        m.addEventListener('click', (e) => { if (e.target === m) closeMessage(); });
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMessage(); });
    $('modalClose').addEventListener('click', closeMessage);
    $('modalFav').addEventListener('click', () => toggleFavorite(currentMessageId));
    $('modalDelete').addEventListener('click', deleteCurrentMessage);

    $('bannerRetry').addEventListener('click', () => { hideBanner(); refreshInbox(); });
    $('bannerDismiss').addEventListener('click', hideBanner);

    window.addEventListener('beforeunload', saveSession);
}

// ==================== GUERRILLA CLIENT ====================
async function gm(params) {
    if (!navigator.onLine) throw { kind: 'offline', message: 'You are offline' };
    const q = new URLSearchParams(params);
    if (sid) q.set('sid_token', sid);
    let res;
    try {
        res = await fetch(`${GM_API}?${q.toString()}`);
    } catch {
        throw { kind: 'network', message: 'Network error — could not reach the mail API' };
    }
    if (res.status === 429) throw { kind: 'rate', message: 'Too many requests — try again in a minute' };
    if (!res.ok) throw { kind: 'api', message: `Mail service error (HTTP ${res.status})` };
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        throw { kind: 'api', message: 'Mail service returned an invalid response' };
    }
}

// ==================== EMAIL LIFECYCLE ====================
async function createEmail(customName) {
    if (busy) return;
    const btn = $('generateBtn');
    busy = true;
    btn.disabled = true;
    setStatus('Creating secure mailbox…', 'loading');

    try {
        // fresh session
        sid = null;
        const sess = await gm({ f: 'get_email_address', lang: 'en' });
        sid = sess.sid_token;

        address = String(sess.email_addr || '');

        // apply custom username if requested & valid
        customName = (customName || '').trim();
        if (customName) {
            if (!/^[a-z0-9][a-z0-9._-]{2,28}$/.test(customName)) {
                throw { message: 'Name must be 3–29 chars: letters, digits, dots, dashes' };
            }
            const base = address.split('@')[0];
            if (customName !== base) {
                const custom = await gm({ f: 'set_email_user', email_user: customName, lang: 'en' });
                if (custom && custom.email_addr) address = String(custom.email_addr);
            }
        }

        createdAt = Date.now();
        timeRemaining = LIFETIME;
        messages = [];
        knownIds = new Set();
        readIds = new Set();
        favorites = new Set();
        favMeta = {};
        selected.clear();
        searchQuery = '';
        $('inboxSearch').value = '';

        saveSession();
        stats.emails++;
        localStorage.setItem('netron_stats_emails', String(stats.emails));

        showMailbox();
        setStatus('Mailbox ready — waiting for incoming mail', 'success');
        startCountdown();
        startKeepAlive();
        startPolling();
        refreshInbox();
        updateStats();
    } catch (err) {
        setStatus(err.message || 'Could not create mailbox — try again', 'error');
    } finally {
        busy = false;
        btn.disabled = false;
    }
}

function saveSession() {
    if (!sid || !address) return;
    const elapsed = Math.floor((Date.now() - createdAt) / 1000);
    const remaining = timeRemaining - 0 || LIFETIME - elapsed;
    try {
        localStorage.setItem(LS_SESSION, JSON.stringify({
            sid,
            address,
            createdAt,
            remaining: Math.max(remaining, 1),
            favIds: [...favorites],
            favMeta
        }));
    } catch { /* storage full / private mode */ }
}

function restoreSession() {
    let s;
    try {
        s = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
    } catch {
        localStorage.removeItem(LS_SESSION);
        return;
    }
    if (!s || !s.sid || !s.address) return;

    const elapsed = Math.floor((Date.now() - (s.createdAt || 0)) / 1000);
    const remaining = (s.remaining || LIFETIME) - elapsed;
    if (remaining <= 0) {
        localStorage.removeItem(LS_SESSION);
        return;
    }

    sid = s.sid;
    address = s.address;
    createdAt = s.createdAt;
    timeRemaining = remaining;
    favorites = new Set(s.favIds || []);
    favMeta = s.favMeta || {};

    // validate in background: poll once — if sid is dead, clear
    validateRestored();
}

async function validateRestored() {
    try {
        const data = await gm({ f: 'check_email', seq: 0 });
        applyMessageList(data, true);
        showMailbox();
        startCountdown();
        startKeepAlive();
        startPolling();
        toast('Session restored');
    } catch {
        // session expired server-side
        sid = null; address = null;
        localStorage.removeItem(LS_SESSION);
        setStatus('Previous mailbox expired — generate a new one', 'error');
    }
}

function expireMailbox() {
    stopPolling();
    stopCountdown();
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    localStorage.removeItem(LS_SESSION);
    sid = null;
    address = null;
    messages = [];
    favorites = new Set();
    favMeta = {};
    updateTitleCount();

    const box = $('emailBox');
    box.classList.remove('active');
    box.innerHTML = '<span class="status-dot"></span>Mailbox expired — generate a new one';
    $('timerRow').classList.remove('active');
    $('inbox').classList.remove('active');
    $('copyBtn').disabled = true;
    $('qrBtn').disabled = true;
    closeQr();
    toast('Mailbox expired', true);
}

// ==================== TIMERS ====================
const RING_C = 2 * Math.PI * 32; // r=32

function startCountdown() {
    stopCountdown();
    $('timerRow').classList.add('active');
    paintTimer();
    countdownTimer = setInterval(() => {
        timeRemaining--;
        paintTimer();
        if (timeRemaining % 15 === 0) saveSession();
        if (timeRemaining <= 0) expireMailbox();
    }, 1000);
}

function stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function paintTimer() {
    const t = $('timerText');
    const bar = $('timerBar');
    const m = String(Math.floor(timeRemaining / 60)).padStart(2, '0');
    const s = String(timeRemaining % 60).padStart(2, '0');
    t.textContent = `${m}:${s}`;

    const frac = Math.max(timeRemaining / LIFETIME, 0);
    bar.style.strokeDashoffset = String(RING_C * (1 - frac));

    const level = timeRemaining <= 300 ? 'danger' : timeRemaining <= 600 ? 'warning' : '';
    bar.classList.toggle('warning', level === 'warning');
    bar.classList.toggle('danger', level === 'danger');
    t.classList.toggle('warning', level === 'warning');
    t.classList.toggle('danger', level === 'danger');
    $('timerExpires').textContent = fmtAbsExpire();
}

function fmtAbsExpire() {
    const d = new Date(createdAt + (createdAt ? LIFETIME * 1000 - (Date.now() - createdAt) : timeRemaining * 1000));
    return `expires at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function startKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(async () => {
        if (!sid) return;
        try { await gm({ f: 'keep_alive' }); } catch { /* silent */ }
    }, KEEPALIVE_MS);
}

// ==================== INBOX ====================
function startPolling() {
    stopPolling();
    if (!sid || !autoRefresh) return;
    refreshTimer = setInterval(refreshInbox, REFRESH_MS);
}

function stopPolling() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

async function refreshInbox() {
    if (!sid || !address) return;
    const btn = $('refreshBtn');
    btn.classList.add('spinning');
    try {
        const data = await gm({ f: 'check_email', seq: 0 });
        applyMessageList(data, false);
        $('lastCheck').textContent = `checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } catch (err) {
        console.warn('Inbox refresh failed:', err);
        if (err.kind === 'offline') showBanner('No internet connection.', true);
        else if (err.kind === 'api' && !navigator.onLine) showBanner('No internet connection.', true);
        else if (err.kind) {
            // provider problem — keep old messages, hint quietly
            $('lastCheck').textContent = err.message;
        }
    } finally {
        btn.classList.remove('spinning');
    }
}

function applyMessageList(data, silent) {
    const list = Array.isArray(data && data.list) ? data.list : [];
    const mapped = list.map((m) => ({
        id: String(m.mail_id),
        from: String(m.mail_from || '').trim(),
        subject: String(m.mail_subject || '').trim() || '(no subject)',
        excerpt: String(m.mail_excerpt || '').replace(/\s+/g, ' ').trim(),
        ts: parseInt(m.mail_timestamp, 10) || 0,
        dateStr: String(m.mail_date || '')
    }));

    const prevCount = knownIds.size;
    const fresh = mapped.filter((m) => !knownIds.has(m.id) && !isWelcome(m));
    knownIds = new Set(mapped.map((m) => m.id));
    messages = mapped;

    // new-mail detection (skip the guerrilla welcome mail & first load)
    if (!silent && prevCount > 0) {
        const reallyNew = fresh.filter((m) => m.subject !== 'Welcome to Guerrilla Mail');
        if (reallyNew.length > 0) {
            stats.messages += reallyNew.length;
            localStorage.setItem('netron_stats_messages', String(stats.messages));
            updateStats();
            toast(`${reallyNew.length} new message${reallyNew.length > 1 ? 's' : ''} — check your inbox`);
            beep();
            // extend lifetime on activity (mailbox is rolling)
            timeRemaining = Math.min(timeRemaining + 10 * 60, LIFETIME);
        }
    }

    render();
    renderBatchBar();
    updateTitleCount();
    const unread = messages.filter((m) => !readIds.has(m.id) && !isWelcome(m)).length;
    const tab = $('tabInbox');
    tab.classList.toggle('unread-marker', unread > 0);
    tab.querySelector('.tab-badge').textContent = unread || '';
}

function isWelcome(m) {
    return m.from === 'no-reply@guerrillamail.com' || m.subject === 'Welcome to Guerrilla Mail';
}

// ==================== RENDER ====================
function displayList() {
    let base = messages;
    if (currentTab === 'fav') {
        base = messages.filter((m) => favorites.has(m.id));
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((m) =>
        m.from.toLowerCase().includes(q) ||
        m.subject.toLowerCase().includes(q) ||
        m.excerpt.toLowerCase().includes(q)
    );
}

function render() {
    renderList();
    const favCount = messages.filter((m) => favorites.has(m.id)).length;
    $('tabFav').querySelector('.tab-badge').textContent = favCount || '';
}

function renderList() {
    const listEl = $('msgList');
    const items = displayList();
    $('stripCount').textContent = `${items.length} message${items.length !== 1 ? 's' : ''}`;

    if (items.length === 0) {
        const isInbox = currentTab === 'inbox';
        const searched = searchQuery.trim().length > 0;
        listEl.innerHTML = `
            <div class="empty">
                <div class="empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        ${searched
                            ? '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>'
                            : isInbox
                                ? '<path d="M22 12h-6l-2 3h-4l-2-3H2"></path><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>'
                                : '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>'
                        }
                    </svg>
                </div>
                <h4 class="empty-title">${searched ? 'Nothing found' : isInbox ? 'No messages yet' : 'No favorites yet'}</h4>
                <p class="empty-desc">${searched
                    ? 'Try a different search query'
                    : isInbox
                        ? 'Incoming mail appears here automatically every 10 seconds'
                        : 'Star a message to keep it here'}</p>
            </div>`;
        return;
    }

    listEl.innerHTML = items.map((m) => {
        const isFav = favorites.has(m.id);
        const isSel = selected.has(m.id);
        const isRead = readIds.has(m.id);
        return `
        <div class="msg ${!isRead && !isWelcome(m) ? 'unread' : ''} ${isSel ? 'selected' : ''}" data-id="${m.id}">
            <div class="msg-check">
                <div class="checkbox ${isSel ? 'checked' : ''}" data-act="select">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                </div>
            </div>
            <div class="msg-body" data-act="open">
                <div class="msg-top">
                    <span class="msg-from">${esc(m.from)}</span>
                    <span class="msg-time">${fmtTime(m)}</span>
                </div>
                <div class="msg-subject">${esc(m.subject)}</div>
                <div class="msg-preview">${esc(m.excerpt)}</div>
            </div>
            <div class="msg-side">
                <button class="icon-btn msg-fav ${isFav ? 'active' : ''}" data-act="fav" title="${isFav ? 'Remove from' : 'Add to'} favorites">
                    <svg viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                </button>
                <button class="icon-btn msg-del" data-act="del" title="Delete">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        </div>`;
    }).join('');
}

// delegated events for the list
document.addEventListener('click', (e) => {
    const item = e.target.closest('.msg');
    if (!item) return;
    const id = item.dataset.id;
    const actEl = e.target.closest('[data-act]');
    const act = actEl ? actEl.dataset.act : 'open';

    if (act === 'select') { toggleSelect(id); return; }
    if (act === 'fav') { toggleFavorite(id); return; }
    if (act === 'del') { deleteMessages([id]); return; }
    openMessage(id);
});

function switchTab(tab) {
    currentTab = tab;
    selected.clear();
    renderBatchBar();
    $('tabInbox').classList.toggle('active', tab === 'inbox');
    $('tabFav').classList.toggle('active', tab === 'fav');
    render();
}

// ==================== MESSAGE MODAL ====================
async function openMessage(id) {
    const msg = messages.find((m) => m.id === id);
    if (!msg) return;
    currentMessageId = id;

    $('modalTitle').textContent = msg.subject;
    $('modalFrom').textContent = msg.from;
    $('modalTo').textContent = address || '';
    $('modalDate').textContent = fmtFullDate(msg);
    $('modalContent').innerHTML = '<div class="status-line" style="margin:0"><div class="spinner"></div><span>Loading…</span></div>';
    $('modalFav').classList.toggle('active', favorites.has(id));
    openModal();

    try {
        const data = await gm({ f: 'fetch_email', email_id: id });
        readIds.add(id);
        const html = renderEmailBody(data);
        $('modalContent').innerHTML = `<div class="email-html">${html}</div>`;
        render();
        saveSession();
    } catch (err) {
        $('modalContent').innerHTML = `<div class="empty"><h4 class="empty-title">Could not load message</h4><p class="empty-desc">${esc(err.message || 'Unknown error')}</p></div>`;
    }
}

function renderEmailBody(data) {
    const isHtml = String(data.is_html || '') === '1';
    const body = String(data.mail_body || '');

    if (isHtml && body.trim()) {
        return sanitizeEmailHtml(body);
    }
    // plain text (or html fallback): strip tags then show as <pre>
    const text = isHtml
        ? body.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s{2,}/g, ' ').trim()
        : body;
    return `<pre>${esc(text || 'Empty message')}</pre>`;
}

function closeMessage() {
    $('messageModal').classList.remove('active');
    document.body.style.overflow = '';
    currentMessageId = null;
}

function openModal() {
    $('messageModal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

async function deleteCurrentMessage() {
    if (!currentMessageId) return;
    const id = currentMessageId;
    closeMessage();
    await deleteMessages([id]);
}

// ==================== ACTIONS ====================
function toggleSelect(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    renderList();
    renderBatchBar();
}

function toggleSelectAll() {
    const items = displayList();
    const all = items.length > 0 && items.every((m) => selected.has(m.id));
    selected = all ? new Set() : new Set(items.map((m) => m.id));
    renderList();
    renderBatchBar();
}

function renderBatchBar() {
    const bar = $('batchBar');
    bar.classList.toggle('active', selected.size > 0);
    $('selectedCount').textContent = String(selected.size);
}

async function batchFavorite() {
    selected.forEach((id) => favorites.add(id));
    persistFavorites();
    selected.clear();
    render();
    renderBatchBar();
    toast('Added to favorites');
}

async function batchDelete() {
    const ids = [...selected];
    selected.clear();
    await deleteMessages(ids);
}

function toggleFavorite(id) {
    if (favorites.has(id)) {
        favorites.delete(id);
        toast('Removed from favorites');
    } else {
        favorites.add(id);
        const m = messages.find((x) => x.id === id);
        if (m) favMeta[id] = { from: m.from, subject: m.subject, excerpt: m.excerpt };
        toast('Added to favorites');
    }
    persistFavorites();
    if (currentMessageId) $('modalFav').classList.toggle('active', favorites.has(currentMessageId));
    render();
}

function persistFavorites() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_SESSION) || '{}');
        s.favIds = [...favorites];
        s.favMeta = favMeta;
        localStorage.setItem(LS_SESSION, JSON.stringify(s));
    } catch { /* ignore */ }
}

async function deleteMessages(ids) {
    for (const id of ids) {
        try { await gm({ f: 'del_email', email_ids: id }); } catch { /* keep going */ }
        messages = messages.filter((m) => m.id !== id);
        knownIds.delete(id);
        favorites.delete(id);
        selected.delete(id);
    }
    persistFavorites();
    render();
    renderBatchBar();
    updateTitleCount();
    if (ids.length > 0) toast(ids.length > 1 ? `${ids.length} messages deleted` : 'Message deleted');
}

// ==================== COPY / QR ====================
function currentEmail() {
    return (address || '').trim();
}

async function copyEmail() {
    const email = currentEmail();
    if (!email) return;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(email);
        } else {
            fallbackCopy(email);
        }
        toast('Address copied to clipboard');
    } catch {
        fallbackCopy(email);
        toast('Address copied to clipboard');
    }
}

function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    document.body.removeChild(ta);
}

function toggleQr() {
    const pop = $('qrPop');
    if (pop.classList.contains('open')) { pop.classList.remove('open'); return; }
    const email = currentEmail();
    if (!email) return;
    $('qrImg').src = QR_API + encodeURIComponent(email);
    $('qrAddr').textContent = email;
    pop.classList.add('open');
}

function closeQr() {
    $('qrPop').classList.remove('open');
}

// ==================== UI PLUMBING ====================
function showMailbox() {
    const box = $('emailBox');
    box.classList.add('active');
    box.innerHTML = `<span class="status-dot"></span>${esc(address)}`;
    $('copyBtn').disabled = false;
    $('qrBtn').disabled = false;
    $('inbox').classList.add('active');
}

function setStatus(text, kind) {
    const el = $('statusLine');
    el.className = `status-line ${kind || ''}`;
    el.innerHTML = kind === 'loading'
        ? '<div class="spinner"></div>'
        : kind === 'success'
            ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>'
            : kind === 'error'
                ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>'
                : '';
    el.appendChild(document.createTextNode(text));
    if (kind !== 'loading') {
        clearTimeout(setStatus._t);
        setStatus._t = setTimeout(() => { el.className = 'status-line'; el.innerHTML = ''; }, 6000);
    }
}

let toastTimer = null;
function toast(text, isError) {
    const el = $('toast');
    $('toastText').textContent = text;
    el.classList.toggle('error', Boolean(isError));
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function showBanner(text, withRetry) {
    $('bannerText').textContent = text;
    $('bannerRetry').style.display = withRetry ? '' : 'none';
    $('banner').classList.add('show');
}

function hideBanner() {
    $('banner').classList.remove('show');
}

function updateOnlineBanner() {
    if (navigator.onLine) {
        if ($('bannerText').textContent === 'No internet connection.') hideBanner();
    }
}

function updateStats() {
    const el = $('statEmails');
    if (el) el.textContent = String(stats.emails);
    const el2 = $('statMessages');
    if (el2) el2.textContent = String(stats.messages);
}

function updateTitleCount() {
    const unread = messages.filter((m) => !readIds.has(m.id) && !isWelcome(m)).length;
    document.title = unread > 0 ? `NETRON — ${unread} new` : 'NETRON — Temp Mail';
}

// ==================== TIME HELPERS ====================
function fmtTime(m) {
    let d = null;
    if (m.ts > 0) d = new Date(m.ts * 1000);
    else if (m.dateStr) {
        const today = new Date();
        const parts = m.dateStr.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (parts) {
            d = new Date(today.getFullYear(), today.getMonth(), today.getDate(), +parts[1], +parts[2], parts[3] ? +parts[3] : 0);
        }
    }
    if (!d) return '';
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtFullDate(m) {
    if (m.ts > 0) return new Date(m.ts * 1000).toLocaleString();
    if (m.dateStr) return m.dateStr;
    return '';
}

// ==================== SOUND ====================
function beep() {
    if (!soundOn || !userInteracted) return;
    try {
        const ctx = beep._ctx || (beep._ctx = new (window.AudioContext || window.webkitAudioContext)());
        if (ctx.state === 'suspended') ctx.resume();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine';
        o.frequency.setValueAtTime(880, ctx.currentTime);
        o.frequency.setValueAtTime(1174, ctx.currentTime + 0.09);
        g.gain.setValueAtTime(0.06, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
        o.start(ctx.currentTime);
        o.stop(ctx.currentTime + 0.3);
    } catch { /* audio unavailable */ }
}

// ==================== HTML SANITIZER ====================
function esc(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function sanitizeEmailHtml(rawHtml) {
    const doc = new DOMParser().parseFromString(String(rawHtml || ''), 'text/html');

    doc.querySelectorAll('script,iframe,object,embed,link,meta,base,form,input,button,textarea,select,option,video,audio,source,track,frame,frameset,applet,noscript').forEach((el) => el.remove());

    const isBadUrl = (u) => {
        const s = String(u || '').trim().toLowerCase().replace(/\s/g, '');
        return s.startsWith('javascript:') || s.startsWith('data:text/html') || s.startsWith('vbscript:');
    };

    doc.body.querySelectorAll('*').forEach((el) => {
        [...el.attributes].forEach((attr) => {
            const name = attr.name.toLowerCase();
            const value = attr.value;

            if (name.startsWith('on')) el.removeAttribute(attr.name);
            if (name === 'srcdoc' || name === 'formaction') el.removeAttribute(attr.name);

            if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'background') && isBadUrl(value)) {
                el.removeAttribute(attr.name);
            }

            if (name === 'style' && /(expression\s*\(|@import|behavior\s*:|javascript:)/i.test(value)) {
                el.removeAttribute('style');
            }
        });

        if (el.tagName === 'A') {
            let href = el.getAttribute('href') || '';
            if (href && !/^[a-zA-Z0-9.+-]+:/i.test(href) && !href.startsWith('#')) {
                if (href.startsWith('//')) href = 'https:' + href;
                else if (!href.startsWith('mailto:') && !href.startsWith('tel:')) href = 'https://' + href.replace(/^\/+/, '');
            }
            el.setAttribute('href', href);
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer nofollow');
        }

        if (el.tagName === 'IMG') {
            el.setAttribute('loading', 'lazy');
            el.setAttribute('decoding', 'async');
            el.setAttribute('referrerpolicy', 'no-referrer');
            if (!el.getAttribute('src')) el.remove();
        }
    });

    return doc.body.innerHTML;
}
