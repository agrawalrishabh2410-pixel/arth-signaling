/**
 * ═══════════════════════════════════════════════════════════════
 *  ARTH NOVA — Real-Time Signaling Server
 *  WebRTC call signaling + messaging + presence via Socket.IO
 * ═══════════════════════════════════════════════════════════════
 *
 *  Usage:
 *    npm install
 *    npm start          (default port 3001)
 *    PORT=8080 npm start (custom port)
 *
 *  The ERP frontend connects to this server for:
 *    - WebRTC call signaling (offer / answer / ICE candidates)
 *    - Call lifecycle (ring, accept, reject, hangup, timeout)
 *    - Instant messaging relay
 *    - Typing indicators & read receipts
 *    - User presence (online / offline / busy)
 */

const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      users: users.size,
      uptime: process.uptime()
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Arth Nova Signaling Server');
});

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 30000,
  pingInterval: 10000
});

// ── User Tracking ──────────────────────────────────────────────
const users = new Map();        // socketId → { userId, name, role, color, status, entityId }
const nameToSocket = new Map(); // userName → socketId (reverse lookup)

function getOnlineUsers() {
  return Array.from(users.values()).map(u => ({
    name: u.name,
    role: u.role,
    color: u.color,
    status: u.status,
    entityId: u.entityId
  }));
}

function getSocketForUser(name) {
  const sid = nameToSocket.get(name);
  return sid || null;
}

