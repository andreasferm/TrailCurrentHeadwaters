const express = require('express');
const router = express.Router();
const { Client } = require('ssh2');

module.exports = (db) => {
    // POST /api/sms/test
    router.post('/test', async (req, res) => {
        const { phone_number, router_ip, ssh_key } = req.body;

        // Validate required fields
        if (!phone_number || !router_ip || !ssh_key) {
            return res.status(400).json({ error: 'phone_number, router_ip, and ssh_key are required' });
        }

        // Validate phone number (digits, optional +, dashes, spaces, parens)
        const phoneClean = phone_number.replace(/[\s\-()]/g, '');
        if (!/^\+?\d{7,15}$/.test(phoneClean)) {
            return res.status(400).json({ error: 'Invalid phone number format' });
        }

        // Validate router IP (IPv4)
        if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(router_ip)) {
            return res.status(400).json({ error: 'Invalid router IP address format' });
        }

        try {
            const output = await executeRemoteSms(router_ip, ssh_key, phoneClean);
            res.json({ success: true, output });
        } catch (error) {
            console.error('[SMS Test] Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
};

function executeRemoteSms(routerIp, sshKey, phoneNumber, message) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        let commandOutput = '';
        let commandError = '';
        const smsMessage = message || 'Notification test from TrailCurrent';

        const connectionTimeout = setTimeout(() => {
            conn.end();
            reject(new Error('SSH connection timed out after 15 seconds'));
        }, 15000);

        conn.on('ready', () => {
            clearTimeout(connectionTimeout);

            const cmd = `sendsms ${phoneNumber} '${smsMessage.replace(/'/g, "'\\''")}' National`;

            const commandTimeout = setTimeout(() => {
                conn.end();
                reject(new Error('SMS command timed out after 10 seconds'));
            }, 10000);

            conn.exec(cmd, (err, stream) => {
                if (err) {
                    clearTimeout(commandTimeout);
                    conn.end();
                    return reject(new Error(`Failed to execute command: ${err.message}`));
                }

                stream.on('close', (code) => {
                    clearTimeout(commandTimeout);
                    conn.end();
                    if (code === 0) {
                        resolve(commandOutput.trim() || 'SMS sent successfully');
                    } else {
                        reject(new Error(`Command exited with code ${code}: ${commandError.trim() || commandOutput.trim()}`));
                    }
                });

                stream.on('data', (data) => {
                    commandOutput += data.toString();
                });

                stream.stderr.on('data', (data) => {
                    commandError += data.toString();
                });
            });
        });

        conn.on('error', (err) => {
            clearTimeout(connectionTimeout);
            reject(new Error(`SSH connection failed: ${err.message}`));
        });

        conn.connect({
            host: routerIp,
            port: 22,
            username: 'root',
            privateKey: sshKey,
            readyTimeout: 15000,
            hostVerifier: () => true
        });
    });
}

// Re-export for use by other services (future notification sending)
module.exports.executeRemoteSms = executeRemoteSms;
