// server.js (final updated)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// In-memory stores
let users = {}; 
let messages = []; 
let dmRooms = {}; 
let pendingMentions = {}; 
let pinned = null; 
let reactions = {}; 

const MAX_HISTORY = 8;
const MAX_DM_HISTORY = 8;

// ---------- Helpers ----------
function safeEmit(socketId, ev, payload) {
  try { io.to(socketId).emit(ev, payload); } catch (e) { console.error("emit err", e); }
}
function broadcastUsers() {
  const list = Object.values(users).map(u => ({
    id: u.id,
    name: u.name,
    role: u.role,
    dp: u.dp || null,
    textColor: u.textColor || "#000000",
    status: u.status || "offline",
    lastSeen: u.lastSeen || null
  }));
  io.emit("users", list);
}
function sendHistory(socketId) {
  safeEmit(socketId, "chat-history", messages.slice(-MAX_HISTORY));
  if (pinned) safeEmit(socketId, "pinned", pinned);
}
function findSocketsByNameInsensitive(name) {
  const res = [];
  if (!name) return res;
  const lower = String(name).toLowerCase();
  for (let sid in users) {
    if ((users[sid].name || "").toLowerCase() === lower) res.push(sid);
  }
  return res;
}
function createMsgObj(user, text) {
  return {
    id: uuidv4(),
    name: user.role === "admin" ? `🛡️ Admin (${user.name})` : user.name,
    rawName: user.name,
    text,
    role: user.role,
    textColor: user.textColor || "#000000",
    dp: user.dp || null,
    ts: Date.now()
  };
}
function ensureDmRoom(room) {
  if (!dmRooms[room]) dmRooms[room] = [];
}
function pushDmMessage(room, msgObj) {
  ensureDmRoom(room);
  dmRooms[room].push(msgObj);
  if (dmRooms[room].length > MAX_DM_HISTORY) dmRooms[room] = dmRooms[room].slice(-MAX_DM_HISTORY);
}