function log(event, detail) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${event}: ${detail}`);
}

// ── Socket.IO Event Handling ───────────────────────────────────
io.on('connection', (socket) => {
  log('CONNECT', socket.id);

  // ── Registration ─────────────────────────────────────────────
  socket.on('register', ({ userId, name, role, color, entityId }) => {
    if (!name) return;

    // If this user was already connected with a different socket, clean up old one
    const oldSid = nameToSocket.get(name);
    if (oldSid && oldSid !== socket.id) {
      users.delete(oldSid);
    }

    users.set(socket.id, {
      userId: userId || name,
      name,
      role: role || 'member',
      color: color || '#0fd4b8',
      status: 'available',
      entityId: entityId || null
    });
    nameToSocket.set(name, socket.id);

    log('REGISTER', `${name} (${role || 'member'})`);

    // Broadcast updated presence to all
    io.emit('users:online', getOnlineUsers());
  });

  // ── Call Signaling ───────────────────────────────────────────

  // Step 1: Caller sends offer (also handles mid-call renegotiation)
  socket.on('call:offer', ({ to, offer, callType, isRenegotiation }) => {
    const caller = users.get(socket.id);
    if (!caller) return;

    const targetSid = getSocketForUser(to);
    if (!targetSid) {
      socket.emit('call:user-offline', { target: to });
      log('CALL', `${caller.name} → ${to} (OFFLINE)`);
      return;
    }

    // If this is a renegotiation (e.g. switch to video mid-call), skip busy check
    if (isRenegotiation) {
      log('RENEGOTIATE', `${caller.name} → ${to} (${callType})`);
      io.to(targetSid).emit('call:incoming', {
        from: caller.name,
        offer,
        callType: callType || 'audio',
        isRenegotiation: true,
        callerInfo: {
          name: caller.name,
          role: caller.role,
          color: caller.color
        }
      });
      return;
    }

    // Check if target is busy (only for NEW calls, not renegotiation)
    const target = users.get(targetSid);
    if (target && target.status === 'busy') {
      socket.emit('call:user-busy', { target: to });
      log('CALL', `${caller.name} → ${to} (BUSY)`);
      return;
    }

    log('CALL', `${caller.name} → ${to} (${callType})`);

    io.to(targetSid).emit('call:incoming', {
      from: caller.name,
      offer,
      callType: callType || 'audio',
      callerInfo: {
        name: caller.name,
        role: caller.role,
        color: caller.color
      }
    });
  });

  // Step 2: Callee sends answer
  socket.on('call:answer', ({ to, answer }) => {
    const callee = users.get(socket.id);
    if (!callee) return;

    const targetSid = getSocketForUser(to);
    if (targetSid) {
      io.to(targetSid).emit('call:answered', {
        from: callee.name,
        answer
      });

      // Set both users as busy
      callee.status = 'busy';
      const caller = users.get(targetSid);
      if (caller) caller.status = 'busy';
      io.emit('users:online', getOnlineUsers());

      log('CALL-ANSWER', `${callee.name} accepted call from ${to}`);
    }
  });

  // Step 3: ICE candidate exchange (bidirectional)
  socket.on('call:ice-candidate', ({ to, candidate }) => {
    const targetSid = getSocketForUser(to);
    if (targetSid) {
      io.to(targetSid).emit('call:ice-candidate', {
        from: users.get(socket.id)?.name,
        candidate
      });
    }
  });

  // Caller/Callee rejects
  socket.on('call:reject', ({ to, message }) => {
    const user = users.get(socket.id);
    const targetSid = getSocketForUser(to);
    if (targetSid) {
      io.to(targetSid).emit('call:rejected', {
        by: user?.name || 'Unknown',
        message: message || ''
      });
      log('CALL-REJECT', `${user?.name} declined call from ${to}${message ? ': ' + message : ''}`);
    }
  });

  // Either side hangs up
  socket.on('call:hangup', ({ to }) => {
    const user = users.get(socket.id);
    const targetSid = getSocketForUser(to);

    // Reset status for both parties
    if (user) user.status = 'available';
    if (targetSid) {
      const target = users.get(targetSid);
      if (target) target.status = 'available';
      io.to(targetSid).emit('call:ended', { by: user?.name });
    }

    io.emit('users:online', getOnlineUsers());
    log('CALL-HANGUP', `${user?.name} ended call with ${to}`);
  });

  // ── Screen share & Remote control ──────────────────────────
  ['call:screen-share','call:control-request','call:control-grant','call:control-deny','call:control-release','call:control-click','call:control-move'].forEach(evt=>{
    socket.on(evt, (data) => {
      const user = users.get(socket.id);
      const targetSid = getSocketForUser(data.to);
      if (targetSid && user) {
        io.to(targetSid).emit(evt, { ...data, from: user.name });
      }
    });
  });

  // ── Renegotiation (switch to video mid-call) ─────────────
  socket.on('call:renegotiate', ({ to, offer }) => {
    const user = users.get(socket.id);
    const targetSid = getSocketForUser(to);
    if (targetSid && user) {
      io.to(targetSid).emit('call:renegotiate', { from: user.name, offer });
    }
  });

  // ── Messaging ────────────────────────────────────────────────

  socket.on('message:send', ({ to, message, chatKey }) => {
    const sender = users.get(socket.id);
    if (!sender) return;

    const targetSid = getSocketForUser(to);
    const payload = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      from: sender.name,
      text: message,
      chatKey: chatKey || ('dm_' + [sender.name, to].sort().join('__')),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      date: new Date().toLocaleDateString('en-IN')
    };

    if (targetSid) {
      io.to(targetSid).emit('message:received', payload);
    }
    // Also send back to sender for confirmation
    socket.emit('message:sent', payload);
  });

  socket.on('message:typing', ({ to, chatKey }) => {
    const sender = users.get(socket.id);
    const targetSid = getSocketForUser(to);
    if (targetSid && sender) {
      io.to(targetSid).emit('message:typing', {
        from: sender.name,
        chatKey: chatKey || ''
      });
    }
  });

  socket.on('message:seen', ({ to, messageIds, chatKey }) => {
    const sender = users.get(socket.id);
    const targetSid = getSocketForUser(to);
    if (targetSid && sender) {
      io.to(targetSid).emit('message:seen', {
        by: sender.name,
        messageIds: messageIds || [],
        chatKey: chatKey || ''
      });
    }
  });

  // ── Status Updates ───────────────────────────────────────────

  socket.on('status:update', ({ status }) => {
    const user = users.get(socket.id);
    if (user) {
      user.status = status;
      io.emit('users:online', getOnlineUsers());
      log('STATUS', `${user.name} → ${status}`);
    }
  });

  // ── Disconnect ───────────────────────────────────────────────

  socket.on('disconnect', (reason) => {
    const user = users.get(socket.id);
    if (user) {
      nameToSocket.delete(user.name);
      users.delete(socket.id);

      // Notify others this user went offline
      io.emit('users:online', getOnlineUsers());
      io.emit('user:disconnected', {
        name: user.name,
        reason
      });

      log('DISCONNECT', `${user.name} (${reason})`);
    }
  });
});

// ── Start Server ───────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   ARTH NOVA — Signaling Server           ║');
  console.log(`  ║   Running on port ${PORT}                    ║`);
  console.log('  ║   Ready for WebRTC calls & messaging     ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
