const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

const PORT = 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://amitshabatgoltz_db_user:xiZUdJaOad4u5OWX@cluster0.1u4rkcf.mongodb.net/?appName=Cluster0';

let db;
MongoClient.connect(MONGO_URI).then(client => {
  db = client.db('urbanfrontline');
  console.log('✅ MongoDB מחובר!');
}).catch(err => console.error('❌ MongoDB שגיאה:', err));

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

const players = {};
const rooms   = {};

// ── DB HELPERS ──
async function getUser(name) {
  if (!db) return null;
  return await db.collection('users').findOne({ name });
}

async function createUser(name, passHash) {
  if (!db) return null;
  const user = {
    name, passHash,
    coins: 100,
    wins: 0,
    kills: 0,
    skin: 'rookie',
    ownedSkins: ['rookie'],
    battlePassLevel: 0,
    battlePassXP: 0,
    lastLogin: null,
    loginStreak: 0,
    createdAt: new Date()
  };
  await db.collection('users').insertOne(user);
  return user;
}

async function updateUser(name, update) {
  if (!db) return;
  await db.collection('users').updateOne({ name }, { $set: update });
}

async function addCoins(name, amount) {
  if (!db) return;
  await db.collection('users').updateOne({ name }, { $inc: { coins: amount } });
}

async function addWin(name) {
  if (!db) return;
  await db.collection('users').updateOne({ name }, { $inc: { wins: 1, battlePassXP: 150 } });
}

async function addKill(name) {
  if (!db) return;
  await db.collection('users').updateOne({ name }, { $inc: { kills: 1, battlePassXP: 25 } });
}

// Daily login reward
async function handleDailyLogin(name) {
  if (!db) return { reward: 0, streak: 0 };
  const user = await getUser(name);
  if (!user) return { reward: 0, streak: 0 };
  const now = new Date();
  const last = user.lastLogin ? new Date(user.lastLogin) : null;
  const isNewDay = !last || (now - last) > 20 * 60 * 60 * 1000; // 20 hours
  if (!isNewDay) return { reward: 0, streak: user.loginStreak || 0 };
  const streak = ((user.loginStreak || 0) % 7) + 1;
  const rewards = [50, 100, 150, 200, 250, 300, 500];
  const reward = rewards[streak - 1];
  await db.collection('users').updateOne({ name }, {
    $set: { lastLogin: now, loginStreak: streak },
    $inc: { coins: reward }
  });
  return { reward, streak };
}

function getLobbyList() {
  return Object.values(players).filter(p => !p.room).map(p => p.name);
}
function getSocketByName(name) {
  return Object.keys(players).find(id => players[id].name === name);
}
function getPublicRooms() {
  return Object.values(rooms).filter(r => r.open)
    .map(r => ({ id: r.id, name: r.name, host: r.host, count: r.players.length, max: r.maxPlayers }));
}
function broadcastRooms() { io.emit('roomsList', getPublicRooms()); }

