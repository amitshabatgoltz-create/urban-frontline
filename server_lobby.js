const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = 3000;

const httpServer = http.createServer((req, res) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/lobby') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'lobby.html'), 'utf8'));
  } else if (url === '/game') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'game.html'), 'utf8'));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const io = new Server(httpServer, { cors: { origin: '*' } });

const players = {};   // socketId → { name, room }
const rooms   = {};   // roomId  → { id, name, host, players[], maxPlayers, open }

function getLobbyList() {
  return Object.values(players).filter(p => !p.room).map(p => p.name);
}
function getSocketByName(name) {
  return Object.keys(players).find(id => players[id].name === name);
}
function getPublicRooms() {
  return Object.values(rooms)
    .filter(r => r.open)
    .map(r => ({ id: r.id, name: r.name, host: r.host, count: r.players.length, max: r.maxPlayers }));
}
function broadcastRooms() {
  io.emit('roomsList', getPublicRooms());
}

io.on('connection', socket => {

  // ── AUTH / LOBBY ──
  socket.on('join', name => {
    players[socket.id] = { name, room: null };
    socket.emit('lobbyPlayers', getLobbyList());
    socket.emit('roomsList', getPublicRooms());
    io.emit('lobbyPlayers', getLobbyList());
    console.log('JOIN:', name);
  });

  // ── DIRECT INVITE (existing feature) ──
  socket.on('invite', target => {
    const from = players[socket.id]?.name;
    const toId = getSocketByName(target);
    if (toId && from) io.to(toId).emit('invited', { from });
  });

  socket.on('acceptInvite', ({ from }) => {
    const me = players[socket.id]?.name;
    const fromId = getSocketByName(from);
    if (!fromId || !me) return;
    const roomId = 'room_' + Date.now();
    rooms[roomId] = { id: roomId, name: from + "'s Room", host: from, players: [from, me], maxPlayers: 10, open: false };
    players[socket.id].room = roomId;
    players[fromId].room = roomId;
    socket.join(roomId);
    io.sockets.sockets.get(fromId)?.join(roomId);
    io.to(roomId).emit('enterRoom', { roomId, players: [from, me], host: from, roomName: rooms[roomId].name });
    io.emit('lobbyPlayers', getLobbyList());
    broadcastRooms();
  });

  socket.on('declineInvite', ({ from }) => {
    const me = players[socket.id]?.name;
    const fromId = getSocketByName(from);
    if (fromId) io.to(fromId).emit('inviteDeclined', { by: me });
  });

  // ── CREATE GROUP ──
  socket.on('createGroup', ({ groupName, maxPlayers }) => {
    const me = players[socket.id]?.name;
    if (!me) return;
    if (players[socket.id].room) return; // already in room
    const roomId = 'room_' + Date.now();
    const max = Math.min(Math.max(parseInt(maxPlayers)||10, 2), 10);
    rooms[roomId] = { id: roomId, name: groupName || (me + "'s Group"), host: me, players: [me], maxPlayers: max, open: true };
    players[socket.id].room = roomId;
    socket.join(roomId);
    socket.emit('enterRoom', { roomId, players: [me], host: me, roomName: rooms[roomId].name });
    io.emit('lobbyPlayers', getLobbyList());
    broadcastRooms();
    console.log('CREATE GROUP:', roomId, rooms[roomId].name);
  });

  // ── JOIN GROUP ──
  socket.on('joinGroup', ({ roomId }) => {
    const me = players[socket.id]?.name;
    if (!me) return;
    if (players[socket.id].room) return;
    const room = rooms[roomId];
    if (!room || !room.open) return;
    if (room.players.length >= room.maxPlayers) return;
    room.players.push(me);
    players[socket.id].room = roomId;
    socket.join(roomId);
    socket.emit('enterRoom', { roomId, players: room.players, host: room.host, roomName: room.name });
    io.to(roomId).emit('roomUpdate', { players: room.players, host: room.host, roomName: room.name });
    io.emit('lobbyPlayers', getLobbyList());
    broadcastRooms();
    console.log('JOIN GROUP:', me, '->', roomId);
  });

  // ── LEAVE ROOM ──
  socket.on('leaveRoom', () => {
    const p = players[socket.id];
    if (!p?.room) return;
    const roomId = p.room;
    socket.leave(roomId);
    p.room = null;
    if (rooms[roomId]) {
      rooms[roomId].players = rooms[roomId].players.filter(n => n !== p.name);
      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
      } else {
        // If host left, assign new host
        if (rooms[roomId].host === p.name) rooms[roomId].host = rooms[roomId].players[0];
        io.to(roomId).emit('roomUpdate', { players: rooms[roomId].players, host: rooms[roomId].host, roomName: rooms[roomId].name });
        io.to(roomId).emit('playerLeft', p.name);
      }
    }
    io.emit('lobbyPlayers', getLobbyList());
    broadcastRooms();
  });

  // ── START GAME ──
  socket.on('startGame', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = players[socket.id];
    if (p?.name !== room.host) return;
    room.open = false; // close room so no new joins
    console.log('START GAME:', roomId, room.players);
    io.to(roomId).emit('gameStarted', { roomId, players: room.players });
    broadcastRooms();
  });

  // ── GAME EVENTS ──
  socket.on('joinGame', ({ room, name }) => {
    socket.join('game_' + room);
    if (!players[socket.id]) players[socket.id] = { name, room: 'game_' + room };
    else { players[socket.id].name = name; players[socket.id].room = 'game_' + room; }
    socket.to('game_' + room).emit('peerJoined', name);
    console.log('GAME JOIN:', name, 'room:', room);
  });

  socket.on('playerMove', ({ room, name, x, y, z, yaw, pitch, wid }) => {
    socket.to('game_' + room).emit('peerUpdate', { name, x, y, z, yaw, pitch, wid });
  });

  socket.on('playerShoot', ({ room, name, dir }) => {
    socket.to('game_' + room).emit('peerShoot', { name, dir });
  });

  socket.on('shootHit', ({ room, target, shooter, dmg }) => {
    const targetId = getSocketByName(target);
    if (targetId) io.to(targetId).emit('youHit', { by: shooter, dmg });
    io.to('game_' + room).emit('peerHurt', { name: target, by: shooter, dmg });
    console.log(shooter, 'HIT', target, '-', dmg, 'dmg');
    const hpKey = 'hp_' + room;
    if (!rooms[hpKey]) rooms[hpKey] = {};
    if (rooms[room]) rooms[room].players.forEach(p => { if (!rooms[hpKey][p]) rooms[hpKey][p] = 150; });
    if (rooms[hpKey][target] === undefined) rooms[hpKey][target] = 150;
    rooms[hpKey][target] -= dmg;
    if (rooms[hpKey][target] <= 0) {
      rooms[hpKey][target] = 0;
      io.to('game_' + room).emit('peerDied', { name: target, killer: shooter });
      const alive = Object.keys(rooms[hpKey]).filter(n => rooms[hpKey][n] > 0);
      if (alive.length <= 1) {
        io.to('game_' + room).emit('gameOver', { winner: alive[0] || shooter });
        delete rooms[hpKey];
      }
    }
  });

  socket.on('leave', () => handleDisconnect());
  socket.on('disconnect', () => handleDisconnect());

  function handleDisconnect() {
    const p = players[socket.id];
    if (!p) return;
    if (p.room && rooms[p.room]) {
      rooms[p.room].players = rooms[p.room].players.filter(n => n !== p.name);
      if (rooms[p.room].players.length === 0) delete rooms[p.room];
      else {
        if (rooms[p.room]?.host === p.name) rooms[p.room].host = rooms[p.room].players[0];
        io.to(p.room).emit('playerLeft', p.name);
        if (rooms[p.room]) io.to(p.room).emit('roomUpdate', { players: rooms[p.room].players, host: rooms[p.room].host, roomName: rooms[p.room].name });
      }
    }
    delete players[socket.id];
    io.emit('lobbyPlayers', getLobbyList());
    broadcastRooms();
    console.log('LEFT:', p.name);
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let ip = 'localhost';
  for (const n of Object.values(nets).flat())
    if (n.family === 'IPv4' && !n.internal) { ip = n.address; break; }
  console.log('\n🎮 URBAN FRONTLINE - LOBBY SERVER');
  console.log('===================================');
  console.log('✅ שרת רץ!');
  console.log('🏠 אתה:   http://localhost:' + PORT);
  console.log('🌐 חברים: http://' + ip + ':' + PORT);
  console.log('===================================\n');
});
