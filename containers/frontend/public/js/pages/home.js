// Home page - Thermostat and Lights
import { API } from '../api.js';
import { Thermostat } from '../components/thermostat.js';
import { LightsGrid } from '../components/light-button.js';

let thermostat = null;
let lightsGrid = null;
let alarmEnabled = false;

export const homePage = {
    render() {
        return `
            <section class="page-home">
                <div class="home-grid">
                    <div class="home-panel thermostat-panel">
                        <h1 class="section-title">Climate Control</h1>
                        <div class="card" id="thermostat-card">
                            <!-- Thermostat will be rendered here -->
                        </div>
                    </div>

                    <div class="home-panel lights-panel">
                        <h2 class="section-title">Devices</h2>
                        <div class="card" id="lights-card">
                            <!-- Lights will be rendered here -->
                        </div>
                    </div>
                </div>

                <div class="alarm-bar">
                    <div class="alarm-bar-content">
                        <div class="alarm-label">
                            <svg class="alarm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                            </svg>
                            <span>Alarm</span>
                            <span class="alarm-status" id="alarm-status">Off</span>
                        </div>
                        <button class="toggle-switch" id="alarm-toggle" aria-pressed="false"></button>
                    </div>
                </div>
            </section>
        `;
    },

    async init() {
        // Initialize thermostat
        thermostat = new Thermostat('thermostat-card');
        document.getElementById('thermostat-card').innerHTML = thermostat.render();
        await thermostat.init();

        // Initialize lights (only show panel if modules provide lights)
        try {
            const lights = await API.getLights();
            const lightsPanel = document.querySelector('.lights-panel');
            if (lights.length === 0) {
                if (lightsPanel) lightsPanel.style.display = 'none';
            } else {
                lightsGrid = new LightsGrid('lights-card');
                document.getElementById('lights-card').innerHTML = lightsGrid.render(lights);
                await lightsGrid.init(lights);
            }
        } catch (error) {
            console.error('Failed to fetch lights:', error);
            document.getElementById('lights-card').innerHTML = '<p style="color: var(--danger);">Failed to load lights</p>';
        }

        // Initialize alarm toggle
        try {
            const config = await API.getSystemConfig();
            alarmEnabled = config.alarm_enabled || false;
            this.updateAlarmUI();
        } catch (error) {
            console.error('Failed to load alarm state:', error);
        }

        const alarmToggle = document.getElementById('alarm-toggle');
        if (alarmToggle) {
            alarmToggle.addEventListener('click', async () => {
                alarmToggle.disabled = true;
                try {
                    const newState = !alarmEnabled;
                    await API.updateSystemConfig({ alarm_enabled: newState });
                    alarmEnabled = newState;
                    this.updateAlarmUI();
                } catch (error) {
                    console.error('Failed to toggle alarm:', error);
                } finally {
                    alarmToggle.disabled = false;
                }
            });
        }
    },

    updateAlarmUI() {
        const toggle = document.getElementById('alarm-toggle');
        const status = document.getElementById('alarm-status');
        if (toggle) {
            toggle.classList.toggle('active', alarmEnabled);
            toggle.setAttribute('aria-pressed', alarmEnabled);
        }
        if (status) {
            status.textContent = alarmEnabled ? 'On' : 'Off';
            status.classList.toggle('alarm-status-on', alarmEnabled);
        }
    },

    cleanup() {
        if (thermostat) {
            thermostat.cleanup();
            thermostat = null;
        }
        if (lightsGrid) {
            lightsGrid.cleanup();
            lightsGrid = null;
        }
        alarmEnabled = false;
    }
};
