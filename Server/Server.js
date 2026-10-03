// Among Cube relay server: rooms + message relay. The host's phone runs the game rules.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ORIGIN = process.env.ALLOWED_ORIGIN; // e.g. https://yourname.github.io (no path). Unset = allow all.
const MAX_PLAYERS = 8;
const rooms = new Map();
let nextId = 1;

const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); }); // health check
const wss = new WebSocketServer({
  server,
  maxPayload: 1024, // tiny messages only
  verifyClient: ({ origin }) => !ORIGIN || origin === ORIGIN,
});

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const others = (room, ws, o) => room.players.forEach(p => { if (p !== ws) send(p, o); });
const newCode = () => {
  let c;
  do c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join('');
  while (rooms.has(c));
  return c;
};

wss.on('connection', ws => {
  ws.id = nextId++; ws.alive = true; ws.room = null;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', () => {}); // never crash on a bad socket

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'host' || m.t === 'join') {
      if (ws.room) return;
      let room;
      if (m.t === 'host') {
        room = { code: newCode(), players: new Set(), host: ws };
        rooms.set(room.code, room);
      } else {
        room = rooms.get(String(m.code || '').toUpperCase());
        if (!room) return send(ws, { t: 'err', m: 'Room not found' });
        if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'err', m: 'Room full' });
      }
      room.players.add(ws); ws.room = room;
      send(ws, { t: 'room', code: room.code, id: ws.id, host: room.host.id, players: [...room.players].map(p => p.id) });
      others(room, ws, { t: 'joined', id: ws.id });
      return;
    }

    const room = ws.room;
    if (!room) return;
    m.from = ws.id; // senders can't spoof who they are
    if (m.t === 'pos') others(room, ws, m);                       // anyone: movement -> everyone else
    else if (m.t === 'ev' && ws === room.host) others(room, ws, m); // host only: roles, ejects, win/lose
    else if (m.t === 'req' && ws !== room.host) send(room.host, m); // player -> host only: "I tapped to eject X"
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.players.delete(ws);
    if (!room.players.size) return void rooms.delete(room.code);
    if (room.host === ws) { // host left: oldest remaining player takes over
      room.host = room.players.values().next().value;
      others(room, ws, { t: 'newhost', id: room.host.id });
    }
    others(room, ws, { t: 'left', id: ws.id });
  });
});

// drop dead connections (phones lose signal without closing cleanly)
setInterval(() => wss.clients.forEach(ws => {
  if (!ws.alive) return ws.terminate();
  ws.alive = false; ws.ping();
}), 30000);

server.listen(PORT, () => console.log('listening on ' + PORT));
