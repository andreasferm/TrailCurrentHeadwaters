// Playbill remote-control page.
//
// Shape: device picker (top) → tab strip (Radio / Live TV / Sources / Remote)
// → tab content. The tab system is a small registry so adding a new feature
// later is purely additive: write a renderer with {id, label, icon, render,
// init, cleanup, onStatus} and push it into TABS. The shell wires routing,
// device selection, status fan-out, and lifecycle automatically.
//
// State flow:
//   • On mount we hit GET /api/playbill/devices to get the cached presence
//     list. If empty, we wait for a `playbill_presence` event over WS.
//   • Each per-feature status (`local/playbill/<id>/<feature>/status`)
//     arrives as a `playbill_status` WS event with {deviceId, feature,
//     payload}. The shell routes it to the matching tab's onStatus if the
//     event is for the currently-selected device.
//   • Commands go out via POST /api/playbill/:deviceId/:feature/command,
//     body {action, value?}. The controller dispatches and the resulting
//     state change comes back through the same status pipeline.

import { API, wsClient } from '../api.js';
import { radioTab } from './playbill/radio.js';
import { volumeWidget } from './playbill/volume.js';
import { remoteTab }    from './playbill/remote.js';
import { youtubeTab }   from './playbill/youtube.js';

// Feature tab registry. Order = rendered order in the segmented control.
// Each tab is an object with:
//   id        — string, must match the feature segment in the MQTT topic
//   label     — visible label
//   icon      — inline SVG markup (optional)
//   render()  — returns HTML for the tab body
//   init({ deviceId, sendCommand, getLastStatus })  — wire up handlers
//   cleanup() — tear down listeners
//   onStatus(payload) — called when a status for this feature lands
//   enabled   — boolean; if false, tab renders as a stub
const TABS = [
    radioTab,
    placeholderTab('livetv',    'Live TV',     'Channel list + tuner control arrive in the Live TV phase.'),
    remoteTab,
    youtubeTab,
];

function placeholderTab(id, label, hint) {
    return {
        id, label, enabled: false,
        render: () => `
            <div class="playbill-tab-stub">
                <p class="playbill-stub-title">${label}</p>
                <p class="playbill-stub-hint">${hint}</p>
            </div>
        `,
        init() {},
        cleanup() {},
        onStatus() {},
    };
}

// Maps the controller's `source` enum onto the tab id that represents
// that mode in the PWA. Every video / streaming source maps to the
// Remote tab — we don't build a per-service browser, we just give the
// user a generic D-pad and let them drive whatever the Playbill is
// already showing on screen (Roku/Apple-TV style).
const SOURCE_TO_TAB_ID = {
    radio:   'radio',
    livetv:  'livetv',
    youtube: 'nav',
    local:   'nav',
    plex:    'nav',
    spotify: 'nav',
    netflix: 'nav',
};

let state = {
    devices:        new Map(),   // deviceId → presence payload
    selectedId:     null,
    activeTabId:    'radio',
    lastStatus:     new Map(),   // feature → last seen payload (for selected device)
    // Per-device-per-feature cache of every status payload we've seen. Survives
    // selection changes so a status that arrived before the picker chose a
    // device (e.g., a one-shot retained volume payload landing before
    // playbill_presence sets selectedId) isn't lost. Map<deviceId, Map<feature, payload>>.
    statusByDevice: new Map(),
    listeners:      [],          // WS unsubscribe functions
};

