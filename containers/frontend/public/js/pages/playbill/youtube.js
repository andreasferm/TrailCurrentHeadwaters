// Playbill YouTube tab — sign-in lifecycle + per-source settings.
//
// YouTube on Playbill uses BYO Google Cloud credentials (the same
// pattern Kodi's YouTube addon uses). Google's "TV-style YouTube client"
// API tier is reserved for OEM partners; small third parties get the
// public Data API and a verification gate that rejects duplicate front-
// ends. The workaround: each user creates their own Google Cloud
// project and pastes their client_id / client_secret here. No separate
// API key needed — we authenticate Data API calls with the user's OAuth
// access token. See docs/youtube-setup.md (in the Playbill repo) or
// /docs/playbill-youtube-setup.html (served by this PWA) for the
// step-by-step.
//
// Reactive state surface (from the controller's `youtube` feature topic):
//   {
//     configured:  true if clientId + clientSecret are saved
//     signedIn:    true once OAuth tokens are persisted
//     account:     { title, channelId, thumbnail } | null
//     pending:     { user_code, verification_url, expires_at, interval } | null
//   }
//
// UI states (one of):
//   not configured  → form: clientId + clientSecret + Save
//   configured, not signed in → "Sign in" button
//   signing in (pending != null) → big code + URL + countdown + Cancel
//   signed in → "Signed in as <title>" + Sign Out

const FEATURE = 'youtube';

let ctx = null;
let countdownTimer = null;

