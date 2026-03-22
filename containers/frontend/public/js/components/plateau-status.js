// Plateau calibration status component
// First boot: firmware runs in NDOF mode for initial calibration.
// Once offsets are saved (via save command), firmware switches to ACCONLY
// and boots directly into ACCONLY on all subsequent power cycles.
import { wsClient, API } from '../api.js';

const MOUNT_LABELS = ['Floor', 'Left Wall', 'Right Wall'];

export class PlateauStatus {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.data = {
            imu_connected: null,
            fully_calibrated: null,
            mounting: null
        };
        this.saving = false;
        this.wsHandler = null;
        this.unsubStale = null;
    }

    render() {
        return `
            <div class="plateau-status">
                <div class="plateau-status-header">
                    <span class="plateau-status-dot" id="plateau-dot"></span>
                    <span class="plateau-status-summary" id="plateau-summary">${this.getSummaryText()}</span>
                </div>
                <div id="plateau-cal-section"></div>
                <div class="plateau-mount" id="plateau-mount">${this.formatMount()}</div>
            </div>
        `;
    }

    formatMount() {
        if (this.data.mounting == null) return '';
        const label = MOUNT_LABELS[this.data.mounting];
        return label ? `Mounted on ${label}` : '';
    }

    getSummaryText() {
        if (this.data.imu_connected == null) return 'Waiting for Plateau...';
        if (!this.data.imu_connected) return 'IMU Disconnected';
        if (this.data.fully_calibrated) return 'Leveling Active';
        if (this.saving) return 'Saving...';
        return 'One-Time Sensor Setup';
    }

    getSummaryClass() {
        if (this.data.imu_connected == null) return '';
        if (!this.data.imu_connected) return 'cal-none';
        if (this.data.fully_calibrated) return 'cal-good';
        return 'cal-partial';
    }

    renderCalSection() {
        if (!this.data.imu_connected || this.data.fully_calibrated) return '';

        if (this.saving) return '';

        return `
            <p class="plateau-setup-text">
                Verify the leveling readings above look reasonable, then
                complete setup. This only needs to be done once.
            </p>
            <button class="plateau-save-btn" id="plateau-save-cal">Complete Setup</button>
        `;
    }

    async handleSave() {
        if (this.saving) return;
        this.saving = true;
        this.updateDisplay();

        try {
            await API.saveCalibration();
        } catch (err) {
            console.error('Calibration save failed:', err);
            this.saving = false;
            this.updateDisplay();
        }
    }

    init() {
        this.updateDisplay();

        this.wsHandler = (data) => {
            const wasUncalibrated = !this.data.fully_calibrated;
            this.data = { ...this.data, ...data };

            if (wasUncalibrated && this.data.fully_calibrated) {
                this.saving = false;
            }

            this.updateDisplay();
        };
        wsClient.on('level_status', this.wsHandler);

        this.unsubStale = wsClient.onStale('level_status', () => this.markStale());
    }

    markStale() {
        this.data = {
            imu_connected: null,
            fully_calibrated: null,
            mounting: null
        };
        this.saving = false;
        this.updateDisplay();
    }

    updateDisplay() {
        const dot = document.getElementById('plateau-dot');
        const summary = document.getElementById('plateau-summary');
        const calSection = document.getElementById('plateau-cal-section');
        const mount = document.getElementById('plateau-mount');

        if (dot) {
            dot.className = `plateau-status-dot ${this.getSummaryClass()}`;
        }
        if (summary) {
            summary.textContent = this.getSummaryText();
        }
        if (calSection) {
            calSection.innerHTML = this.renderCalSection();
            const saveBtn = document.getElementById('plateau-save-cal');
            if (saveBtn) {
                saveBtn.addEventListener('click', () => this.handleSave());
            }
        }
        if (mount) {
            mount.textContent = this.formatMount();
        }
    }

    cleanup() {
        if (this.wsHandler) {
            wsClient.off('level_status', this.wsHandler);
        }
        if (this.unsubStale) {
            this.unsubStale();
        }
    }
}
