// Playbill Radio tab — band switch, frequency display, tune up/down, scan.
//
// The controller is the source of truth for tuner state; everything visible
// here is driven by retained `local/playbill/<id>/radio/status` payloads
// the controller publishes after each successful command. We never assume a
// command succeeded — we wait for status to come back. This is the same
// pattern the Headwaters lights/water pages already use against MQTT.
//
// Status payload shape (see controller/src/handlers/radio.js setRadioState):
//   { running, band, frequencyHz, gain, modulation, scanning, scanBand,
//     lastTuneAt, lastScan: { band, completedAt, stations?, error? } }

const FEATURE = 'radio';

// Step sizes for the ± buttons. FM uses 100 kHz (.1 MHz) so users can reach
// stations on the international 100 kHz grid AND off-grid frequencies for
// SDR work. The US channel grid is technically 200 kHz anchored at 88.1,
// but rtl_fm has no problem demodulating off-grid; a smaller step gives
// finer control without taking anything away. The manual frequency input
// accepts arbitrary values too. AM stays at 10 kHz (US/international grid).
const STEPS = {
    fm: { step: 100000,  min: 87500000,  max: 108000000, label: 'FM' },
    am: { step: 10000,   min: 530000,    max: 1700000,   label: 'AM' },
};

let ctx = null;      // { deviceId, sendCommand, getLastStatus }
let local = null;    // working draft of band/freq used by tune controls

