'use strict';

const fs = require('fs');

// Paths inside the container (mapped from host via volumes)
const THERMAL_ZONE = '/host/sys/class/thermal/thermal_zone0/temp';
const FAN_CUR_STATE = '/host/sys/class/thermal/cooling_device0/cur_state';
const FAN_MAX_STATE = '/host/sys/class/thermal/cooling_device0/max_state';
const PROC_STAT = '/host/proc/stat';

function readFileOr(filePath, fallback) {
    try {
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
        return fallback;
    }
}

// Previous CPU idle/total for utilization delta calculation
let prevIdle = 0;
let prevTotal = 0;

function getCpuUtilization() {
    const raw = readFileOr(PROC_STAT, null);
    if (!raw) return null;

    // First line: cpu  user nice system idle iowait irq softirq steal
    const line = raw.split('\n')[0];
    const parts = line.split(/\s+/).slice(1).map(Number);
    if (parts.length < 4) return null;

    const idle = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);

    const diffIdle = idle - prevIdle;
    const diffTotal = total - prevTotal;

    prevIdle = idle;
    prevTotal = total;

    if (diffTotal === 0) return 0;
    return Math.round(((diffTotal - diffIdle) / diffTotal) * 100);
}

function readSystemStats() {
    // CPU temperature (millidegrees C → °C)
    const tempRaw = readFileOr(THERMAL_ZONE, null);
    const cpuTempC = tempRaw !== null ? parseFloat(tempRaw) / 1000 : null;

    // Fan speed as percentage
    const curState = readFileOr(FAN_CUR_STATE, null);
    const maxState = readFileOr(FAN_MAX_STATE, null);
    let fanPercent = null;
    if (curState !== null && maxState !== null) {
        const max = parseInt(maxState);
        fanPercent = max > 0 ? Math.round((parseInt(curState) / max) * 100) : 0;
    }

    // CPU utilization (delta since last call)
    const cpuPercent = getCpuUtilization();

    return {
        cpu_temp_c: cpuTempC,
        cpu_percent: cpuPercent,
        fan_percent: fanPercent,
    };
}

module.exports = { readSystemStats };
