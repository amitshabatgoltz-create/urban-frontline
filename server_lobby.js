const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = 3000;

const httpServer = http.createServer((req, res) => {
  // Bypass ngrok browser warning
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

const players = {};  // socketId → username
const rooms   = {};  // roomId → { host, players:[] }

function getLobbyList(){
  return Object.values(players).filter(p => !p.room).map(p => p.name);
}
function getSocketByName(name){
  return Object.keys(players).find(id => players[id].name === name);
}

io.on('connection', socket => {

  socket.on('join', name => {
    players[socket.id] = { name, room: null };
    io.emit('lobbyPlayers', getLobbyList());
    console.log('JOIN:', name);
  });

  socket.on('invite', target => {
    const from = players[socket.id]?.name;
    const toId = getSocketByName(target);
    if(toId && from) io.to(toId).emit('invited', { from });
  });

  socket.on('acceptInvite', ({ from }) => {
    const me = players[socket.id]?.name;
    const fromId = getSocketByName(from);
    if(!fromId || !me) return;

    const roomId = 'room_' + Date.now();
    rooms[roomId] = { host: from, players: [from, me] };
    players[socket.id].room = roomId;
    players[fromId].room = roomId;
    socket.join(roomId);
    io.sockets.sockets.get(fromId)?.join(roomId);

    io.to(roomId).emit('enterRoom', { roomId, players: [from, me], host: from });
    io.emit('lobbyPlayers', getLobbyList());
    console.log('ROOM:', roomId, [from, me]);
  });

  socket.on('declineInvite', ({ from }) => {
    const me = players[socket.id]?.name;
    const fromId = getSocketByName(from);
    if(fromId) io.to(fromId).emit('inviteDeclined', { by: me });
  });

  socket.on('leaveRoom', () => {
    const p = players[socket.id];
    if(!p?.room) return;
    const roomId = p.room;
    socket.leave(roomId);
    p.room = null;
    if(rooms[roomId]){
      rooms[roomId].players = rooms[roomId].players.filter(n => n !== p.name);
      if(rooms[roomId].players.length === 0) delete rooms[roomId];
      else io.to(roomId).emit('roomUpdate', { players: rooms[roomId].players, host: rooms[roomId].host });
      io.to(roomId).emit('playerLeft', p.name);
    }
    io.emit('lobbyPlayers', getLobbyList());
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms[roomId];
    if(!room) return;
    const p = players[socket.id];
    if(p?.name !== room.host) return;
    console.log('START GAME:', roomId, room.players);
    io.to(roomId).emit('gameStarted', { roomId, players: room.players });
  });

  // ── GAME EVENTS ──
  socket.on('joinGame', ({room, name}) => {
    socket.join('game_'+room);
    // Register player name for getSocketByName to work (new socket after page navigation)
    if(!players[socket.id]) players[socket.id] = { name, room: 'game_'+room };
    else { players[socket.id].name = name; players[socket.id].room = 'game_'+room; }
    socket.to('game_'+room).emit('peerJoined', name);
    console.log('GAME JOIN:', name, 'room:', room);
  });

  socket.on('playerMove', ({room, name, x, y, z, yaw, pitch}) => {
    socket.to('game_'+room).emit('peerUpdate', {name, x, y, z, yaw, pitch});
  });

  socket.on('playerShoot', ({room, name, dir}) => {
    socket.to('game_'+room).emit('peerShoot', {name, dir});
  });

  socket.on('shootHit', ({room, target, shooter, dmg}) => {
    const targetId = getSocketByName(target);
    if(targetId) io.to(targetId).emit('youHit', {by: shooter, dmg});
    io.to('game_'+room).emit('peerHurt', {name: target, by: shooter, dmg});
    console.log(shooter, 'HIT', target, '-', dmg, 'dmg');
    
    // Track HP server-side per room
    const hpKey = 'hp_'+room;
    if(!rooms[hpKey]) rooms[hpKey] = {};
    if(rooms[room]) rooms[room].players.forEach(p => { if(!rooms[hpKey][p]) rooms[hpKey][p] = 150; });
    if(rooms[hpKey][target] === undefined) rooms[hpKey][target] = 150;
    rooms[hpKey][target] -= dmg;
    if(rooms[hpKey][target] <= 0){
      rooms[hpKey][target] = 0;
      io.to('game_'+room).emit('peerDied', {name: target, killer: shooter});
      const alivePlayers = Object.keys(rooms[hpKey]).filter(n=>rooms[hpKey][n]>0);
      if(alivePlayers.length <= 1){
        const winner = alivePlayers[0] || shooter;
        io.to('game_'+room).emit('gameOver', {winner});
        delete rooms[hpKey];
      }
    }
  });

  socket.on('leave', () => {
    handleDisconnect();
  });

  socket.on('disconnect', () => {
    handleDisconnect();
  });

  function handleDisconnect(){
    const p = players[socket.id];
    if(!p) return;
    if(p.room && rooms[p.room]){
      rooms[p.room].players = rooms[p.room].players.filter(n => n !== p.name);
      if(rooms[p.room].players.length === 0) delete rooms[p.room];
      else io.to(p.room).emit('playerLeft', p.name);
    }
    delete players[socket.id];
    io.emit('lobbyPlayers', getLobbyList());
    console.log('LEFT:', p.name);
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let ip = 'localhost';
  for(const n of Object.values(nets).flat())
    if(n.family==='IPv4' && !n.internal){ ip=n.address; break; }
  console.log('\n🎮 URBAN FRONTLINE - LOBBY SERVER');
  console.log('===================================');
  console.log('✅ שרת רץ!');
  console.log('🏠 אתה:   http://localhost:'+PORT);
  console.log('🌐 חברים: http://'+ip+':'+PORT);
  console.log('===================================\n');
});
