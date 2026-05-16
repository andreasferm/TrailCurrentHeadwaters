// Playbill Remote tab — generic D-pad for navigating whatever's on the
// Playbill's screen. Used for every video app (YouTube, Plex, Netflix,
// Local Library, Live TV) instead of building a custom UI per service.
// The Playbill controller dispatches `nav.dpad` to whichever in-rig source
// is currently driving the display — same way an Apple TV / Roku remote
// works regardless of which app is open on the TV.
//
// Layout parrots the physical IR remote so muscle memory transfers:
//
//             ┌────┐
//             │ ▲  │
//        ┌────┼────┼────┐
//        │ ◀  │ OK │ ▶  │
//        └────┼────┼────┘
//             │ ▼  │
//             └────┘
//
//        [☰]   [⌂]   [↩]                  ← Menu / Home / Back (icon-only)
//
//        [text input ………………] [⌫] [↵] [✕]  ← nav.text streaming
//
// Play/Pause and Prev/Next are intentionally absent — the Playbill GUI
// already binds those to the arrow keys during media playback, so the
// d-pad covers them. Power lives at the page level (top-left of the
// Playbill page) because launching the GUI isn't tab-specific.
//
// Each press sends one command — the controller maps it to keystrokes the
// active source's process (mpv, the Electron renderer, etc.) understands.
// The text input streams characters as the user types; the Playbill
// controller deserializes them with '\b' = Backspace, '\n' = Enter,
// everything else typed into the focused field.
//
// Volume is intentionally NOT on the Remote tab — it lives in the
// persistent header widget so it's reachable from every tab as a single
// master control for the whole Playbill.

const FEATURE_NAV = 'nav';

// Coalesce input events into one MQTT publish per typing burst. 40 ms is
// short enough to feel real-time on the TV, long enough to batch the
// 3-5 input events that fire when a soft keyboard inserts a word.
const TEXT_COALESCE_MS = 40;

// Cap one publish at the controller-side schema limit. We never expect to
// hit this with diff streaming (each diff is tiny), but a single paste of
// a huge string could; clamp defensively and submit the remainder on the
// next input event.
const NAV_TEXT_MAX = 1024;

let ctx = null;
let keyboardListener = null;
// Text-streaming state — module-scoped because the tab is a singleton and
// the diff calculation has to survive re-renders of the surrounding page.
// Reset on init().
let lastSentValue = '';
let coalesceTimer = null;
let inFlightCount = 0;       // active nav.text publishes; drives the streaming dot
let composing = false;       // true between compositionstart / compositionend (IME)

