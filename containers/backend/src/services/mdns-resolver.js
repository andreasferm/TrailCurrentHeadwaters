// mDNS resolver — translates `*.local` hostnames into IPv4 addresses by
// shelling out to `avahi-resolve`. Docker bridge networks don't forward
// multicast, so the in-container resolver falls back to the host's
// avahi-daemon via the DBus / Avahi sockets mounted from the host (see
// docker-compose.yml). The Node DNS resolver alone never sees mDNS, so
// outbound HTTPS requests to e.g. peregrine.local fail with EAI_AGAIN
// without this hop.
//
// Results are cached for 60 s so a steady stream of chat tokens doesn't
// fork a subprocess per call.

const { execFile } = require('child_process');

const TTL_MS = 60_000;
const cache = new Map();   // hostname → { ip, expiresAt }

function isMdnsHost(hostname) {
    return typeof hostname === 'string' &&
           /\.local\.?$/i.test(hostname.trim());
}

function avahiResolve(hostname) {
    return new Promise((resolve, reject) => {
        execFile('avahi-resolve', ['-n', '-4', hostname], { timeout: 4000 },
            (err, stdout, stderr) => {
                if (err) {
                    err.stderr = stderr;
                    return reject(err);
                }
                // Output looks like: "peregrine.local\t192.168.4.20\n"
                const m = /([\d.]+)\s*$/m.exec(stdout || '');
                if (!m) {
                    return reject(new Error(
                        'avahi-resolve gave no IPv4 for ' + hostname +
                        ' (stdout: ' + (stdout || '').trim() + ')'));
                }
                resolve(m[1]);
            });
    });
}

async function resolveMdns(hostname) {
    const now = Date.now();
    const cached = cache.get(hostname);
    if (cached && cached.expiresAt > now) return cached.ip;

    const ip = await avahiResolve(hostname);
    cache.set(hostname, { ip, expiresAt: now + TTL_MS });
    return ip;
}

function invalidate(hostname) {
    if (hostname) cache.delete(hostname);
    else cache.clear();
}

module.exports = {
    isMdnsHost,
    resolveMdns,
    invalidate,
};
