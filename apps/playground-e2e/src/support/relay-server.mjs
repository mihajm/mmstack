// A real Node WebSocket relay for the e2e suite — the actual @mmstack/mesh-protocol
// createRelay wrapped over `ws`, dogfooding the zero-dep relay core. It carries WebRTC
// signaling for the /webrtc demo and enforces a path ACL for the agent-as-peer demo.
//
// Run via Playwright's webServer (see playwright.config.ts). Imports the BUILT dist because
// the workspace packages resolve through tsconfig paths, not Node resolution; the webServer
// command builds mesh-protocol first.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  createRelay,
  pathPrefixAcl,
} from '../../../../dist/packages/mesh/protocol/index.js';

const PORT = Number(process.env.RELAY_PORT ?? 4301);

// An agent is a user, just a narrower one: humans write the whole store, an agent
// is scoped to the `agent/*` subtree. Writing outside it trips the relay and ejects the agent.
const policy = pathPrefixAcl([
  { prefix: [], allow: (ctx) => ctx.kind !== 'agent' },
  { prefix: ['agent'], allow: (ctx) => ctx.kind === 'agent' },
]);

const relay = createRelay({ policy });

// Per-room tally of inbound client frame kinds. The WebRTC e2e asserts its room saw `signal`
// frames but zero `env` (op) frames — proof the state actually flowed peer-to-peer over the
// data channel, not through the relay.
const stats = Object.create(null);

// GET /stats returns the tally as JSON; any other GET returns 200 so Playwright's webServer
// readiness check gets a response. The WebSocketServer handles upgrades on the same port.
const http = createServer((req, res) => {
  if ((req.url ?? '').startsWith('/stats')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('mesh relay up');
});

const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws, req) => {
  const params = new URL(req.url ?? '/', 'http://x').searchParams;
  const writer = params.get('writer') ?? 'anon';
  const kind = params.get('kind') ?? 'human';
  const conn = relay.connect(
    { send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() },
    { writer, kind },
  );
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return; // malformed frame — drop it
    }
    const room = (stats[msg?.room ?? '?'] ??= {
      hello: 0,
      env: 0,
      presence: 0,
      signal: 0,
    });
    if (msg?.t in room) room[msg.t]++;
    conn.receive(msg);
  });
  ws.on('close', () => conn.disconnect());
  ws.on('error', () => undefined);
});

http.listen(PORT, () => console.log(`[mesh-relay] listening on :${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    wss.close();
    http.close(() => process.exit(0));
  });
}
