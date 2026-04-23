'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os   = require('os');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  pingTimeout:  60000,   // ждать 60 сек перед разрывом
  pingInterval: 25000,   // пинговать каждые 25 сек
  transports: ['websocket', 'polling'], // fallback на polling если WS недоступен
});

// ─── State ────────────────────────────────────────────────────────────────────
/** @type {{ id:string, name:string, totalStars:number }[]} */
let participants = [];

/**
 * session phases:
 *   'presenting' – speaker selected, voting not yet open
 *   'voting'     – voting open, participants can vote
 *
 * votes Map<participantId, { type:'star'|'cross', locked:boolean }>
 *   locked=false → voted once, can still cancel
 *   locked=true  → voted after cancelling, permanent
 */
let session = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getLanIPs() {
  const list = [];
  for (const [name, nets] of Object.entries(os.networkInterfaces())) {
    for (const net of nets) {
      if (!net.internal && net.family === 'IPv4')
        list.push({ ip: net.address, iface: name });
    }
  }
  list.sort((a, b) => ifaceRank(b.iface) - ifaceRank(a.iface));
  return list;
}
function ifaceRank(n) {
  n = n.toLowerCase();
  if (/wi.?fi|wlan|wireless/i.test(n)) return 3;
  if (/eth|local area/i.test(n))       return 2;
  if (/vm|vbox|docker|wsl/i.test(n))   return 0;
  return 1;
}

function byStars() {
  return [...participants].sort((a, b) => b.totalStars - a.totalStars);
}

function sessionDTO() {
  if (!session) return null;
  const speaker = participants.find(p => p.id === session.speakerId);
  if (!speaker) return null;
  return {
    speaker,
    phase:       session.phase,
    stars:       session.stars,
    totalVoters: Math.max(0, participants.length - 1),
    voterCount:  session.votes.size,
  };
}