export const playbillPage = {
    render() {
        return `
            <section class="page-playbill">
                <header class="playbill-header">
                    <h1 class="section-title">Playbill</h1>
                    <div class="playbill-device-picker" id="playbill-device-picker">
                        <span class="playbill-device-empty">No Playbills found</span>
                    </div>
                    <button class="playbill-home-btn" id="playbill-home-btn"
                            title="Send Home to Playbill" aria-label="Home">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M3 11l9-7 9 7v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"></path>
                        </svg>
                        <span>Home</span>
                    </button>
                </header>

                ${volumeWidget.render()}

                <nav class="playbill-tabs" id="playbill-tabs" role="tablist">
                    ${TABS.map((t) => `
                        <button class="playbill-tab ${t.id === state.activeTabId ? 'active' : ''} ${t.enabled === false ? 'disabled' : ''}"
                                data-tab="${t.id}"
                                role="tab"
                                aria-selected="${t.id === state.activeTabId}">
                            ${t.label}
                        </button>
                    `).join('')}
                </nav>

                <div class="playbill-tab-body" id="playbill-tab-body">
                    <!-- Active tab renders here on init() -->
                </div>
            </section>
        `;
    },

    async init() {
        // Reset per-mount state so re-entering the page is clean.
        state.devices        = new Map();
        state.lastStatus     = new Map();
        state.statusByDevice = new Map();
        state.listeners      = [];

        // Wire WS listeners FIRST so a retained-status flood right after
        // GET /devices doesn't race ahead of our subscription.
        const onPresence = (data) => this._handlePresence(data);
        const onStatus   = (data) => this._handleStatus(data);
        wsClient.on('playbill_presence', onPresence);
        wsClient.on('playbill_status',   onStatus);
        state.listeners.push(() => wsClient.off('playbill_presence', onPresence));
        state.listeners.push(() => wsClient.off('playbill_status',   onStatus));

        // Prime presence cache from the REST snapshot. Each device entry
        // carries a `statusByFeature` object (the last seen payload for
        // every feature topic, courtesy of the backend's per-feature
        // cache). Seed our per-device status map from it so the volume
        // widget, radio tab, etc. can hydrate on first paint without
        // waiting for a republish that only fires on actual state change.
        try {
            const { devices = [] } = await API.request('/playbill/devices');
            for (const d of devices) {
                if (!d || !d.deviceId) continue;
                state.devices.set(d.deviceId, d);
                if (d.statusByFeature && typeof d.statusByFeature === 'object') {
                    const perDevice = new Map();
                    for (const [feature, payload] of Object.entries(d.statusByFeature)) {
                        perDevice.set(feature, payload);
                    }
                    state.statusByDevice.set(d.deviceId, perDevice);
                }
            }
        } catch (e) {
            console.warn('[playbill] failed to fetch device list:', e);
        }
        // Auto-pick the first online device (or first known if none online).
        if (!state.selectedId) {
            const online = [...state.devices.values()].find((d) => d.online !== false);
            const pick   = online || [...state.devices.values()][0];
            if (pick) {
                state.selectedId = pick.deviceId;
                this._replayCachedStatus();
            }
        }
        this._renderDevicePicker();

        // Tab strip handler.
        const tabBar = document.getElementById('playbill-tabs');
        if (tabBar) {
            tabBar.addEventListener('click', (e) => {
                const btn = e.target.closest('.playbill-tab');
                if (!btn || btn.classList.contains('disabled')) return;
                this._activateTab(btn.dataset.tab);
            });
        }

        // Persistent volume widget — lives above the tab strip so it's
        // available regardless of which feature tab is active. PlaybillVolumeCmd
        // is deliberately separate from PlaybillTransportCmd on the bus and on
        // the CAN side, mirroring that here.
        volumeWidget.init({
            sendCommand: (cmd) => this._sendCommand('volume', cmd),
            getLastStatus: () => state.lastStatus.get('volume') || null,
        });

        // Persistent Home button in the header — one tap from any tab to
        // send the Playbill back to its home screen. Same nav.dpad
        // vocabulary as the Remote tab; the controller dispatches it to
        // whatever source is currently driving the display.
        const homeBtn = document.getElementById('playbill-home-btn');
        if (homeBtn) homeBtn.addEventListener('click', () => {
            homeBtn.classList.add('pressed');
            setTimeout(() => homeBtn.classList.remove('pressed'), 140);
            this._sendCommand('nav', { action: 'nav.dpad', key: 'home' })
                .catch((e) => console.error('[playbill] header Home failed:', e));
        });

        // Render the initial tab body.
        this._activateTab(state.activeTabId);
    },

    cleanup() {
        for (const off of state.listeners) {
            try { off(); } catch (_) { /* noop */ }
        }
        state.listeners = [];
        try { volumeWidget.cleanup(); } catch (e) { console.error('[playbill] volume cleanup:', e); }
        const tab = TABS.find((t) => t.id === state.activeTabId);
        if (tab && typeof tab.cleanup === 'function') {
            try { tab.cleanup(); } catch (e) { console.error('[playbill] tab cleanup:', e); }
        }
    },

    // ── internals ────────────────────────────────────────────────────────

    _renderDevicePicker() {
        const root = document.getElementById('playbill-device-picker');
        if (!root) return;
        const devices = [...state.devices.values()];
        if (devices.length === 0) {
            root.innerHTML = '<span class="playbill-device-empty">No Playbill found on this rig — power it on or check MQTT</span>';
            return;
        }
        const selected = state.selectedId && state.devices.get(state.selectedId);
        // Default selected to first device if the prior selection went away.
        if (!selected && devices.length > 0) state.selectedId = devices[0].deviceId;
        const sel = state.devices.get(state.selectedId);

        const pickerHtml = devices.length === 1
            ? `<span class="playbill-device-pill ${sel.online === false ? 'offline' : 'online'}">
                   <span class="playbill-device-dot"></span>
                   <span class="playbill-device-name">${escapeHtml(sel.name || sel.deviceId)}</span>
               </span>`
            : `<select class="form-input playbill-device-select" id="playbill-device-select">
                   ${devices.map((d) => `
                       <option value="${escapeAttr(d.deviceId)}" ${d.deviceId === state.selectedId ? 'selected' : ''}>
                           ${escapeHtml(d.name || d.deviceId)} ${d.online === false ? '(offline)' : ''}
                       </option>
                   `).join('')}
               </select>`;

        // Renaming a Playbill is done in the Module Configuration list
        // (Config page → edit pencil on the row), same as any other
        // TrailCurrent module. The picker here is read-only — it just
        // shows which Playbill the tabs below are currently controlling.
        root.innerHTML = `
            <div class="playbill-device-row" id="playbill-device-row">
                ${pickerHtml}
            </div>
        `;

        const dropdown = document.getElementById('playbill-device-select');
        if (dropdown) dropdown.addEventListener('change', (e) => {
            state.selectedId = e.target.value;
            state.lastStatus = new Map();
            try { volumeWidget.onStatus(null); } catch (_) { /* noop */ }
            // Replay any cached status for the newly selected device so the
            // volume widget + active tab populate without waiting for a
            // republish that may never come (only `transport` republishes
            // on every state change; volume/radio/livetv/system are edge-
            // triggered).
            this._replayCachedStatus();
            this._activateTab(state.activeTabId);
        });
    },

    _activateTab(tabId) {
        const prev = TABS.find((t) => t.id === state.activeTabId);
        if (prev && typeof prev.cleanup === 'function') {
            try { prev.cleanup(); } catch (e) { console.error('[playbill] tab cleanup:', e); }
        }

        state.activeTabId = tabId;
        const next = TABS.find((t) => t.id === tabId) || TABS[0];

        // Update segmented-control highlight.
        document.querySelectorAll('.playbill-tab').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
            btn.setAttribute('aria-selected', String(btn.dataset.tab === tabId));
        });

        const body = document.getElementById('playbill-tab-body');
        if (body) body.innerHTML = next.render();

        if (typeof next.init === 'function') {
            next.init({
                deviceId:       state.selectedId,
                sendCommand:    (feature, cmd) => this._sendCommand(feature, cmd),
                getLastStatus:  (feature) => state.lastStatus.get(feature) || null,
            });
        }
        // If we already have a retained status for this feature, replay it.
        const last = state.lastStatus.get(tabId);
        if (last && typeof next.onStatus === 'function') {
            try { next.onStatus(last); } catch (e) { console.error('[playbill] onStatus:', e); }
        }
    },

    _handlePresence(payload) {
        if (!payload || !payload.deviceId) return;
        const prior = state.devices.get(payload.deviceId) || {};
        state.devices.set(payload.deviceId, { ...prior, ...payload });
        // First online device wins the picker. Replay any cached status
        // payloads that arrived before this presence event so widgets like
        // the volume slider can enable on first paint instead of waiting
        // for a second status republish that may never come.
        const wasUnselected = !state.selectedId;
        if (wasUnselected && payload.online !== false) {
            state.selectedId = payload.deviceId;
            this._replayCachedStatus();
        }
        this._renderDevicePicker();
    },

    _handleStatus({ deviceId, feature, payload } = {}) {
        if (!deviceId || !feature) return;
        // Always cache, regardless of selection. Decoupling the cache from
        // the selected-device filter means a status that arrived before
        // playbill_presence set selectedId (or a status for a Playbill the
        // user hasn't switched to yet) is still available the moment we do
        // select it. Without this, the volume widget could miss the one
        // and only volume/status publish at boot and stay disabled.
        if (!state.statusByDevice.has(deviceId)) state.statusByDevice.set(deviceId, new Map());
        state.statusByDevice.get(deviceId).set(feature, payload);

        if (deviceId !== state.selectedId) return;     // not the device we're showing
        this._applyStatusToActiveDevice(feature, payload);
    },

    // Apply a single status payload to the visible UI. Splits out from
    // _handleStatus so _replayCachedStatus can call the same code path.
    _applyStatusToActiveDevice(feature, payload) {
        // The volume widget is persistent (not a tab), so it receives every
        // 'volume' status regardless of which tab is active.
        if (feature === 'volume') {
            state.lastStatus.set('volume', payload);
            try { volumeWidget.onStatus(payload); }
            catch (e) { console.error('[playbill] volume onStatus:', e); }
            return;
        }
        state.lastStatus.set(feature, payload);
        // The `source` status flips which tab represents the Playbill's
        // CURRENT mode. Update that visual signal on every source change.
        // Radio/livetv/transport don't influence the mode dot directly —
        // they only flip when the controller mutates state.source — so
        // we don't recompute here on those.
        if (feature === 'source') this._updateActiveModeOnTabs();

        if (feature !== state.activeTabId) return;     // tab not visible; will replay on activate
        const tab = TABS.find((t) => t.id === feature);
        if (tab && typeof tab.onStatus === 'function') {
            try { tab.onStatus(payload); } catch (e) { console.error('[playbill] onStatus:', e); }
        }
    },

    // Mark whichever tab corresponds to the Playbill's current source as
    // "playing right now." Independent of which tab the *user* has open
    // (which is highlighted by `.active` and driven by clicks). At most
    // one tab carries `.playing` at a time; if source is null nothing
    // does. Streaming sources (youtube/plex/...) all map to the Sources
    // tab via SOURCE_TO_TAB_ID.
    _updateActiveModeOnTabs() {
        const srcWrap = state.lastStatus.get('source');
        const source = srcWrap && srcWrap.source;
        const targetTabId = source ? (SOURCE_TO_TAB_ID[source] || null) : null;
        document.querySelectorAll('.playbill-tab').forEach((btn) => {
            btn.classList.toggle('playing', btn.dataset.tab === targetTabId);
        });
    },

    // Apply every cached status payload for the currently-selected device.
    // Called on initial selection and on device-picker change so widgets
    // pick up the broker's retained state without waiting for a republish.
    _replayCachedStatus() {
        if (!state.selectedId) return;
        const cache = state.statusByDevice.get(state.selectedId);
        if (!cache) return;
        for (const [feature, payload] of cache.entries()) {
            this._applyStatusToActiveDevice(feature, payload);
        }
    },

    async _sendCommand(feature, cmd) {
        if (!state.selectedId) {
            throw new Error('No Playbill selected');
        }
        return API.request(`/playbill/${encodeURIComponent(state.selectedId)}/${encodeURIComponent(feature)}/command`, {
            method: 'POST',
            body: JSON.stringify(cmd),
        });
    },
};

// ── tiny escape helpers (no template engine here) ────────────────────────
function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
