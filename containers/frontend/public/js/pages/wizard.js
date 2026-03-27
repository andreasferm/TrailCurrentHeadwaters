// Configuration Wizard page
import { API } from '../api.js';
import { wsClient } from '../api.js';

let systemConfig = null;
let currentStep = 1;
let step2ListenersAttached = false;
let discoveryActive = false;
let discoveryListener = null;
let discoveryTimeout = null;
let moduleTypes = [];
let moduleDisplayNames = {};

export const wizardPage = {
    render() {
        return `
            <section class="page-wizard">
                <div class="wizard-container">
                    <!-- Wizard steps indicator -->
                    <div class="wizard-steps">
                        <div class="wizard-step-indicator step-1 active">
                            <div class="step-number">1</div>
                            <div class="step-label">WiFi Setup</div>
                        </div>
                        <div class="wizard-step-indicator step-2">
                            <div class="step-number">2</div>
                            <div class="step-label">Discover Modules</div>
                        </div>
                        <div class="wizard-step-indicator step-3">
                            <div class="step-number">3</div>
                            <div class="step-label">Finish</div>
                        </div>
                    </div>

                    <!-- Wizard content -->
                    <div class="wizard-content" id="wizard-content">
                        <!-- Steps will be rendered here -->
                    </div>

                    <!-- Wizard actions -->
                    <div class="wizard-actions">
                        <button class="wizard-btn wizard-btn-secondary" id="wizard-back-btn" style="display: none;">
                            Back
                        </button>
                        <button class="wizard-btn wizard-btn-primary" id="wizard-next-btn">
                            Next
                        </button>
                    </div>
                </div>
            </section>
        `;
    },

    async init() {
        try {
            // Load system configuration and module types
            const [configData, typesData] = await Promise.all([
                API.getSystemConfig(),
                API.getModuleTypes()
            ]);
            systemConfig = configData;
            moduleTypes = typesData;
            moduleDisplayNames = Object.fromEntries(moduleTypes.map(m => [m.id, m.name]));
            currentStep = 1;

            // Initialize mcu_modules if not present
            if (!systemConfig.mcu_modules) {
                systemConfig.mcu_modules = [];
            }

            // Initialize WiFi config if not present
            if (!systemConfig.wifi_ssid) {
                systemConfig.wifi_ssid = '';
            }
            if (!systemConfig.wifi_password) {
                systemConfig.wifi_password = '';
            }

            // Render first step
            this.renderStep(1);

            // Setup listeners after DOM is ready
            setTimeout(() => this.setupListeners(), 0);
        } catch (error) {
            console.error('Failed to load system config:', error);
            const contentEl = document.getElementById('wizard-content');
            if (contentEl) {
                contentEl.innerHTML = '<p style="color: var(--danger);">Failed to load configuration. Please try refreshing the page.</p>';
            }
        }
    },

    renderStep(step) {
        const contentEl = document.getElementById('wizard-content');
        let html = '';

        if (step === 1) {
            html = this.renderStep1();
        } else if (step === 2) {
            html = this.renderStep2();
        } else if (step === 3) {
            html = this.renderStep3();
        }

        contentEl.innerHTML = html;
        currentStep = step;

        // Update step indicators
        const stepIndicators = document.querySelectorAll('.wizard-step-indicator');
        stepIndicators.forEach((el, idx) => {
            el.classList.toggle('active', idx + 1 === step);
            el.classList.toggle('completed', idx + 1 < step);
        });

        // Update button visibility
        const backBtn = document.getElementById('wizard-back-btn');
        const nextBtn = document.getElementById('wizard-next-btn');

        if (backBtn) {
            backBtn.style.display = step === 1 ? 'none' : 'block';
        }

        if (nextBtn) {
            nextBtn.textContent = step === 3 ? 'Complete Setup' : 'Next';
        }

        // Re-attach event listeners for this step
        if (step === 1) {
            step2ListenersAttached = false;
            this.attachStep1Listeners();
        } else if (step === 2) {
            this.attachStep2Listeners();
        } else if (step === 3) {
            step2ListenersAttached = false;
        }
    },

    renderStep1() {
        return `
            <div class="wizard-step">
                <h2 class="wizard-title">WiFi Configuration</h2>
                <p class="wizard-description">
                    Configure WiFi access point that MCU devices will use for OTA firmware updates.
                </p>

                <div class="wizard-form">
                    <div class="wizard-field">
                        <label class="wizard-label" for="wizard-wifi-ssid">WiFi SSID (Network Name)</label>
                        <input type="text"
                               id="wizard-wifi-ssid"
                               class="wizard-input"
                               placeholder="e.g., Overlook-OTA"
                               value="${systemConfig.wifi_ssid || ''}">
                        <p class="wizard-field-hint">Name of the WiFi network MCUs will connect to</p>
                        <div id="wizard-wifi-ssid-error" class="wizard-error hidden"></div>
                    </div>

                    <div class="wizard-field">
                        <label class="wizard-label" for="wizard-wifi-password">WiFi Password</label>
                        <input type="password"
                               id="wizard-wifi-password"
                               class="wizard-input"
                               placeholder="Enter WiFi password"
                               value="${systemConfig.wifi_password || ''}">
                        <p class="wizard-field-hint">Password for the WiFi network (stored encrypted)</p>
                        <div id="wizard-wifi-password-error" class="wizard-error hidden"></div>
                    </div>
                </div>
            </div>
        `;
    },

    renderStep2() {
        const modules = systemConfig.mcu_modules || [];

        return `
            <div class="wizard-step">
                <h2 class="wizard-title">Discover Modules</h2>
                <p class="wizard-description">
                    Scan for TrailCurrent modules on the CAN bus. Plug in a module, then click "Scan for Devices" to detect it.
                </p>

                <!-- Discovery status area -->
                <div id="discovery-status" class="discovery-status hidden">
                    <div class="discovery-spinner"></div>
                    <span class="discovery-status-text">Scanning for modules...</span>
                </div>

                <!-- Discovered modules (pending confirmation) -->
                <div id="discovered-modules" class="discovered-modules"></div>

                <!-- Discovery error -->
                <div id="discovery-error" class="wizard-error hidden"></div>

                <!-- Confirmed modules list -->
                <div id="modules-list" class="modules-list">
                    ${modules.length > 0 ? `
                        <div class="modules-header">
                            <h3>Added Modules</h3>
                        </div>
                        <div class="modules-items">
                            ${modules.map((mod, idx) => `
                                <div class="module-item">
                                    <div class="module-info">
                                        <div class="module-type">${moduleDisplayNames[mod.type] || mod.type}</div>
                                        <div class="module-details">
                                            <div class="module-name">${mod.name}</div>
                                            <div class="module-hostname">${mod.hostname}${mod.fw ? ` &middot; v${mod.fw}` : ''}</div>
                                        </div>
                                    </div>
                                    <button class="module-delete-btn" data-index="${idx}" title="Remove module">
                                        <span>&times;</span>
                                    </button>
                                </div>
                            `).join('')}
                        </div>
                    ` : `
                        <div class="modules-empty">
                            <p>No modules added yet. Click below to scan for modules.</p>
                        </div>
                    `}
                </div>

                <!-- Scan button -->
                <button class="wizard-btn wizard-btn-primary" id="discovery-scan-btn" style="width: 100%;">
                    ${discoveryActive ? 'Stop Scanning' : 'Scan for Devices'}
                </button>
            </div>
        `;
    },

    renderStep3() {
        const modules = systemConfig.mcu_modules || [];

        return `
            <div class="wizard-step">
                <h2 class="wizard-title">Setup Complete</h2>
                <p class="wizard-description">
                    Review your configuration below. You can change these settings later in the application.
                </p>

                <div class="wizard-summary">
                    <div class="summary-section">
                        <h3 class="summary-section-title">WiFi Configuration</h3>
                        <div class="summary-item">
                            <span class="summary-label">WiFi SSID</span>
                            <span class="summary-value">${systemConfig.wifi_ssid || 'Not configured'}</span>
                        </div>
                        <div class="summary-item">
                            <span class="summary-label">WiFi Password</span>
                            <span class="summary-value">${systemConfig.wifi_password ? '••••••••' : 'Not configured'}</span>
                        </div>
                    </div>

                    <div class="summary-section">
                        <h3 class="summary-section-title">MCU Modules</h3>
                        ${modules.length > 0 ? `
                            <div class="summary-modules">
                                ${modules.map(mod => `
                                    <div class="summary-module-item">
                                        <span class="summary-module-type">${moduleDisplayNames[mod.type] || mod.type}</span>
                                        <span class="summary-module-name">${mod.name}</span>
                                        <span class="summary-module-hostname">${mod.hostname}${mod.fw ? ` &middot; v${mod.fw}` : ''}</span>
                                    </div>
                                `).join('')}
                            </div>
                        ` : `
                            <p class="summary-empty">No modules configured</p>
                        `}
                    </div>
                </div>

                <p class="wizard-note">
                    You can add or modify modules later in the application settings.
                </p>
            </div>
        `;
    },

    attachStep1Listeners() {
        const wifiSsidInput = document.getElementById('wizard-wifi-ssid');
        const wifiPasswordInput = document.getElementById('wizard-wifi-password');

        if (wifiSsidInput) {
            wifiSsidInput.addEventListener('change', (e) => {
                systemConfig.wifi_ssid = e.target.value;
            });
        }

        if (wifiPasswordInput) {
            wifiPasswordInput.addEventListener('change', (e) => {
                systemConfig.wifi_password = e.target.value;
            });
        }
    },

    attachStep2Listeners() {
        if (step2ListenersAttached) return;

        const wizardContent = document.getElementById('wizard-content');
        if (!wizardContent) return;

        wizardContent.addEventListener('click', (e) => {
            const scanBtn = e.target.closest('#discovery-scan-btn');
            const confirmBtn = e.target.closest('.discovery-confirm-btn');
            const deleteBtn = e.target.closest('.module-delete-btn');

            if (scanBtn) {
                if (discoveryActive) {
                    this.stopDiscovery();
                } else {
                    this.startDiscovery();
                }
            } else if (confirmBtn) {
                const hostname = confirmBtn.dataset.hostname;
                this.confirmModule(hostname);
            } else if (deleteBtn) {
                const index = deleteBtn.dataset.index;
                this.deleteModule(index);
            }
        });

        step2ListenersAttached = true;
    },

    async startDiscovery() {
        const scanBtn = document.getElementById('discovery-scan-btn');
        const statusEl = document.getElementById('discovery-status');
        const errorEl = document.getElementById('discovery-error');

        errorEl.classList.add('hidden');

        try {
            await API.startDiscovery();

            discoveryActive = true;
            scanBtn.textContent = 'Stop Scanning';
            statusEl.classList.remove('hidden');

            // Listen for discovery_found WebSocket events
            discoveryListener = (data) => {
                this.onModuleFound(data);
            };
            wsClient.on('discovery_found', discoveryListener);

            // Auto-stop after 35 seconds (matches mDNS browse timeout)
            discoveryTimeout = setTimeout(() => {
                this.stopDiscovery();
            }, 35000);

        } catch (error) {
            console.error('Failed to start discovery:', error);
            errorEl.textContent = 'Failed to start discovery: ' + error.message;
            errorEl.classList.remove('hidden');
        }
    },

    async stopDiscovery() {
        const scanBtn = document.getElementById('discovery-scan-btn');
        const statusEl = document.getElementById('discovery-status');

        try {
            await API.stopDiscovery();
        } catch (err) {
            console.error('Error stopping discovery:', err);
        }

        discoveryActive = false;

        if (scanBtn) scanBtn.textContent = 'Scan for Devices';
        if (statusEl) statusEl.classList.add('hidden');

        if (discoveryListener) {
            wsClient.off('discovery_found', discoveryListener);
            discoveryListener = null;
        }

        if (discoveryTimeout) {
            clearTimeout(discoveryTimeout);
            discoveryTimeout = null;
        }
    },

    onModuleFound(data) {
        const container = document.getElementById('discovered-modules');
        if (!container) return;

        // Skip if already confirmed (in mcu_modules list)
        const existing = (systemConfig.mcu_modules || []).find(m => m.hostname === data.hostname);
        if (existing) return;

        // Skip if already shown as discovered
        if (container.querySelector(`[data-hostname="${data.hostname}"]`)) return;

        const displayName = moduleDisplayNames[data.type] || data.type;
        const card = document.createElement('div');
        card.className = 'discovered-module-card';
        card.dataset.hostname = data.hostname;
        card.innerHTML = `
            <div class="discovered-module-info">
                <span class="discovered-module-type">${displayName}</span>
                <span class="discovered-module-details">${data.hostname} &middot; addr ${data.addr} &middot; v${data.fw}</span>
            </div>
            <button class="wizard-btn wizard-btn-primary discovery-confirm-btn" data-hostname="${data.hostname}">
                Confirm
            </button>
        `;

        container.appendChild(card);
    },

    async confirmModule(hostname) {
        const confirmBtn = document.querySelector(`.discovery-confirm-btn[data-hostname="${hostname}"]`);
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Confirming...';
        }

        try {
            await API.confirmModule(hostname);

            // Add to local config
            if (!systemConfig.mcu_modules) systemConfig.mcu_modules = [];

            // Refresh mcu_modules from server (handles auto-naming/renaming)
            const freshConfig = await API.getSystemConfig();
            systemConfig.mcu_modules = freshConfig.mcu_modules || [];

            // Remove from discovered list
            const card = document.querySelector(`.discovered-module-card[data-hostname="${hostname}"]`);
            if (card) card.remove();

            // Re-render the confirmed modules list
            this.renderStep(2);

        } catch (error) {
            console.error('Failed to confirm module:', error);
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Confirm';
            }
            const errorEl = document.getElementById('discovery-error');
            if (errorEl) {
                errorEl.textContent = 'Failed to confirm module: ' + error.message;
                errorEl.classList.remove('hidden');
            }
        }
    },

    deleteModule(index) {
        if (!systemConfig.mcu_modules) return;
        systemConfig.mcu_modules.splice(index, 1);
        this.renderStep(2);
    },

    setupListeners() {
        const nextBtn = document.getElementById('wizard-next-btn');
        const backBtn = document.getElementById('wizard-back-btn');

        if (nextBtn) {
            nextBtn.addEventListener('click', () => this.handleNext());
        }

        if (backBtn) {
            backBtn.addEventListener('click', () => this.handleBack());
        }
    },

    async handleNext() {
        if (currentStep === 1) {
            if (!this.validateStep1()) return;
            // Save WiFi credentials now so they're available for discovery in step 2
            if (systemConfig.wifi_ssid && systemConfig.wifi_password) {
                try {
                    await API.updateSystemConfig({
                        wifi_ssid: systemConfig.wifi_ssid,
                        wifi_password: systemConfig.wifi_password
                    });
                } catch (err) {
                    console.error('Failed to save WiFi config:', err);
                }
            }
            this.renderStep(2);
        } else if (currentStep === 2) {
            // Stop discovery if active before moving on
            if (discoveryActive) {
                await this.stopDiscovery();
            }
            this.renderStep(3);
        } else if (currentStep === 3) {
            await this.completeWizard();
        }
    },

    handleBack() {
        if (currentStep === 2 && discoveryActive) {
            this.stopDiscovery();
        }
        if (currentStep > 1) {
            this.renderStep(currentStep - 1);
        }
    },

    validateStep1() {
        const wifiSsidInput = document.getElementById('wizard-wifi-ssid');
        const wifiPasswordInput = document.getElementById('wizard-wifi-password');
        const wifiSsidError = document.getElementById('wizard-wifi-ssid-error');
        const wifiPasswordError = document.getElementById('wizard-wifi-password-error');

        // Clear previous errors
        wifiSsidError.classList.add('hidden');
        wifiPasswordError.classList.add('hidden');

        // WiFi validation: if password is provided, SSID must be provided
        const wifiSsid = wifiSsidInput.value.trim();
        const wifiPassword = wifiPasswordInput.value;

        if (wifiPassword && !wifiSsid) {
            wifiSsidError.textContent = 'WiFi SSID is required when a password is provided';
            wifiSsidError.classList.remove('hidden');
            wifiSsidInput.focus();
            return false;
        }

        // Update config
        systemConfig.wifi_ssid = wifiSsid;
        systemConfig.wifi_password = wifiPassword;

        return true;
    },

    async completeWizard() {
        const nextBtn = document.getElementById('wizard-next-btn');
        nextBtn.disabled = true;
        nextBtn.textContent = 'Completing...';

        try {
            // Save configuration
            await API.updateSystemConfig({
                wizard_completed: true,
                mcu_modules: systemConfig.mcu_modules || [],
                wifi_ssid: systemConfig.wifi_ssid || '',
                wifi_password: systemConfig.wifi_password || ''
            });

            // Dispatch event to notify app that wizard is complete
            window.dispatchEvent(new CustomEvent('wizardCompleted', {
                detail: { config: systemConfig }
            }));
        } catch (error) {
            console.error('Failed to save system config:', error);
            nextBtn.disabled = false;
            nextBtn.textContent = 'Complete Setup';
            alert('Failed to save configuration: ' + error.message);
        }
    },

    cleanup() {
        if (discoveryActive) {
            this.stopDiscovery();
        }
        systemConfig = null;
        currentStep = 1;
    }
};
