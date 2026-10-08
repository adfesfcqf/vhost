const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const ALLOWED_USERS = ['mishima'];

function initSSHTerminal(server) {
  const activeSessions = global._sshTokens || new Map();
  const wss = new WebSocketServer({ server, path: '/staff-terminal' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const staffUser = activeSessions.get(token);

    if (!staffUser || !ALLOWED_USERS.includes(staffUser)) {
      ws.send(JSON.stringify({ type: 'error', data: 'Acces refuse.' }));
      ws.close();
      return;
    }

    const shell = pty.spawn('bash', [], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: '/root',
      env: { ...process.env, TERM: 'xterm-color' }
    });

    shell.on('data', (data) => {
      ws.send(JSON.stringify({ type: 'output', data }));
    });

    shell.on('exit', () => {
      ws.send(JSON.stringify({ type: 'exit' }));
      ws.close();
    });

    ws.on('message', (msg) => {
      try {
        const m = JSON.parse(msg);
        if (m.type === 'input') shell.write(m.data);
        if (m.type === 'resize') shell.resize(m.cols, m.rows);
      } catch {}
    });

    ws.on('close', () => {
      shell.kill();
    });
  });

  console.log('[TERMINAL] WebSocket pret sur /staff-terminal');
}

module.exports = { initSSHTerminal };