export const remoteTab = {
    id: 'nav',
    label: 'Remote',
    enabled: true,

    render() {
        return `
            <div class="playbill-remote">
                <div class="playbill-dpad" role="group" aria-label="Direction pad">
                    <button class="playbill-dpad-btn playbill-dpad-up"     data-key="up"     aria-label="Up">
                        ${iconArrow()}
                    </button>
                    <button class="playbill-dpad-btn playbill-dpad-left"   data-key="left"   aria-label="Left">
                        ${iconArrow()}
                    </button>
                    <button class="playbill-dpad-btn playbill-dpad-select" data-key="select" aria-label="Select / OK">
                        OK
                    </button>
                    <button class="playbill-dpad-btn playbill-dpad-right"  data-key="right"  aria-label="Right">
                        ${iconArrow()}
                    </button>
                    <button class="playbill-dpad-btn playbill-dpad-down"   data-key="down"   aria-label="Down">
                        ${iconArrow()}
                    </button>
                </div>

                <div class="playbill-remote-row playbill-remote-nav">
                    <button class="playbill-remote-btn playbill-remote-icon" data-key="menu" aria-label="Menu" title="Menu">
                        ${iconMenu()}
                    </button>
                    <button class="playbill-remote-btn playbill-remote-icon" data-key="home" aria-label="Home" title="Home">
                        ${iconHome()}
                    </button>
                    <button class="playbill-remote-btn playbill-remote-icon" data-key="back" aria-label="Back" title="Back (Esc)">
                        ${iconBack()}
                    </button>
                </div>

                <div class="playbill-text-section">
                    <p class="playbill-text-hint">
                        Focus a field on the TV first, then type here.
                    </p>
                    <div class="playbill-text-row">
                        <div class="playbill-text-input-wrap">
                            <input class="playbill-text-input" id="playbill-text-input"
                                   type="text" maxlength="1024" autocomplete="off"
                                   autocorrect="off" autocapitalize="off" spellcheck="false"
                                   aria-label="Stream typing to Playbill"
                                   placeholder="Type to send keystrokes…">
                            <span class="playbill-text-stream-dot" id="playbill-text-stream-dot" aria-hidden="true"></span>
                        </div>
                        <button class="playbill-remote-btn playbill-text-btn" data-text-key="backspace"
                                aria-label="Backspace" title="Backspace">
                            ${iconBackspace()}
                        </button>
                        <button class="playbill-remote-btn playbill-text-btn playbill-text-submit"
                                data-text-key="submit" aria-label="Submit" title="Submit (Enter)">
                            ${iconReturn()}
                        </button>
                        <button class="playbill-remote-btn playbill-text-btn playbill-text-clear"
                                data-text-key="clear" aria-label="Clear local field"
                                title="Clear the local field (does not delete on the TV)">
                            ${iconClear()}
                        </button>
                    </div>
                </div>
            </div>
        `;
    },

    init(initCtx) {
        ctx = initCtx;

        const root = document.querySelector('.playbill-remote');
        if (!root) return;

        // Single delegated click handler — matches on the right data-* attr.
        root.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-key], [data-text-key]');
            if (!btn) return;
            if (btn.dataset.key)     return this._pressNav(btn.dataset.key, btn);
            if (btn.dataset.textKey) return this._pressTextKey(btn.dataset.textKey, btn);
        });

        // Text-streaming input — diffs the new value against `lastSentValue`
        // on every input event and sends one nav.text command per typing
        // burst. Composition-aware (CJK / autocomplete suggestions) so we
        // don't send partial characters mid-composition.
        const textInput = document.getElementById('playbill-text-input');
        if (textInput) {
            // Reset module state on mount — the surrounding page can re-render
            // (device switch, etc.) and we don't want a stale lastSentValue
            // poisoning the next diff.
            lastSentValue = '';
            textInput.value = '';

            textInput.addEventListener('compositionstart', () => { composing = true; });
            textInput.addEventListener('compositionend',   () => {
                composing = false;
                this._scheduleTextFlush();
            });
            textInput.addEventListener('input', () => {
                if (composing) return;          // wait for compositionend
                this._scheduleTextFlush();
            });
            // Enter key inside the input — submit + clear local, matches
            // pressing the explicit Submit button so muscle memory works.
            textInput.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                this._submitText();
            });
        }

        // Keyboard shortcuts — only while this tab is mounted. Skip when
        // typing into an input so the device-picker dropdown isn't hijacked.
        keyboardListener = (e) => {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            let key = null;
            switch (e.key) {
                case 'ArrowUp':    key = 'up';     break;
                case 'ArrowDown':  key = 'down';   break;
                case 'ArrowLeft':  key = 'left';   break;
                case 'ArrowRight': key = 'right';  break;
                case 'Enter':      key = 'select'; break;
                case ' ':          key = 'select'; break;
                case 'Escape':     key = 'back';   break;
                case 'Backspace':  key = 'back';   break;
                case 'h': case 'H': key = 'home';  break;
                case 'm': case 'M': key = 'menu';  break;
            }
            if (!key) return;
            e.preventDefault();
            this._pressNav(key, root.querySelector(`[data-key="${key}"]`));
        };
        window.addEventListener('keydown', keyboardListener);
    },

    cleanup() {
        if (keyboardListener) {
            window.removeEventListener('keydown', keyboardListener);
            keyboardListener = null;
        }
        if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
        lastSentValue = '';
        inFlightCount = 0;
        composing = false;
        ctx = null;
    },

    onStatus() { /* no per-feature payload — system status handled at the page level */ },

    // ── internals ────────────────────────────────────────────────────────

    _pressNav(key, btn) {
        flash(btn);
        if (!ctx) return;
        ctx.sendCommand(FEATURE_NAV, { action: 'nav.dpad', key })
            .catch((e) => console.error('[playbill] nav.dpad', key, 'failed:', e));
    },

    // ── text streaming ──────────────────────────────────────────────────

    _pressTextKey(key, btn) {
        flash(btn);
        switch (key) {
            case 'backspace':
                // Same as a literal \b in the typed stream — delete one char
                // on the TV side. Also delete one char locally so the diff
                // stays in sync; otherwise the next input-event diff would
                // re-issue that backspace too.
                this._sendText('\b');
                this._trimLocalTail(1);
                return;
            case 'submit':
                this._submitText();
                return;
            case 'clear':
                // Local-only clear: the TV may have moved focus to a new
                // field (the user navigated via the D-pad). We don't want
                // to spam backspaces against whatever's now focused.
                this._clearLocal();
                return;
        }
    },

    // Schedule a diff-and-flush. Coalesces consecutive input events into a
    // single MQTT publish per typing burst so the broker doesn't see one
    // message per keystroke from a fast typist.
    _scheduleTextFlush() {
        if (coalesceTimer) return;
        coalesceTimer = setTimeout(() => {
            coalesceTimer = null;
            this._flushTextDiff();
        }, TEXT_COALESCE_MS);
    },

    // Compute the diff between the input's current value and what we last
    // sent. Send N backspaces for any characters that disappeared (or
    // diverged from the trailing edge of the previous value), then the new
    // characters that need typing. One MQTT publish per call.
    _flushTextDiff() {
        const input = document.getElementById('playbill-text-input');
        if (!input || !ctx) return;
        const oldVal = lastSentValue;
        const newVal = input.value;
        if (oldVal === newVal) return;

        // Common prefix length.
        let i = 0;
        const lim = Math.min(oldVal.length, newVal.length);
        while (i < lim && oldVal.charCodeAt(i) === newVal.charCodeAt(i)) i++;

        const backspaces = oldVal.length - i;
        const additions  = newVal.slice(i);

        let text = '\b'.repeat(backspaces) + additions;
        if (!text) { lastSentValue = newVal; return; }

        // Defensive clamp against the controller's 1024-char schema limit.
        // A diff this large only happens on a giant paste; carry the rest
        // forward and the next input event (or our next flush) handles it.
        if (text.length > NAV_TEXT_MAX) {
            text = text.slice(0, NAV_TEXT_MAX);
            // We can't track which exact characters this represents inside
            // `additions` because it may contain backspaces — fall back to
            // resetting lastSentValue conservatively so the next diff
            // re-syncs from the field's current value rather than drifting.
            lastSentValue = newVal.slice(0, lastSentValue.length + text.length);
        } else {
            lastSentValue = newVal;
        }

        this._sendText(text);
    },

    // Send one nav.text command. Increments the in-flight counter so the
    // streaming dot can light up; decrements on success/error.
    _sendText(text) {
        if (!ctx || !text) return;
        inFlightCount++;
        this._renderStreamDot();
        ctx.sendCommand(FEATURE_NAV, { action: 'nav.text', text })
            .catch((e) => console.error('[playbill] nav.text failed:', e))
            .finally(() => {
                inFlightCount = Math.max(0, inFlightCount - 1);
                this._renderStreamDot();
            });
    },

    _submitText() {
        const input = document.getElementById('playbill-text-input');
        const submitBtn = document.querySelector('.playbill-text-submit');
        flash(submitBtn);
        // Flush any pending diff so the Playbill sees the full field
        // content before the Enter goes through (otherwise the form
        // submits with whatever it received up to the last coalesce tick).
        if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
        this._flushTextDiff();
        this._sendText('\n');
        // After Enter, the Playbill field is presumed consumed (form
        // submitted / search executed). Reset local state so the next
        // entry starts fresh without spamming backspaces to delete a
        // field the user can no longer see.
        if (input) input.value = '';
        lastSentValue = '';
    },

    _clearLocal() {
        const input = document.getElementById('playbill-text-input');
        if (input) input.value = '';
        lastSentValue = '';
        if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
        if (input) input.focus();
    },

    // Trim N chars from the tail of lastSentValue + the input field. Used
    // when the explicit Backspace button fires so the diff logic stays in
    // sync with what's actually in the field.
    _trimLocalTail(n) {
        const input = document.getElementById('playbill-text-input');
        if (input) {
            const v = input.value;
            input.value = v.length >= n ? v.slice(0, v.length - n) : '';
        }
        lastSentValue = lastSentValue.length >= n
            ? lastSentValue.slice(0, lastSentValue.length - n)
            : '';
    },

    _renderStreamDot() {
        const dot = document.getElementById('playbill-text-stream-dot');
        if (!dot) return;
        dot.classList.toggle('active', inFlightCount > 0);
    },
};

