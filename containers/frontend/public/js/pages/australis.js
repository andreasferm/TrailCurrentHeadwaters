// Australis page - Multi-zone CO2 + climate monitoring
import { AustralisDisplay } from '../components/australis-display.js';

let australisDisplay = null;

export const australisPage = {
    render() {
        return `
        <section class="page-australis">
        <h1 class="section-title">Climate Zones</h1>
        <p class="section-subtitle">Multi-sensor CO₂ and climate monitoring</p>
        <div id="australis-container">
        <!-- Australis display will be rendered here -->
        </div>
        </section>
        `;
    },

    init() {
        australisDisplay = new AustralisDisplay('australis-container');
        document.getElementById('australis-container').innerHTML = australisDisplay.render();
        australisDisplay.init();
    },

    cleanup() {
        if (australisDisplay) {
            australisDisplay.cleanup();
            australisDisplay = null;
        }
    }
};
