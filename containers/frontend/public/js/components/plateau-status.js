// Plateau calibration status component
import { wsClient } from '../api.js';

const CAL_LABELS = ['Not Calibrated', 'Starting', 'Calibrating', 'Calibrated'];
const MOUNT_LABELS = ['Floor', 'Left Wall', 'Right Wall'];

export class PlateauStatus {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.data = {
            imu_connected: null,
            fully_calibrated: null,
            cal_sys: null,
            cal_gyro: null,
            cal_accel: null,
            cal_mag: null,
            mounting: null
        };
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
                <div class="plateau-cal-grid">
                    <div class="plateau-cal-item">
                        <span class="plateau-cal-label">System</span>
                        <span class="plateau-cal-value" id="cal-sys">${this.formatCal(this.data.cal_sys)}</span>
                    </div>
                    <div class="plateau-cal-item">
                        <span class="plateau-cal-label">Gyroscope</span>
                        <span class="plateau-cal-value" id="cal-gyro">${this.formatCal(this.data.cal_gyro)}</span>
                    </div>
                    <div class="plateau-cal-item">
                        <span class="plateau-cal-label">Accelerometer</span>
                        <span class="plateau-cal-value" id="cal-accel">${this.formatCal(this.data.cal_accel)}</span>
                    </div>
                    <div class="plateau-cal-item">
                        <span class="plateau-cal-label">Magnetometer</span>
                        <span class="plateau-cal-value" id="cal-mag">${this.formatCal(this.data.cal_mag)}</span>
                    </div>
                </div>
                <div class="plateau-mount" id="plateau-mount">${this.formatMount()}</div>
            </div>
        `;
    }

    formatCal(value) {
        if (value == null) return '-';
        return CAL_LABELS[value] || '-';
    }

    calClass(value) {
        if (value == null) return '';
        if (value === 3) return 'cal-good';
        if (value >= 1) return 'cal-partial';
        return 'cal-none';
    }

    formatMount() {
        if (this.data.mounting == null) return '';
        const label = MOUNT_LABELS[this.data.mounting];
        return label ? `Mounted on ${label}` : '';
    }

    getSummaryText() {
        if (this.data.imu_connected == null) return 'Waiting for Plateau...';
        if (!this.data.imu_connected) return 'IMU Disconnected';
        if (this.data.fully_calibrated) return 'Fully Calibrated';
        if (this.data.cal_sys === 0) return 'Calibration Needed — Keep the vehicle still';
        return 'Calibrating...';
    }

    getSummaryClass() {
        if (this.data.imu_connected == null) return '';
        if (!this.data.imu_connected) return 'cal-none';
        if (this.data.fully_calibrated) return 'cal-good';
        return 'cal-partial';
    }

    init() {
        this.updateDisplay();

        this.wsHandler = (data) => {
            this.data = { ...this.data, ...data };
            this.updateDisplay();
        };
        wsClient.on('level_status', this.wsHandler);

        this.unsubStale = wsClient.onStale('level_status', () => this.markStale());
    }

    markStale() {
        this.data = {
            imu_connected: null,
            fully_calibrated: null,
            cal_sys: null,
            cal_gyro: null,
            cal_accel: null,
            cal_mag: null,
            mounting: null
        };
        this.updateDisplay();
    }

    updateDisplay() {
        const dot = document.getElementById('plateau-dot');
        const summary = document.getElementById('plateau-summary');
        const calSys = document.getElementById('cal-sys');
        const calGyro = document.getElementById('cal-gyro');
        const calAccel = document.getElementById('cal-accel');
        const calMag = document.getElementById('cal-mag');
        const mount = document.getElementById('plateau-mount');

        if (dot) {
            dot.className = `plateau-status-dot ${this.getSummaryClass()}`;
        }
        if (summary) {
            summary.textContent = this.getSummaryText();
        }
        if (calSys) {
            calSys.textContent = this.formatCal(this.data.cal_sys);
            calSys.className = `plateau-cal-value ${this.calClass(this.data.cal_sys)}`;
        }
        if (calGyro) {
            calGyro.textContent = this.formatCal(this.data.cal_gyro);
            calGyro.className = `plateau-cal-value ${this.calClass(this.data.cal_gyro)}`;
        }
        if (calAccel) {
            calAccel.textContent = this.formatCal(this.data.cal_accel);
            calAccel.className = `plateau-cal-value ${this.calClass(this.data.cal_accel)}`;
        }
        if (calMag) {
            calMag.textContent = this.formatCal(this.data.cal_mag);
            calMag.className = `plateau-cal-value ${this.calClass(this.data.cal_mag)}`;
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