// ---------- Socket handlers ----------
io.on("connection", (socket) => {
  console.log("✅ socket connected:", socket.id);

  users[socket.id] = {
    id: socket.id,
    name: "Guest" + Math.floor(Math.random() * 10000),
    role: "user",
    textColor: "#111111",
    dp: null,
    blocked: [],
    status: "online",
    lastSeen: new Date().toISOString()
  };

  broadcastUsers();

  // ---- Join ----
  socket.on("join", (payload = {}) => {
    const { name, role, textColor, dp, uid } = payload || {};
    users[socket.id] = {
      ...users[socket.id],
      uid: uid || null,
      name: name || users[socket.id].name,
      dp: dp || null,
      role: role || "user",
      textColor: textColor || "#111111",
      status: "online",
      blocked: users[socket.id].blocked || [],
      lastSeen: new Date().toISOString()
    };

    sendHistory(socket.id);

    const unameLc = (users[socket.id].name || "").toLowerCase();
    if (pendingMentions[unameLc]) {
      pendingMentions[unameLc].forEach(m => safeEmit(socket.id, "mention", m));
      delete pendingMentions[unameLc];
    }

    broadcastUsers();
    console.log("👤 joined:", users[socket.id].name);
  });

  // ---- Public message ----
  socket.on("chat message", (payload) => {
    const user = users[socket.id];
    if (!user) return;
    const text = (typeof payload === "string") ? payload : (payload.text || "");
    if (!text.trim()) return;

    if (/\B@online\b/i.test(text)) {
      const onlineList = Object.values(users)
        .filter(u => u.status === "online")
        .map(u => u.name);
      safeEmit(socket.id, "online-list", onlineList);
    }

    const msg = createMsgObj(user, text.slice(0, 1000));
    messages.push(msg);
    if (messages.length > MAX_HISTORY) messages = messages.slice(-MAX_HISTORY);

    // mention parsing
    const tokens = text.split(/\s+/);
    tokens.forEach((tok, idx) => {
      if (tok.startsWith("@") && tok.length > 1) {
        const raw = tok.slice(1).replace(/[^A-Za-z0-9_\-\.]/g, "");
        if (!raw) return;
        const next = tokens[idx + 1] ? tokens[idx + 1].toLowerCase() : "";
        if (next === "dm") {
          findSocketsByNameInsensitive(raw).forEach(sid => safeEmit(sid, "dm-invite", { from: user.name }));
        } else if (raw.toLowerCase() !== "online") {
          const mentionPayload = { id: uuidv4(), from: user.name, text, ts: Date.now(), rawMsgId: msg.id };
          const sids = findSocketsByNameInsensitive(raw);
          if (sids.length) {
            sids.forEach(sid => safeEmit(sid, "mention", mentionPayload));
          } else {
            const lc = raw.toLowerCase();
            pendingMentions[lc] = pendingMentions[lc] || [];
            pendingMentions[lc].push(mentionPayload);
          }
        }
      }
    });

    // broadcast with block check
    for (let sid in users) {
      const recip = users[sid];
      if (user.role !== "admin" && recip.role !== "admin") {
        if (recip.blocked.includes(user.name)) continue;
        if (user.blocked.includes(recip.name)) continue;
      }
      safeEmit(sid, "chat message", msg);
    }
  });

  // ---- Delete public ----
  socket.on("delete", ({ msgId } = {}) => {
    const user = users[socket.id];
    if (!user) return;
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    const m = messages[idx];
    if (user.role === "admin" || m.rawName === user.name) {
      messages.splice(idx, 1);
      io.emit("delete", { msgId });
    }
  });

  // ---- Block ----
  socket.on("block", (targetName) => {
    const user = users[socket.id];
    if (!user || !targetName || targetName === user.name) return;
    if (!user.blocked.includes(targetName)) user.blocked.push(targetName);
    for (let sid in users) {
      if (users[sid].name === targetName) {
        if (!users[sid].blocked.includes(user.name)) users[sid].blocked.push(user.name);
      }
    }
    safeEmit(socket.id, "blocklist", user.blocked);
    broadcastUsers();
  });

  socket.on("unblock", (targetName) => {
    const user = users[socket.id];
    if (!user) return;
    user.blocked = user.blocked.filter(n => n !== targetName);
    broadcastUsers();
  });

  // ---- DM handling ----
  socket.on("dm-response", ({ fromName, accepted } = {}) => {
    const target = users[socket.id];
    if (!target || !fromName) return;
    for (let sid in users) {
      if (users[sid].name === fromName) {
        if (accepted) {
          const room = ["dm", fromName, target.name].sort().join("_");
          socket.join(room);
          io.sockets.sockets.get(sid)?.join(room);

          ensureDmRoom(room);

          // ✅ Admins को भी DM room में join कराओ
          for (let aid in users) {
            if (users[aid].role === "admin") io.sockets.sockets.get(aid)?.join(room);
          }

          io.to(room).emit("dm-start", { room, users: [fromName, target.name], history: dmRooms[room] });
        } else {
          safeEmit(sid, "system", { text: `${target.name} rejected your DM.` });
        }
      }
    }
  });

  socket.on("dm-message", ({ room, text }) => {
    const sender = users[socket.id];
    if (!sender || !room || !text) return;
    const payload = { id: uuidv4(), from: sender.name, text, ts: Date.now() };
    pushDmMessage(room, payload);
    io.to(room).emit("dm-message", payload);
  });

  socket.on("dm-delete", ({ room, msgId }) => {
    if (!room || !msgId) return;
    dmRooms[room] = (dmRooms[room] || []).filter(m => m.id !== msgId);
    io.to(room).emit("dm-delete", { msgId });
  });

  socket.on("dm-reaction", ({ room, msgId, emoji }) => {
    if (!room || !msgId || !emoji) return;
    if (!reactions[room]) reactions[room] = {};
    if (!reactions[room][msgId]) reactions[room][msgId] = {};
    reactions[room][msgId][emoji] = (reactions[room][msgId][emoji] || 0) + 1;
    io.to(room).emit("dm-reaction", { msgId, summary: reactions[room][msgId] });
  });

  socket.on("typing", ({ room, isTyping }) => {
    const u = users[socket.id];
    if (!room || !u) return;
    io.to(room).emit("typing", { from: u.name, isTyping });
  });

  socket.on("seen", ({ room }) => {
    const u = users[socket.id];
    if (!room || !u) return;
    io.to(room).emit("dm-seen", { from: u.name, ts: Date.now() });
  });

  // ---- Disconnect ----
  socket.on("disconnect", () => {
    if (users[socket.id]) {
      users[socket.id].lastSeen = new Date().toISOString();
      users[socket.id].status = "offline";
      delete users[socket.id];
      broadcastUsers();
    }
  });
});

// ---- Base routes ----
app.get("/", (req, res) => res.send("🚀 Live Chat Backend ✅"));
app.get("/health", (req, res) => res.json({ ok: true, users: Object.keys(users).length }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
