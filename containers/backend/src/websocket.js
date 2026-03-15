const WebSocket = require('ws');

function setupWebSocket(server) {
    const wss = new WebSocket.Server({ server, path: '/ws' });

    const clients = new Set();

    wss.on('connection', (ws) => {
        console.log('WebSocket client connected');
        clients.add(ws);

        ws.on('close', () => {
            console.log('WebSocket client disconnected');
            clients.delete(ws);
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            clients.delete(ws);
        });
    });

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