io.on('connection', socket => {

  // ── REGISTER ──
  socket.on('register', async ({ name, passHash }) => {
    const existing = await getUser(name);
    if (existing) { socket.emit('authError', 'שם תפוס'); return; }
    const user = await createUser(name, passHash);
    socket.emit('authOk', { name, coins: user.coins, wins: user.wins, kills: user.kills, skin: user.skin, ownedSkins: user.ownedSkins, battlePassLevel: user.battlePassLevel });
  });

  // ── LOGIN ──
  socket.on('login', async ({ name, passHash }) => {
    const user = await getUser(name);
    if (!user) { socket.emit('authError', 'משתמש לא קיים'); return; }
    if (user.passHash !== passHash) { socket.emit('authError', 'סיסמה שגויה'); return; }
    const { reward, streak } = await handleDailyLogin(name);
    const fresh = await getUser(name);
    socket.emit('authOk', {
      name,
      coins: fresh.coins,
      wins: fresh.wins,
      kills: fresh.kills,
      skin: fresh.skin,
      ownedSkins: fresh.ownedSkins || ['rookie'],
      battlePassLevel: fresh.battlePassLevel || 0,
      battlePassXP: fresh.battlePassXP || 0,
      dailyReward: reward,
      loginStreak: streak
    });
  });

  // ── JOIN LOBBY ──
  socket.on('join', name => {
    players[socket.id] = { name, room: null };
    io.emit('lobbyPlayers', getLobbyList());
    socket.emit('roomsList', getPublicRooms());
    console.log('JOIN:', name);
  });

  // ── BUY SKIN ──
  socket.on('buySkin', async ({ name, skinId, price }) => {
    const user = await getUser(name);
    if (!user) return;
    if (user.coins < price) { socket.emit('buyResult', { ok: false, msg: 'אין מספיק מטבעות' }); return; }
    if ((user.ownedSkins || []).includes(skinId)) { socket.emit('buyResult', { ok: false, msg: 'כבר יש לך את הסקין הזה' }); return; }
    await db.collection('users').updateOne({ name }, {
      $inc: { coins: -price },
      $push: { ownedSkins: skinId }
    });
    const fresh = await getUser(name);
    socket.emit('buyResult', { ok: true, skinId, coins: fresh.coins, ownedSkins: fresh.ownedSkins });
  });

  // ── EQUIP SKIN ──
  socket.on('equipSkin', async ({ name, skinId }) => {
    await updateUser(name, { skin: skinId });
    socket.emit('equipResult', { ok: true, skin: skinId });
  });

  // ── INVITE ──
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
    if (!me || players[socket.id].room) return;
    const roomId = 'room_' + Date.now();
    const max = Math.min(Math.max(parseInt(maxPlayers) || 10, 2), 10);
    rooms[roomId] = { id: roomId, name: groupName || (me + "'s Group"), host: me, players: [me], maxPlayers: max, open: true };
    players[socket.id].room = roomId;
    socket.join(roomId);
    socket.emit('enterRoom', { roomId, players: [me], host: me, roomName: rooms[roomId].name });
    io.emit('lobbyPlayers', getLobbyList());
    broadcastRooms();
  });

  // ── JOIN GROUP ──
  socket.on('joinGroup', ({ roomId }) => {
    const me = players[socket.id]?.name;
    if (!me || players[socket.id].room) return;
    const room = rooms[roomId];
    if (!room || !room.open || room.players.length >= room.maxPlayers) return;
    room.players.push(me);
    players[socket.id].room = roomId;
    socket.join(roomId);
    socket.emit('enterRoom', { roomId, players: room.players, host: room.host, roomName: room.name });
    io.to(roomId).emit('roomUpdate', { players: room.players, host: room.host, roomName: room.name });
    io.emit('lobbyPlayers', getLobbyList());
    broadcastRooms();
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
      if (rooms[roomId].players.length === 0) delete rooms[roomId];
      else {
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
    if (players[socket.id]?.name !== room.host) return;
    room.open = false;
    io.to(roomId).emit('gameStarted', { roomId, players: room.players });
    broadcastRooms();
  });

  // ── GAME EVENTS ──
  socket.on('joinGame', ({ room, name }) => {
    socket.join('game_' + room);
    if (!players[socket.id]) players[socket.id] = { name, room: 'game_' + room };
    else { players[socket.id].name = name; players[socket.id].room = 'game_' + room; }
    socket.to('game_' + room).emit('peerJoined', name);
  });

  socket.on('playerMove', ({ room, name, x, y, z, yaw, pitch, wid, skin }) => {
    socket.to('game_' + room).emit('peerUpdate', { name, x, y, z, yaw, pitch, wid, skin });
  });

  socket.on('playerShoot', ({ room, name, dir }) => {
    socket.to('game_' + room).emit('peerShoot', { name, dir });
  });

  socket.on('shootHit', async ({ room, target, shooter, dmg }) => {
    const targetId = getSocketByName(target);
    if (targetId) io.to(targetId).emit('youHit', { by: shooter, dmg });
    io.to('game_' + room).emit('peerHurt', { name: target, by: shooter, dmg });
    await addKill(shooter);
    await addCoins(shooter, 10);
    const shooterSocket = getSocketByName(shooter);
    if (shooterSocket) {
      const u = await getUser(shooter);
      if (u) io.to(shooterSocket).emit('statsUpdate', { coins: u.coins, kills: u.kills, battlePassXP: u.battlePassXP });
    }
    const hpKey = 'hp_' + room;
    if (!rooms[hpKey]) rooms[hpKey] = {};
    // Init ALL players in room to 150 HP
    if (rooms[room]) {
      rooms[room].players.forEach(p => { if (rooms[hpKey][p] === undefined) rooms[hpKey][p] = 150; });
    }
    if (rooms[hpKey][target] === undefined) rooms[hpKey][target] = 150;
    rooms[hpKey][target] -= dmg;
    if (rooms[hpKey][target] <= 0) {
      rooms[hpKey][target] = 0;
      io.to('game_' + room).emit('peerDied', { name: target, killer: shooter });
      const alive = Object.keys(rooms[hpKey]).filter(n => rooms[hpKey][n] > 0);
      const total = Object.keys(rooms[hpKey]).length;
      // Game over: 1 alive AND all players have been tracked
      const expectedPlayers = rooms[room] ? rooms[room].players.length : 2;
      if (alive.length === 1 && total >= expectedPlayers) {
        const winner = alive[0];
        io.to('game_' + room).emit('gameOver', { winner });
        await addWin(winner);
        await addCoins(winner, 200);
        const winnerSocketId = getSocketByName(winner);
        if (winnerSocketId) {
          const u = await getUser(winner);
          if (u) io.to(winnerSocketId).emit('statsUpdate', { coins: u.coins, wins: u.wins, battlePassXP: u.battlePassXP });
        }
        delete rooms[hpKey];
      }
    }
  });

  socket.on('cheatCode', async ({ name, code }) => {
    if (code !== '192013') return;
    const allSkinIds = ['rookie','street','commando','agent','desert','snow','ninja','engineer','robot','cyber','medic','firefighter'];
    await db.collection('users').updateOne({ name }, {
      $set: { coins: 99999, wins: 500, ownedSkins: allSkinIds }
    });
    const u = await getUser(name);
    socket.emit('cheatResult', { coins: u.coins, wins: u.wins, ownedSkins: u.ownedSkins });
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
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎮 URBAN FRONTLINE SERVER');
  console.log('✅ פורט:', PORT);
});
