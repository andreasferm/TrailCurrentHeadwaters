// Playbill volume widget — persistent header element on the Playbill page.
//
// Why this isn't a tab: a hardware volume knob (steering wheel button, IR
// remote, future CAN button on PlaybillVolumeCmd) should adjust whatever's
// playing without the user first navigating to a "Volume" screen. The DBC
// reflects the same intent — PlaybillVolumeCmd is split from
// PlaybillTransportCmd precisely so a single physical control can target it.
//
// Wire format:
//   status   ← local/playbill/<id>/volume/status   { volumePct, muted }
//   command  → local/playbill/<id>/volume/command  { action: 'transport.<verb>', ... }
//
// ── Status-driven, no local state ────────────────────────────────────────
//
// The slider is owned by the broker, not this module. Three rules:
//
//   1. Never cache the volume value in JS. The DOM `slider.value` is the
//      only place the percentage lives client-side, and it only stays
//      authoritative for the brief window while the user is dragging.
//   2. While the user is actively dragging (pointerdown → change), do not
//      overwrite `slider.value` from incoming status — the user owns the
//      visual until they release.
//   3. On release (`change` fires), publish ONE `transport.volumeSet`
//      command and then sit back. The next `volume/status` payload — from
//      our command's effect, or from another device adjusting in parallel —
//      drives the slider to its new authoritative position.
//
// This means if another device changes the volume mid-drag, our drag wins
// until release; if another device changes it during the wait-for-status
// gap, the slider snaps to whatever the broker says next. Either way, the
// PWA never lies about what the system volume actually is.

const STEP = 5;

let ctx = null;
let userInteracting = false;   // true between pointerdown and the matching change/pointerup