export const radioTab = {
    id: FEATURE,
    label: 'Radio',
    enabled: true,

    render() {
        return `
            <div class="playbill-radio">
                <div class="playbill-now">
                    <div class="playbill-now-row">
                        <span class="playbill-band-badge" data-band="fm">FM</span>
                        <span class="playbill-frequency" id="playbill-frequency">—</span>
                        <span class="playbill-band-unit" id="playbill-band-unit">MHz</span>
                    </div>
                    <div class="playbill-now-sub" id="playbill-now-sub">Off air</div>
                </div>

                <div class="playbill-controls">
                    <div class="playbill-band-toggle" role="tablist" aria-label="Band">
                        <button class="playbill-band-btn active" data-band="fm" role="tab">FM</button>
                        <button class="playbill-band-btn"        data-band="am" role="tab">AM</button>
                    </div>

                    <div class="playbill-tune-row">
                        <button class="playbill-step-btn" id="playbill-step-down" aria-label="Step down">−</button>
                        <input class="form-input playbill-freq-input" id="playbill-freq-input"
                               type="text" inputmode="decimal" autocomplete="off"
                               placeholder="97.5">
                        <button class="playbill-step-btn" id="playbill-step-up"   aria-label="Step up">+</button>
                    </div>

                    <div class="playbill-action-row">
                        <button class="playbill-btn playbill-btn-primary"   id="playbill-tune">Tune</button>
                        <button class="playbill-btn playbill-btn-secondary" id="playbill-scan">Scan</button>
                        <button class="playbill-btn playbill-btn-danger"    id="playbill-stop">Stop</button>
                    </div>
                </div>

                <div class="playbill-scan-results" id="playbill-scan-results" hidden>
                    <div class="playbill-section-label">Stations found</div>
                    <ul class="playbill-station-list" id="playbill-station-list"></ul>
                </div>
            </div>
        `;
    },

    init(initCtx) {
        ctx = initCtx;
        local = { band: 'fm', frequencyHz: 97500000 };

        document.querySelectorAll('.playbill-band-btn').forEach((btn) => {
            btn.addEventListener('click', () => this._setBand(btn.dataset.band));
        });
        document.getElementById('playbill-step-down').addEventListener('click', () => this._step(-1));
        document.getElementById('playbill-step-up')  .addEventListener('click', () => this._step(+1));
        document.getElementById('playbill-tune').addEventListener('click', () => this._tune());
        document.getElementById('playbill-scan').addEventListener('click', () => this._scan());
        document.getElementById('playbill-stop').addEventListener('click', () => this._stop());

        const input = document.getElementById('playbill-freq-input');
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._tune(); });

        this._renderLocal();

        // Replay the last status the shell may have already cached for us.
        const last = ctx.getLastStatus(FEATURE);
        if (last) this.onStatus(last);
    },

    cleanup() {
        ctx = null;
        local = null;
    },

    onStatus(payload) {
        if (!payload) return;

        const freqEl = document.getElementById('playbill-frequency');
        const subEl  = document.getElementById('playbill-now-sub');
        const unitEl = document.getElementById('playbill-band-unit');
        const scanBtn = document.getElementById('playbill-scan');
        const stopBtn = document.getElementById('playbill-stop');

        if (!freqEl) return;   // tab not mounted

        if (payload.running && payload.frequencyHz) {
            freqEl.textContent = formatFreq(payload.frequencyHz, payload.band);
            unitEl.textContent = payload.band === 'am' ? 'kHz' : 'MHz';
            const bits = [];
            if (payload.band)       bits.push(payload.band.toUpperCase());
            if (payload.modulation) bits.push(payload.modulation);
            bits.push('On air');
            subEl.textContent = bits.join(' · ');
            subEl.classList.add('on-air');
            stopBtn.disabled = false;
        } else if (payload.scanning) {
            freqEl.textContent = '—';
            subEl.textContent  = `Scanning ${(payload.scanBand || '').toUpperCase()}…`;
            subEl.classList.remove('on-air');
            stopBtn.disabled = true;
        } else {
            freqEl.textContent = '—';
            subEl.textContent  = 'Off air';
            subEl.classList.remove('on-air');
            stopBtn.disabled = true;
        }
        scanBtn.disabled = !!payload.scanning;

        // Reflect the active band in the segment control even if the user
        // hasn't tapped it yet (e.g. controller already had a session).
        if (payload.band && local && payload.running) {
            local.band = payload.band;
            local.frequencyHz = payload.frequencyHz || local.frequencyHz;
            this._renderLocal({ keepInput: true });
        }

        // Scan results.
        if (payload.lastScan && Array.isArray(payload.lastScan.stations)) {
            this._renderScanResults(payload.lastScan.stations, payload.lastScan.band);
        } else if (payload.lastScan && payload.lastScan.error) {
            this._renderScanError(payload.lastScan.error);
        }
    },

    // ── internals ────────────────────────────────────────────────────────

    _setBand(band) {
        if (!STEPS[band]) return;
        local.band = band;
        // Snap to mid-band default so we don't tune outside allocation.
        if (local.frequencyHz < STEPS[band].min || local.frequencyHz > STEPS[band].max) {
            local.frequencyHz = band === 'fm' ? 97500000 : 1010000;
        }
        this._renderLocal();
    },

    _step(direction) {
        const r = STEPS[local.band];
        const next = Math.round((local.frequencyHz + direction * r.step) / r.step) * r.step;
        if (next < r.min || next > r.max) return;
        local.frequencyHz = next;
        this._renderLocal();
    },

    async _tune() {
        const input = document.getElementById('playbill-freq-input');
        const parsed = parseUserFreq(input.value, local.band);
        if (parsed != null) local.frequencyHz = parsed;
        const r = STEPS[local.band];
        if (local.frequencyHz < r.min || local.frequencyHz > r.max) {
            this._toast(`Out of ${r.label} band`);
            return;
        }
        try {
            await ctx.sendCommand(FEATURE, {
                action: 'radio.tune',
                value: { band: local.band, frequencyHz: local.frequencyHz },
            });
        } catch (e) {
            this._toast(`Tune failed: ${e.message}`);
        }
    },

    async _stop() {
        try { await ctx.sendCommand(FEATURE, { action: 'radio.stop' }); }
        catch (e) { this._toast(`Stop failed: ${e.message}`); }
    },

    async _scan() {
        try {
            await ctx.sendCommand(FEATURE, {
                action: 'radio.scan',
                value: { band: local.band },
            });
        } catch (e) {
            this._toast(`Scan failed: ${e.message}`);
        }
    },

    _renderLocal({ keepInput = false } = {}) {
        document.querySelectorAll('.playbill-band-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.band === local.band);
        });
        const badge = document.querySelector('.playbill-band-badge');
        if (badge) {
            badge.textContent = STEPS[local.band].label;
            badge.dataset.band = local.band;
        }
        if (!keepInput) {
            const input = document.getElementById('playbill-freq-input');
            if (input) input.value = formatFreqForInput(local.frequencyHz, local.band);
        }
    },

    _renderScanResults(stations, band) {
        const root = document.getElementById('playbill-scan-results');
        const list = document.getElementById('playbill-station-list');
        if (!root || !list) return;
        if (!stations.length) {
            root.hidden = false;
            list.innerHTML = '<li class="playbill-empty">No stations above noise floor.</li>';
            return;
        }
        root.hidden = false;
        list.innerHTML = stations
            .slice()
            .sort((a, b) => (b.signalDb || 0) - (a.signalDb || 0))
            .map((s) => `
                <li class="playbill-station-row" data-band="${band || ''}" data-hz="${s.frequencyHz}">
                    <span class="playbill-station-freq">${formatFreq(s.frequencyHz, band)} ${band === 'am' ? 'kHz' : 'MHz'}</span>
                    <span class="playbill-station-db">${s.signalDb != null ? s.signalDb.toFixed(1) + ' dB' : ''}</span>
                </li>
            `).join('');
        list.querySelectorAll('.playbill-station-row').forEach((row) => {
            row.addEventListener('click', () => {
                const hz = Number(row.dataset.hz);
                const bnd = row.dataset.band || local.band;
                if (!hz) return;
                local.band = bnd;
                local.frequencyHz = hz;
                this._renderLocal();
                this._tune();
            });
        });
    },

    _renderScanError(msg) {
        const root = document.getElementById('playbill-scan-results');
        const list = document.getElementById('playbill-station-list');
        if (!root || !list) return;
        root.hidden = false;
        list.innerHTML = `<li class="playbill-empty playbill-error">${escapeHtml(msg)}</li>`;
    },

    _toast(msg) {
        // Reuse the existing PWA toast surface if it lands here later; for
        // now, drop into the sub-row so the user sees the failure inline.
        const subEl = document.getElementById('playbill-now-sub');
        if (subEl) subEl.textContent = msg;
    },
};

// ── helpers ──────────────────────────────────────────────────────────────

function formatFreq(hz, band) {
    if (band === 'am') return String(Math.round(hz / 1000));
    return (hz / 1e6).toFixed(1);
}
function formatFreqForInput(hz, band) {
    if (band === 'am') return String(Math.round(hz / 1000));
    return (hz / 1e6).toFixed(1);
}
// User enters "97.5" for FM (MHz) or "1010" for AM (kHz). Tolerant of
// trailing units. Returns Hz or null.
function parseUserFreq(raw, band) {
    if (!raw) return null;
    const cleaned = String(raw).replace(/[^0-9.]/g, '');
    if (!cleaned) return null;
    const n = Number(cleaned);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (band === 'am') {
        // 1010 kHz → 1010000 Hz; 1.010 (mistakenly typed in MHz) → 1010000
        return n > 10000 ? Math.round(n) : Math.round(n * 1000);
    }
    // FM: 97.5 MHz → 97500000 Hz; 97500000 (Hz copied verbatim) accepted as-is
    if (n > 1e6) return Math.round(n);
    return Math.round(n * 1e6);
}
function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