/** Broadcast full state to everyone */
function broadcast() {
  io.emit('state', { participants: byStars(), session: sessionDTO() });
}

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.emit('state', { participants: byStars(), session: sessionDTO() });

  // ── join / rejoin ────────────────────────────────────────────────────────
  socket.on('join', ({ id, name }) => {
    // Rejoin by stored ID
    if (id) {
      const p = participants.find(p => p.id === id);
      if (p) {
        socket.participantId = p.id;
        const v = session?.votes.get(p.id);
        socket.emit('joined', {
          participant: p,
          voteStatus:  v ? { type: v.type, locked: v.locked } : null,
          isSpeaker:   session?.speakerId === p.id,
        });
        return;
      }
      socket.emit('join_failed');
      return;
    }

    // Register new name
    if (!name?.trim()) return;
    name = name.trim();

    let p = participants.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!p) {
      p = { id: `${Date.now()}${Math.random().toString(36).slice(2,7)}`, name, totalStars: 0 };
      participants.push(p);
      broadcast();
    }
    socket.participantId = p.id;
    const v = session?.votes.get(p.id);
    socket.emit('joined', {
      participant: p,
      voteStatus:  v ? { type: v.type, locked: v.locked } : null,
      isSpeaker:   session?.speakerId === p.id,
    });
  });

  // ── admin: select speaker → presenting phase ──────────────────────────────
  socket.on('select_speaker', ({ participantId }) => {
    if (!participants.find(p => p.id === participantId)) return;
    // usedCancel — кто уже воспользовался отменой (следующий голос будет окончательным)
    session = { speakerId: participantId, phase: 'presenting', stars: 0, votes: new Map(), usedCancel: new Set() };
    broadcast();
  });

  // ── admin: open voting ───────────────────────────────────────────────────
  socket.on('start_voting', () => {
    if (session?.phase !== 'presenting') return;
    session.phase = 'voting';
    broadcast();
  });

  // ── admin: close voting ──────────────────────────────────────────────────
  socket.on('close_voting', () => {
    if (!session) return;
    session = null;
    broadcast();
  });

  // ── vote ─────────────────────────────────────────────────────────────────
  socket.on('vote', ({ type }) => {
    if (session?.phase !== 'voting') return;
    const vid = socket.participantId;
    if (!vid || vid === session.speakerId) return;

    const prev = session.votes.get(vid);
    if (prev?.locked) return; // already final

    // Undo previous star if re-voting without cancel
    if (prev?.type === 'star') {
      session.stars = Math.max(0, session.stars - 1);
      const sp = participants.find(p => p.id === session.speakerId);
      if (sp) sp.totalStars = Math.max(0, sp.totalStars - 1);
    }

    // Если уже использовал отмену → этот голос окончательный (locked)
    const locked = session.usedCancel.has(vid) || !!prev;
    if (type === 'star') {
      session.stars++;
      const sp = participants.find(p => p.id === session.speakerId);
      if (sp) sp.totalStars++;
    }
    session.votes.set(vid, { type, locked });

    socket.emit('vote_ok', { type, locked });
    broadcast();
  });

  // ── cancel vote ──────────────────────────────────────────────────────────
  socket.on('cancel_vote', () => {
    if (session?.phase !== 'voting') return;
    const vid = socket.participantId;
    if (!vid) return;
    const prev = session.votes.get(vid);
    if (!prev || prev.locked) return;

    if (prev.type === 'star') {
      session.stars = Math.max(0, session.stars - 1);
      const sp = participants.find(p => p.id === session.speakerId);
      if (sp) sp.totalStars = Math.max(0, sp.totalStars - 1);
    }
    session.usedCancel.add(vid); // запомнить — отмена использована
    session.votes.delete(vid);
    socket.emit('vote_cancelled');
    broadcast();
  });

  // ── admin: kick participant ───────────────────────────────────────────────
  socket.on('kick', ({ participantId }) => {
    if (session?.votes.has(participantId)) {
      const v = session.votes.get(participantId);
      if (v.type === 'star') {
        session.stars = Math.max(0, session.stars - 1);
        const sp = participants.find(p => p.id === session.speakerId);
        if (sp) sp.totalStars = Math.max(0, sp.totalStars - 1);
      }
      session.votes.delete(participantId);
    }
    if (session?.speakerId === participantId) session = null;
    participants = participants.filter(p => p.id !== participantId);
    broadcast();
  });

  // ── admin: full reset ────────────────────────────────────────────────────
  socket.on('reset_all', () => {
    participants = [];
    session = null;
    io.emit('full_reset');
  });

  // ── admin: объявить победителя ────────────────────────────────────────────
  socket.on('show_winner', () => {
    if (participants.length === 0) return;
    const winner = [...participants].sort((a, b) => b.totalStars - a.totalStars)[0];
    io.emit('show_winner', { winner });
  });
});

// ─── Стабильность: не падать на необработанных ошибках ───────────────────────
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', reason => {
  console.error('[unhandledRejection]', reason);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 38475;

server.once('error', err => {
  if (err.code === 'EADDRINUSE')
    console.error(`\n  Порт ${PORT} занят.\n  Запустите с другим: $env:PORT=9000; node server.js\n`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIPs();
  const primary = ips[0]?.ip ?? 'localhost';
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║       БАЛЫ — Сервер запущен          ║');
  console.log('  ╚══════════════════════════════════════╝\n');
  console.log('  Для коллег в одной Wi‑Fi сети:');
  console.log(`    Участники:  http://${primary}:${PORT}`);
  console.log(`    Экран:      http://${primary}:${PORT}/screen.html\n`);
  console.log('  На этом компьютере:');
  console.log(`    http://localhost:${PORT}`);
  console.log(`    http://localhost:${PORT}/screen.html\n`);
  if (ips.length > 1) {
    console.log('  Все адреса:');
    ips.forEach(({ ip, iface }) => console.log(`    ${ip}  (${iface})`));
    console.log();
  }
  console.log('  Ctrl+C — остановить\n');
});
