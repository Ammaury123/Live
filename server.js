// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// In-memory stores
let users = {}; // socketId -> user
let badwords = [];
let messages = [];
let pendingMentions = {};
let pinned = null; // नया फीचर: pinned message

const MAX_HISTORY = 8;

// Helpers
function broadcastUsers() {
  const list = Object.values(users).map(u => ({
    id: u.id,
    name: u.name,
    role: u.role,
    textColor: u.textColor || "#000",
    status: u.status || "offline",
    blocked: u.blocked || []
  }));
  io.emit("users", list);
}

function sendHistory(socket) {
  socket.emit("chat-history", messages);
  if (pinned) socket.emit("pinned", pinned); // pinned भी भेजो
}

function findSocketsByNameInsensitive(name) {
  const ids = [];
  if (!name) return ids;
  const lower = name.toLowerCase();
  for (let sid in users) {
    if ((users[sid].name || "").toLowerCase() === lower) ids.push(sid);
  }
  return ids;
}

function createMsgObj(user, text) {
  return {
    id: uuidv4(),
    name: user.role === "admin" ? `🛡️ Admin (${user.name})` : user.name,
    rawName: user.name,
    text,
    role: user.role,
    textColor: user.textColor || "#000",
    dp: user.dp || null,
    ts: Date.now()
  };
}

// ========== SOCKET.IO ==========
io.on("connection", socket => {
  console.log("✅ User connected:", socket.id);

  users[socket.id] = {
    id: socket.id,
    name: "Guest" + Math.floor(Math.random() * 10000),
    role: "user",
    textColor: "#111",
    dp: null,
    blocked: [],
    status: "online"
  };

  broadcastUsers();

  socket.on("join", payload => {
    const { name, role, textColor, dp, uid } = payload || {};
    users[socket.id] = {
      ...users[socket.id],
      uid: uid || null,
      name: name || users[socket.id].name,
      dp: dp || null,
      role: role || "user",
      textColor: textColor || "#111",
      status: "online",
      blocked: users[socket.id].blocked || []
    };

    sendHistory(socket);

    // pending mentions भेज दो
    const unameLc = (users[socket.id].name || "").toLowerCase();
    if (pendingMentions[unameLc] && pendingMentions[unameLc].length) {
      pendingMentions[unameLc].forEach(m => socket.emit("mention", m));
      delete pendingMentions[unameLc];
    }

    broadcastUsers();
    console.log("👤 Joined:", users[socket.id].name);
  });

  // Public message
  socket.on("chat message", payload => {
    const user = users[socket.id];
    if (!user) return;
    const text = typeof payload === "string" ? payload : (payload.text || "");
    if (!text.trim()) return;

    const msg = createMsgObj(user, text);
    messages.push(msg);
    if (messages.length > MAX_HISTORY) messages = messages.slice(-MAX_HISTORY);

    // Mentions
    const tokens = text.split(/\s+/);
    tokens.forEach((tok, idx) => {
      if (tok.startsWith("@") && tok.length > 1) {
        const raw = tok.slice(1);
        const next = tokens[idx + 1] ? tokens[idx + 1].toLowerCase() : "";
        if (next === "dm") {
          findSocketsByNameInsensitive(raw).forEach(sid =>
            io.to(sid).emit("dm-invite", { from: user.name })
          );
        } else {
          const mentionPayload = { from: user.name, text, ts: Date.now() };
          const sids = findSocketsByNameInsensitive(raw);
          if (sids.length > 0) {
            sids.forEach(sid => io.to(sid).emit("mention", mentionPayload));
          } else {
            const lc = raw.toLowerCase();
            if (!pendingMentions[lc]) pendingMentions[lc] = [];
            pendingMentions[lc].push(mentionPayload);
          }
        }
      }
    });

    // Broadcast to everyone (respect block)
    for (let sid in users) {
      const recip = users[sid];
      if (recip.blocked.includes(user.name)) continue;
      if (user.blocked.includes(recip.name)) continue;
      io.to(sid).emit("chat message", msg);
    }
  });

  // Delete
  socket.on("delete", ({ msgId }) => {
    const user = users[socket.id];
    if (!user) return;
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    const msg = messages[idx];
    if (user.role === "admin" || msg.rawName === user.name) {
      messages.splice(idx, 1);
      io.emit("delete", { msgId });
    }
  });

  // Block
  socket.on("block", targetName => {
    const user = users[socket.id];
    if (!user) return;
    if (!user.blocked.includes(targetName)) user.blocked.push(targetName);
    for (let sid in users) {
      if (users[sid].name === targetName) {
        if (!users[sid].blocked.includes(user.name))
          users[sid].blocked.push(user.name);
      }
    }
    io.to(socket.id).emit("blocklist", user.blocked);
    broadcastUsers();
  });

  socket.on("unblock", targetName => {
    const user = users[socket.id];
    if (!user) return;
    user.blocked = user.blocked.filter(n => n !== targetName);
    for (let sid in users) {
      if (users[sid].name === targetName) {
        users[sid].blocked = users[sid].blocked.filter(n => n !== user.name);
      }
    }
    io.to(socket.id).emit("blocklist", user.blocked);
    broadcastUsers();
  });

  // DM invite/response/message
  socket.on("dm-invite", ({ toName }) => {
    const sender = users[socket.id];
    if (!sender) return;
    findSocketsByNameInsensitive(toName).forEach(sid =>
      io.to(sid).emit("dm-invite", { from: sender.name })
    );
  });

  socket.on("dm-response", ({ fromName, accepted }) => {
    const target = users[socket.id];
    if (!target) return;
    for (let sid in users) {
      if (users[sid].name === fromName) {
        if (accepted) {
          const room = ["dm", fromName, target.name].sort().join("_");
          socket.join(room);
          io.sockets.sockets.get(sid)?.join(room);
          io.to(room).emit("dm-start", { room, users: [fromName, target.name] });
        } else {
          io.to(sid).emit("system", {
            text: `${target.name} rejected your DM request.`
          });
        }
      }
    }
  });

  socket.on("dm-message", ({ room, text }) => {
    const sender = users[socket.id];
    if (!sender || !room) return;
    const msgId = uuidv4();
    const payload = { id: msgId, from: sender.name, text, ts: Date.now() };
    io.to(room).emit("dm-message", payload);
  });

  // ====== नया फीचर: Reaction ======
  socket.on("reaction", ({ msgId, emoji }) => {
    const user = users[socket.id];
    if (!user) return;
    io.emit("reaction", { msgId, emoji, from: user.name });
  });

  // ====== नया फीचर: Pin ======
  socket.on("pin", ({ msgId }) => {
    const user = users[socket.id];
    if (!user || user.role !== "admin") return;
    const msg = messages.find(m => m.id === msgId);
    if (msg) {
      pinned = msg;
      io.emit("pinned", pinned);
    }
  });

  socket.on("disconnect", () => {
    if (users[socket.id]) {
      console.log("❌ Disconnected:", users[socket.id].name);
      delete users[socket.id];
      broadcastUsers();
    }
  });
});

// Base route
app.get("/", (req, res) => {
  res.send("🚀 Live Chat Backend ✅ with Mentions + DM + Block + Delete + Reaction + Pin");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