// ── helpers ──────────────────────────────────────────────────────────────

function flash(btn) {
    if (!btn) return;
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 140);
}

// ── icons ────────────────────────────────────────────────────────────────

function iconArrow() {
    // Single arrowhead; CSS rotates per direction so we ship one SVG.
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 15 12 9 18 15"></polyline>
    </svg>`;
}
function iconBack() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 14L4 9l5-5"></path>
        <path d="M4 9h12a4 4 0 0 1 4 4v4"></path>
    </svg>`;
}
function iconHome() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 11l9-7 9 7v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"></path>
    </svg>`;
}
function iconMenu() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="3" y1="6"  x2="21" y2="6"></line>
        <line x1="3" y1="12" x2="21" y2="12"></line>
        <line x1="3" y1="18" x2="21" y2="18"></line>
    </svg>`;
}
function iconBackspace() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 5H10l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"></path>
        <line x1="18" y1="9" x2="12" y2="15"></line>
        <line x1="12" y1="9" x2="18" y2="15"></line>
    </svg>`;
}
function iconReturn() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="9 10 4 15 9 20"></polyline>
        <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
    </svg>`;
}
function iconClear() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="18" y1="6"  x2="6"  y2="18"></line>
        <line x1="6"  y1="6"  x2="18" y2="18"></line>
    </svg>`;
}