export const youtubeTab = {
    id: FEATURE,
    label: 'YouTube',
    enabled: true,

    render() {
        return `
            <div class="playbill-youtube">
                <div class="playbill-youtube-state" id="playbill-youtube-state">
                    <p class="playbill-youtube-loading">Loading YouTube status…</p>
                </div>
            </div>
        `;
    },

    init(initCtx) {
        ctx = initCtx;
        // Replay any cached status the shell handed us so the tab paints
        // immediately on mount instead of waiting for a republish.
        const last = ctx && typeof ctx.getLastStatus === 'function'
            ? ctx.getLastStatus(FEATURE) : null;
        this.onStatus(last);
    },

    cleanup() {
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        ctx = null;
    },

    onStatus(payload) {
        const root = document.getElementById('playbill-youtube-state');
        if (!root) return;

        // Reset any running countdown — the new payload decides whether
        // we restart one.
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

        const s = payload || {};
        if (s.pending && s.pending.user_code) return this._renderSigningIn(root, s.pending);
        if (s.signedIn)                       return this._renderSignedIn(root, s.account || {});
        if (s.configured)                     return this._renderReadyToSignIn(root);
        return this._renderNotConfigured(root);
    },

    // ── render branches ─────────────────────────────────────────────────

    _renderNotConfigured(root) {
        root.innerHTML = `
            <div class="playbill-youtube-card">
                <h2 class="playbill-youtube-title">Connect your Google account</h2>
                <p class="playbill-youtube-blurb">
                    YouTube on Playbill uses credentials from your own Google Cloud project
                    — a one-time, 10-minute Google Cloud Console procedure.
                </p>
                <p class="playbill-youtube-blurb">
                    <a href="/docs/playbill-youtube-setup.html" target="_blank" rel="noopener"
                       class="playbill-youtube-doc-link">
                        Open the step-by-step setup guide →
                    </a>
                </p>
                <form id="playbill-youtube-creds-form" class="playbill-youtube-form">
                    <label class="playbill-youtube-field">
                        <span>Client ID</span>
                        <input class="form-input" name="clientId" type="text" autocomplete="off"
                               spellcheck="false" required
                               placeholder="…apps.googleusercontent.com">
                    </label>
                    <label class="playbill-youtube-field">
                        <span>Client secret</span>
                        <input class="form-input" name="clientSecret" type="password" autocomplete="off"
                               spellcheck="false" required
                               placeholder="GOCSPX-…">
                    </label>
                    <div class="playbill-youtube-actions">
                        <button type="submit" class="playbill-btn playbill-btn-primary"
                                id="playbill-youtube-save">Save</button>
                    </div>
                    <p class="playbill-youtube-error" id="playbill-youtube-error" hidden></p>
                </form>
            </div>
        `;
        const form = document.getElementById('playbill-youtube-creds-form');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this._submitCreds(form);
        });
    },

    _renderReadyToSignIn(root) {
        root.innerHTML = `
            <div class="playbill-youtube-card">
                <h2 class="playbill-youtube-title">Sign in to YouTube</h2>
                <p class="playbill-youtube-blurb">
                    Credentials saved. Tap Sign in below — Playbill will show a 6-digit
                    code. On any phone / laptop, open
                    <a href="https://youtube.com/activate" target="_blank" rel="noopener">youtube.com/activate</a>
                    and enter the code.
                </p>
                <div class="playbill-youtube-actions">
                    <button class="playbill-btn playbill-btn-primary" id="playbill-youtube-signin">Sign in</button>
                    <button class="playbill-btn playbill-btn-secondary" id="playbill-youtube-reset">Edit credentials</button>
                </div>
                <p class="playbill-youtube-error" id="playbill-youtube-error" hidden></p>
            </div>
        `;
        document.getElementById('playbill-youtube-signin')
            .addEventListener('click', () => this._signInStart());
        document.getElementById('playbill-youtube-reset')
            .addEventListener('click', () => this._renderNotConfigured(root));
    },

    _renderSigningIn(root, pending) {
        const expiresAt = Number(pending.expires_at) || (Date.now() + 1000 * 60 * 15);
        root.innerHTML = `
            <div class="playbill-youtube-card playbill-youtube-card-active">
                <h2 class="playbill-youtube-title">Enter this code at youtube.com/activate</h2>
                <p class="playbill-youtube-code" id="playbill-youtube-code">${escapeHtml(pending.user_code)}</p>
                <p class="playbill-youtube-blurb">
                    On your phone or laptop, open
                    <a href="${escapeAttr(pending.verification_url || 'https://youtube.com/activate')}"
                       target="_blank" rel="noopener">${escapeHtml(pending.verification_url || 'youtube.com/activate')}</a>
                    and enter the code above. Sign in with the Google account you added
                    as a Test User in your Cloud Console.
                </p>
                <p class="playbill-youtube-countdown" id="playbill-youtube-countdown"></p>
                <div class="playbill-youtube-actions">
                    <button class="playbill-btn playbill-btn-secondary" id="playbill-youtube-cancel">Cancel</button>
                </div>
                <p class="playbill-youtube-error" id="playbill-youtube-error" hidden></p>
            </div>
        `;
        document.getElementById('playbill-youtube-cancel')
            .addEventListener('click', () => this._signInCancel());

        // Live countdown so the user knows how long they have to enter the code.
        const tick = () => {
            const el = document.getElementById('playbill-youtube-countdown');
            if (!el) return;
            const ms = expiresAt - Date.now();
            if (ms <= 0) {
                el.textContent = 'Code expired — tap Cancel and try again.';
                if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
                return;
            }
            const m = Math.floor(ms / 60_000);
            const s = Math.floor((ms % 60_000) / 1000);
            el.textContent = `Expires in ${m}:${String(s).padStart(2, '0')}`;
        };
        tick();
        countdownTimer = setInterval(tick, 1000);
    },

    _renderSignedIn(root, account) {
        const title = account.title || 'YouTube';
        const thumb = account.thumbnail || '';
        root.innerHTML = `
            <div class="playbill-youtube-card">
                <h2 class="playbill-youtube-title">Signed in</h2>
                <div class="playbill-youtube-account">
                    ${thumb ? `<img class="playbill-youtube-avatar" src="${escapeAttr(thumb)}" alt="">` : ''}
                    <span class="playbill-youtube-account-name">${escapeHtml(title)}</span>
                </div>
                <p class="playbill-youtube-blurb">
                    YouTube is ready. Your subscriptions and watch history are available
                    under <strong>Sources → YouTube</strong> on the Playbill itself.
                </p>
                <p class="playbill-youtube-blurb playbill-youtube-blurb-muted">
                    Google requires re-consent every 7 days while your OAuth project is in
                    Testing mode. If you see "session expired," tap Sign in again.
                    <a href="/docs/playbill-youtube-setup.html" target="_blank" rel="noopener">Setup guide</a>
                </p>
                <div class="playbill-youtube-actions">
                    <button class="playbill-btn playbill-btn-secondary" id="playbill-youtube-signout">Sign out</button>
                </div>
                <p class="playbill-youtube-error" id="playbill-youtube-error" hidden></p>
            </div>
        `;
        document.getElementById('playbill-youtube-signout')
            .addEventListener('click', () => this._signOut());
    },

    // ── command dispatch ────────────────────────────────────────────────

    async _submitCreds(form) {
        if (!ctx) return;
        const data = new FormData(form);
        const value = {
            clientId:     String(data.get('clientId')     || '').trim(),
            clientSecret: String(data.get('clientSecret') || '').trim(),
        };
        // Sanity-check shape locally before round-tripping to the controller.
        if (!value.clientId.endsWith('.apps.googleusercontent.com')) {
            return this._showError('Client ID should end with .apps.googleusercontent.com — double-check you copied the whole value.');
        }
        this._setBusy('playbill-youtube-save', 'Saving…');
        try {
            await ctx.sendCommand(FEATURE, { action: 'youtube.setSettings', value });
            // The controller will publish a new `youtube` feature status
            // with `configured: true`; the WS event will re-render us.
        } catch (e) {
            this._showError(`Save failed: ${e.message || e}`);
            this._setBusy('playbill-youtube-save', 'Save', false);
        }
    },

    async _signInStart() {
        if (!ctx) return;
        this._setBusy('playbill-youtube-signin', 'Starting…');
        try {
            await ctx.sendCommand(FEATURE, { action: 'youtube.signInStart' });
            // Next youtube status carrying `pending` flips us to the
            // signing-in render branch.
        } catch (e) {
            this._showError(`Sign-in failed: ${e.message || e}`);
            this._setBusy('playbill-youtube-signin', 'Sign in', false);
        }
    },

    async _signInCancel() {
        if (!ctx) return;
        this._setBusy('playbill-youtube-cancel', 'Cancelling…');
        try {
            await ctx.sendCommand(FEATURE, { action: 'youtube.signInCancel' });
        } catch (e) {
            this._showError(`Cancel failed: ${e.message || e}`);
            this._setBusy('playbill-youtube-cancel', 'Cancel', false);
        }
    },

    async _signOut() {
        if (!ctx) return;
        this._setBusy('playbill-youtube-signout', 'Signing out…');
        try {
            await ctx.sendCommand(FEATURE, { action: 'youtube.signOut' });
        } catch (e) {
            this._showError(`Sign-out failed: ${e.message || e}`);
            this._setBusy('playbill-youtube-signout', 'Sign out', false);
        }
    },

    // ── tiny helpers ────────────────────────────────────────────────────

    _showError(msg) {
        const el = document.getElementById('playbill-youtube-error');
        if (!el) return;
        el.textContent = msg;
        el.hidden = false;
    },
    _setBusy(btnId, label, busy = true) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        btn.disabled = busy;
        btn.textContent = label;
    },
};

// ── escape helpers ─────────────────────────────────────────────────────

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
