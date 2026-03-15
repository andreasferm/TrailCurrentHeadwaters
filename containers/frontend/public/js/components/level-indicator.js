// Level indicator component
import { wsClient } from '../api.js';

export class LevelIndicator {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.data = {
            front_back: null,
            side_to_side: null,
            front_back_diff_mm: null,
            left_right_diff_mm: null,
        };
        this.wsHandler = null;
        this.unsubStale = null;
    }

    render() {
        return `
            <div class="level-container">
                <div class="level-indicator">
                    <span class="level-label">Front / Back</span>
                    <div class="level-bubble" id="fb-bubble">
                        <div class="level-bubble-fill" id="fb-fill"></div>
                    </div>
                    <div class="level-values">
                        <span class="level-value" id="fb-value">${this.formatDegrees(this.data.front_back)}</span>
                        <span class="level-inches" id="fb-inches">${this.formatInches(this.data.front_back_diff_mm)}</span>
                    </div>
                </div>
                <div class="level-indicator">
                    <span class="level-label">Side to Side</span>
                    <div class="level-bubble" id="ss-bubble">
                        <div class="level-bubble-fill" id="ss-fill"></div>
                    </div>
                    <div class="level-values">
                        <span class="level-value" id="ss-value">${this.formatDegrees(this.data.side_to_side)}</span>
                        <span class="level-inches" id="ss-inches">${this.formatInches(this.data.left_right_diff_mm)}</span>
                    </div>
                </div>
            </div>
        `;
    }

    formatDegrees(value) {
        if (value == null) return '-';
        const sign = value > 0 ? '+' : '';
        return `${sign}${value.toFixed(1)}°`;
    }

    formatInches(diffMm) {
        if (diffMm == null) return '-';
        const inches = Math.abs(diffMm) / 25.4;
        const sign = diffMm > 0 ? '+' : diffMm < 0 ? '-' : '';
        return `${sign}${inches.toFixed(1)}"`;
    }

    getStatusClass(value) {
        if (value == null) return '';
        const absValue = Math.abs(value);
        if (absValue > 5) return 'danger';
        if (absValue > 2) return 'warning';
        return '';
    }

    markStale() {
        this.data = {
            front_back: null,
            side_to_side: null,
            front_back_diff_mm: null,
            left_right_diff_mm: null,
        };
        this.updateDisplay();
    }

    init(data) {
        if (data) this.data = { ...this.data, ...data };
        this.updateDisplay();

        // Setup WebSocket listener
        this.wsHandler = (data) => {
            this.data = { ...this.data, ...data };
            this.updateDisplay();
        };
        wsClient.on('level', this.wsHandler);

        this.unsubStale = wsClient.onStale('level', () => this.markStale());
    }

    updateDisplay() {
        const fbFill = document.getElementById('fb-fill');
        const ssFill = document.getElementById('ss-fill');
        const fbValue = document.getElementById('fb-value');
        const ssValue = document.getElementById('ss-value');
        const fbInches = document.getElementById('fb-inches');
        const ssInches = document.getElementById('ss-inches');

        if (fbFill) {
            if (this.data.front_back != null) {
                const fbOffset = (this.data.front_back / 15) * 40;
                fbFill.style.transform = `translate(calc(-50% + ${fbOffset}%), -50%)`;
            } else {
                fbFill.style.transform = 'translate(-50%, -50%)';
            }

            const fbStatus = this.getStatusClass(this.data.front_back);
            fbFill.className = `level-bubble-fill ${fbStatus}`;
        }

        if (ssFill) {
            if (this.data.side_to_side != null) {
                const ssOffset = (this.data.side_to_side / 15) * 40;
                ssFill.style.transform = `translate(calc(-50% + ${ssOffset}%), -50%)`;
            } else {
                ssFill.style.transform = 'translate(-50%, -50%)';
            }

            const ssStatus = this.getStatusClass(this.data.side_to_side);
            ssFill.className = `level-bubble-fill ${ssStatus}`;
        }

        if (fbValue) {
            fbValue.textContent = this.formatDegrees(this.data.front_back);
            fbValue.className = `level-value ${this.getStatusClass(this.data.front_back)}`;
        }

        if (ssValue) {
            ssValue.textContent = this.formatDegrees(this.data.side_to_side);
            ssValue.className = `level-value ${this.getStatusClass(this.data.side_to_side)}`;
        }

        if (fbInches) {
            fbInches.textContent = this.formatInches(this.data.front_back_diff_mm);
            fbInches.className = `level-inches ${this.getStatusClass(this.data.front_back)}`;
        }

        if (ssInches) {
            ssInches.textContent = this.formatInches(this.data.left_right_diff_mm);
            ssInches.className = `level-inches ${this.getStatusClass(this.data.side_to_side)}`;
        }
    }

    cleanup() {
        if (this.wsHandler) {
            wsClient.off('level', this.wsHandler);
        }
        if (this.unsubStale) {
            this.unsubStale();
        }
    }
}