export const volumeWidget = {
    render() {
        // Controls start enabled. The widget needs no prior status to be
        // useful — a click on +/-/mute fires a command, the Playbill acts,
        // status comes back, and the slider catches up to the new state.
        // The only state where we deliberately lock controls out is when
        // there's no Playbill at all to send commands to, and that's
        // handled by the page shell (which doesn't render this widget
        // when the device picker is empty).
        return `
            <div class="playbill-volume" id="playbill-volume" aria-label="Volume">
                <button class="playbill-vol-btn playbill-vol-mute" id="playbill-vol-mute"
                        aria-label="Toggle mute" title="Mute">
                    ${iconVolume(50)}
                </button>
                <input class="playbill-vol-slider" id="playbill-vol-slider"
                       type="range" min="0" max="100" step="1" value="0"
                       aria-label="Volume level">
                <span class="playbill-vol-pct" id="playbill-vol-pct">—</span>
                <div class="playbill-vol-step">
                    <button class="playbill-vol-btn" id="playbill-vol-down"
                            aria-label="Volume down" title="Volume −${STEP}">−</button>
                    <button class="playbill-vol-btn" id="playbill-vol-up"
                            aria-label="Volume up"   title="Volume +${STEP}">+</button>
                </div>
            </div>
        `;
    },

    init(initCtx) {
        ctx = initCtx;
        userInteracting = false;

        const slider = document.getElementById('playbill-vol-slider');
        const pct    = document.getElementById('playbill-vol-pct');
        const mute   = document.getElementById('playbill-vol-mute');
        const up     = document.getElementById('playbill-vol-up');
        const down   = document.getElementById('playbill-vol-down');

        // Drag detection. The window-level pointerup is the failsafe for
        // the case where the user starts dragging on the thumb but releases
        // outside the slider element — without it `userInteracting` could
        // stay stuck and lock out status updates.
        slider.addEventListener('pointerdown', () => { userInteracting = true; });
        const releaseInteraction = () => { userInteracting = false; };
        slider.addEventListener('pointercancel', releaseInteraction);
        window.addEventListener('pointerup',     releaseInteraction);

        // 'input' fires continuously during drag. Update the label preview
        // and the fill-gradient CSS var only — never echo back a command.
        slider.addEventListener('input',  () => {
            pct.textContent = `${slider.value}%`;
            slider.style.setProperty('--pct', slider.value);
        });

        // 'change' fires once on release (or on keyboard nudge). Send one
        // command and clear the interaction lock — the next status payload
        // will overwrite slider.value.
        slider.addEventListener('change', () => {
            userInteracting = false;
            this._sendSet(Number(slider.value));
        });

        mute.addEventListener('click', () => this._sendToggleMute());
        up  .addEventListener('click', () => this._sendStep(+STEP));
        down.addEventListener('click', () => this._sendStep(-STEP));

        // Replay the last seen status the shell cached for us, if any.
        const last = ctx && typeof ctx.getLastStatus === 'function' ? ctx.getLastStatus() : null;
        this.onStatus(last);
    },

    cleanup() {
        ctx = null;
        userInteracting = false;
        // The slider's window-level pointerup listener is anonymous, so it
        // won't be detached here — but the closure only touches our local
        // boolean, which is reset above. When the page DOM is replaced on
        // navigation, the listener becomes a no-op against a dead module.
    },

    // Called by the page shell whenever a `volume` status payload arrives,
    // and with `null` when the user switches Playbills (clears the
    // display, but does NOT disable the controls — see render() comment).
    onStatus(payload) {
        const slider = document.getElementById('playbill-vol-slider');
        const pct    = document.getElementById('playbill-vol-pct');
        const mute   = document.getElementById('playbill-vol-mute');
        if (!slider) return;

        if (!payload || typeof payload.volumePct !== 'number') {
            // No status yet — show a neutral display but keep controls
            // clickable. The first click will publish a command and we'll
            // pick up the real state from the response.
            slider.value = 0;
            slider.style.setProperty('--pct', '0');
            pct.textContent = '—';
            mute.classList.remove('muted');
            mute.innerHTML = iconVolume(50);
            return;
        }

        // While the user is actively dragging, don't fight them. The DOM
        // slider is the user's; we'll catch up on the next status after
        // they release.
        if (!userInteracting) {
            slider.value = String(payload.volumePct);
            slider.style.setProperty('--pct', String(payload.volumePct));
        }

        pct.textContent = payload.muted ? 'Muted' : `${payload.volumePct}%`;
        mute.classList.toggle('muted', payload.muted);
        mute.innerHTML = payload.muted ? iconMuted() : iconVolume(payload.volumePct);
    },

    // ── internals ────────────────────────────────────────────────────────

    async _sendSet(percent) {
        if (!ctx) return;
        try {
            await ctx.sendCommand({ action: 'transport.volumeSet', percent });
        } catch (e) {
            console.error('[playbill] volumeSet failed:', e);
            // Don't try to revert — the next status will tell us the truth.
        }
    },

    async _sendStep(deltaPct) {
        if (!ctx) return;
        try {
            const action = deltaPct >= 0 ? 'transport.volumeUp' : 'transport.volumeDown';
            await ctx.sendCommand({ action, step: Math.abs(deltaPct) });
        } catch (e) {
            console.error('[playbill] volume step failed:', e);
        }
    },

    async _sendToggleMute() {
        if (!ctx) return;
        try {
            await ctx.sendCommand({ action: 'transport.muteToggle' });
        } catch (e) {
            console.error('[playbill] muteToggle failed:', e);
        }
    },
};

// ── icons ────────────────────────────────────────────────────────────────

// Three speaker glyphs keyed off the current level so the button gives a
// quick visual cue without reading the percentage. All inline SVG; no
// font-icon dependency.
function iconVolume(pct) {
    const arcs = pct >= 66
        ? '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>'
        : pct >= 33
        ? '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>'
        : pct >= 1
        ? '<path d="M14 9.5v5"></path>'
        : '';
    return `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            ${arcs}
        </svg>
    `;
}
function iconMuted() {
    return `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <line x1="23" y1="9" x2="17" y2="15"></line>
            <line x1="17" y1="9" x2="23" y2="15"></line>
        </svg>
    `;
}
