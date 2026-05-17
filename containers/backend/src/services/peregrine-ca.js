// Peregrine CA service
//
// Manages the Peregrine board's self-signed CA inside this container.
// The CA can be installed in two places:
//
//   1. /usr/local/share/ca-certificates/peregrine.crt — Debian's user
//      trust store. `update-ca-certificates` regenerates
//      /etc/ssl/certs/ca-certificates.crt from these, which is what the
//      Dockerfile points NODE_EXTRA_CA_CERTS at. New Node processes
//      pick this up automatically; openssl/curl/etc. inside the
//      container do too.
//
//   2. An in-process `tls.SecureContext` returned by `getAgent()`.
//      This is what live outbound HTTPS requests use, so the freshly
//      uploaded cert is trusted *without* restarting the backend.
//
// The PEM is also persisted to MongoDB (system_config) so a container
// recreate or `docker compose up --force-recreate` reinstalls it on
// startup. Without that, the trust store is wiped every rebuild.

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const https = require('https');
const { exec } = require('child_process');
const crypto = require('crypto');

const SYSTEM_CA_DIR  = '/usr/local/share/ca-certificates';
const SYSTEM_CA_FILE = path.join(SYSTEM_CA_DIR, 'peregrine.crt');

// In-memory cache of the installed PEM. Rebuilt on install/uninstall;
// also populated by loadFromDb() at startup. Null = no CA installed.
let installedPem = null;
let installedFingerprint = null;
let installedSubject = null;
let cachedAgent = null;

function summarizePem(pem) {
    // Best-effort fingerprint + subject extraction. We avoid pulling in a
    // full ASN.1 parser — Node's `crypto.X509Certificate` covers what we
    // need (Node ≥15).
    try {
        const cert = new crypto.X509Certificate(pem);
        return {
            fingerprint: cert.fingerprint256,
            subject:     cert.subject,
            issuer:      cert.issuer,
            valid_from:  cert.validFrom,
            valid_to:    cert.validTo,
        };
    } catch (err) {
        return {
            fingerprint: null,
            subject:     null,
            issuer:      null,
            valid_from:  null,
            valid_to:    null,
            parse_error: err.message,
        };
    }
}

function validatePem(pem) {
    if (typeof pem !== 'string' || !pem.trim()) {
        throw new Error('Empty certificate');
    }
    const normalized = pem.replace(/\r\n/g, '\n').trim() + '\n';
    if (!/-----BEGIN CERTIFICATE-----/.test(normalized) ||
        !/-----END CERTIFICATE-----/.test(normalized)) {
        throw new Error('Not a PEM-encoded certificate');
    }
    // Tries to parse so we reject garbage early.
    // eslint-disable-next-line no-new
    new crypto.X509Certificate(normalized);
    return normalized;
}

function runUpdateCaCertificates() {
    return new Promise((resolve, reject) => {
        exec('update-ca-certificates', { timeout: 15000 }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

async function ensureCaDir() {
    await fs.promises.mkdir(SYSTEM_CA_DIR, { recursive: true });
}

// Install a PEM into the system trust store and refresh the in-process
// cache. Caller is responsible for persisting it to the database.
async function install(pem) {
    const normalized = validatePem(pem);
    await ensureCaDir();
    await fs.promises.writeFile(SYSTEM_CA_FILE, normalized, { mode: 0o644 });

    try {
        await runUpdateCaCertificates();
    } catch (err) {
        // If update-ca-certificates fails, roll back the file so the
        // system trust store doesn't end up in a weird half-state.
        try { await fs.promises.unlink(SYSTEM_CA_FILE); } catch {}
        const msg = (err.stderr || err.message || '').toString().trim();
        throw new Error('update-ca-certificates failed: ' + msg);
    }

    installedPem = normalized;
    const info = summarizePem(normalized);
    installedFingerprint = info.fingerprint;
    installedSubject = info.subject;
    cachedAgent = null;  // force rebuild on next call

    return info;
}

async function uninstall() {
    try {
        await fs.promises.unlink(SYSTEM_CA_FILE);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    try {
        await runUpdateCaCertificates();
    } catch (err) {
        const msg = (err.stderr || err.message || '').toString().trim();
        throw new Error('update-ca-certificates failed: ' + msg);
    }
    installedPem = null;
    installedFingerprint = null;
    installedSubject = null;
    cachedAgent = null;
}

function isInstalled() {
    return installedPem !== null;
}

function getStatus() {
    if (!installedPem) {
        return { installed: false };
    }
    return {
        installed:   true,
        fingerprint: installedFingerprint,
        subject:     installedSubject,
        ...summarizePem(installedPem),
    };
}

// Build (and cache) an https.Agent that trusts our extra CA on top of
// Node's default Mozilla bundle. Used by the chat proxy so the freshly
// uploaded CA is honored without needing a process restart.
function getAgent() {
    if (cachedAgent) return cachedAgent;
    if (!installedPem) {
        cachedAgent = new https.Agent({ keepAlive: false });
        return cachedAgent;
    }
    const secureContext = tls.createSecureContext({
        ca: [...tls.rootCertificates, installedPem],
    });
    cachedAgent = new https.Agent({
        keepAlive: false,
        secureContext,
    });
    return cachedAgent;
}

// Reinstall the saved cert on startup. Called from index.js after the
// DB is connected. Best-effort: a failure is logged but doesn't crash
// the server (admin can re-upload from the UI).
async function reinstallFromDb(db) {
    try {
        const systemConfig = db.collection('system_config');
        const doc = await systemConfig.findOne({ _id: 'main' });
        const pem = doc && doc.peregrine_ca_pem;
        if (!pem) return { installed: false, reason: 'no cert in db' };
        await install(pem);
        console.log('[peregrine-ca] Reinstalled CA from database:', installedSubject);
        return { installed: true, subject: installedSubject };
    } catch (err) {
        console.error('[peregrine-ca] Failed to reinstall CA from database:', err.message);
        return { installed: false, error: err.message };
    }
}

module.exports = {
    install,
    uninstall,
    isInstalled,
    getStatus,
    getAgent,
    validatePem,
    reinstallFromDb,
    summarizePem,
};
