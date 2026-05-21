const WebSocket = require('ws');

function setupWebSocket(server) {
    const wss = new WebSocket.Server({ server, path: '/ws' });

    const clients = new Set();

    function heartbeat() { this.isAlive = true; }

    wss.on('connection', (ws) => {
        console.log('WebSocket client connected');
        clients.add(ws);
        ws.isAlive = true;
        ws.on('pong', heartbeat);

        ws.on('close', () => {
            console.log('WebSocket client disconnected');
            clients.delete(ws);
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            clients.delete(ws);
        });
    });

    // Server-driven heartbeat: ping every 25s. Any socket that hasn't ponged
    // since the previous cycle is treated as dead and terminated immediately,
    // so broadcasts stop being sent into a zombie connection.
    const heartbeatInterval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                clients.delete(ws);
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 25000);

    wss.on('close', () => clearInterval(heartbeatInterval));

    // Broadcast function — all live data flows through here from MQTT handlers
    function broadcast(type, data) {
        const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
        clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    return { broadcast };
}

module.exports = setupWebSocket;
