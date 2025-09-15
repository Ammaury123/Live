// server.js (updated)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// In-memory stores
let users = {}; // socketId -> { id, name, role, textColor, dp, blocked:[], status, lastSeen, uid }
let messages = []; // public messages (last MAX_HISTORY)
let dmRooms = {}; // room -> [ last messages (max 8) ]
let pendingMentions = {}; // lowerName -> [ mentionPayload... ]
let pinned = null; // pinned public message object
let reactions = {}; // msgId -> { emoji -> Set(usernames) }

const MAX_HISTORY = 8;
const MAX_DM_HISTORY = 8;

// ---------- Helpers ----------
function safeEmit(socketId, ev, payload) {
  try { io.to(socketId).emit(ev, payload); } catch (e) { console.error("emit err", e); }
}
function broadcastUsers() {
  try {
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
  } catch (e) { console.error("broadcastUsers err", e); }
}
function sendHistory(socketId) {
  try {
    safeEmit(socketId, "chat-history", messages.slice(-MAX_HISTORY));
    if (pinned) safeEmit(socketId, "pinned", pinned);
  } catch (e) { console.error("sendHistory err", e); }
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
function ensureReactionSlot(msgId) {
  if (!reactions[msgId]) reactions[msgId] = {};
}
function reactionSummary(msgId) {
  const map = reactions[msgId] || {};
  const summary = {};
  for (const emoji in map) summary[emoji] = map[emoji].size || 0;
  return summary;
}
function reactionDetailForAdmin(msgId) {
  const map = reactions[msgId] || {};
  const detail = {};
  for (const emoji in map) detail[emoji] = Array.from(map[emoji]);
  return detail;
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

  // default skeleton user
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

  // broadcast presence
  broadcastUsers();

  // Client calls 'join' with profile data
  socket.on("join", (payload = {}) => {
    try {
      const { name, role, textColor, dp, uid } = payload || {};
      users[socket.id] = {
        ...users[socket.id],
        uid: uid || users[socket.id].uid || null,
        name: (name && String(name)) || users[socket.id].name,
        dp: dp || users[socket.id].dp || null,
        role: (role || users[socket.id].role || "user"),
        textColor: (textColor || users[socket.id].textColor || "#111111"),
        status: "online",
        blocked: users[socket.id].blocked || [],
        lastSeen: new Date().toISOString()
      };

      // send last messages + pinned to this socket
      sendHistory(socket.id);

      // deliver pending mentions (case-insensitive)
      const unameLc = (users[socket.id].name || "").toLowerCase();
      if (pendingMentions[unameLc] && pendingMentions[unameLc].length) {
        pendingMentions[unameLc].forEach(m => safeEmit(socket.id, "mention", m));
        delete pendingMentions[unameLc];
      }

      broadcastUsers();
      console.log("👤 joined:", users[socket.id].name);
    } catch (err) {
      console.error("join err:", err);
    }
  });

  // public chat message
  socket.on("chat message", (payload) => {
    try {
      const user = users[socket.id];
      if (!user) return;
      const text = (typeof payload === "string") ? payload : (payload.text || "");
      if (!text || !String(text).trim()) return;

      // handle @online special token anywhere (send online list back to sender)
      if (/\B@online\b/i.test(text)) {
        // list current online user names
        const onlineList = Object.values(users)
          .filter(u => u.status === "online")
          .map(u => u.name);
        safeEmit(socket.id, "online-list", onlineList);
        // still continue to broadcast message normally if wanted
      }

      const msg = createMsgObj(user, String(text).slice(0, 10000)); // sanitize length
      messages.push(msg);
      if (messages.length > MAX_HISTORY) messages = messages.slice(-MAX_HISTORY);

      // parse mentions: tokens starting with @username (allow punctuation trimmed)
      const tokens = String(text).split(/\s+/);
      tokens.forEach((tok, idx) => {
        if (tok.startsWith("@") && tok.length > 1) {
          const raw = tok.slice(1).replace(/[^A-Za-z0-9_\-\.]/g, "");
          if (!raw) return;
          const next = tokens[idx + 1] ? tokens[idx + 1].toLowerCase() : "";
          if (next === "dm") {
            // DM invite
            findSocketsByNameInsensitive(raw).forEach(sid => safeEmit(sid, "dm-invite", { from: user.name }));
          } else if (raw.toLowerCase() === "online") {
            // handled above
          } else {
            // normal mention: deliver or store pending (case-insensitive)
            const mentionPayload = { id: uuidv4(), from: user.name, text, ts: Date.now(), rawMsgId: msg.id };
            const sids = findSocketsByNameInsensitive(raw);
            if (sids.length > 0) {
              sids.forEach(sid => safeEmit(sid, "mention", mentionPayload));
            } else {
              const lc = raw.toLowerCase();
              if (!pendingMentions[lc]) pendingMentions[lc] = [];
              pendingMentions[lc].push(mentionPayload);
              if (pendingMentions[lc].length > 100) pendingMentions[lc] = pendingMentions[lc].slice(-100);
            }
          }
        }
      });

      // Broadcast to everyone but respect block lists (mutual block hides from each other)
      for (let sid in users) {
        const recip = users[sid];
        // admin sees everything
        if (user.role !== "admin" && recip.role !== "admin") {
          if ((recip.blocked || []).includes(user.name)) continue;
          if ((user.blocked || []).includes(recip.name)) continue;
        }
        safeEmit(sid, "chat message", msg);
      }
    } catch (err) {
      console.error("chat message err:", err);
    }
  });

  // delete public message (sender or admin)
  socket.on("delete", ({ msgId } = {}) => {
    try {
      const user = users[socket.id];
      if (!user) return;
      const idx = messages.findIndex(m => m.id === msgId);
      if (idx === -1) {
        io.emit("delete", { msgId });
        return;
      }
      const m = messages[idx];
      if (user.role === "admin" || m.rawName === user.name) {
        messages.splice(idx, 1);
        delete reactions[msgId];
        io.emit("delete", { msgId });
      } else {
        safeEmit(socket.id, "system", { text: "❌ You cannot delete this message." });
      }
    } catch (err) { console.error("delete err:", err); }
  });

  // block user
  socket.on("block", (targetName) => {
    try {
      const user = users[socket.id];
      if (!user || !targetName) return;
      if (targetName === user.name) {
        safeEmit(socket.id, "system", { text: "❌ You cannot block yourself." });
        return;
      }
      if (!user.blocked.includes(targetName)) user.blocked.push(targetName);

      // add reciprocal block for all sockets of that name
      for (let sid in users) {
        if (users[sid].name === targetName) {
          if (!users[sid].blocked.includes(user.name)) users[sid].blocked.push(user.name);
        }
      }

      safeEmit(socket.id, "blocklist", user.blocked);
      broadcastUsers();
    } catch (err) { console.error("block err:", err); }
  });

  socket.on("unblock", (targetName) => {
    try {
      const user = users[socket.id];
      if (!user) return;
      user.blocked = (user.blocked || []).filter(n => n !== targetName);
      for (let sid in users) {
        if (users[sid].name === targetName) {
          users[sid].blocked = (users[sid].blocked || []).filter(n => n !== user.name);
        }
      }
      safeEmit(socket.id, "blocklist", user.blocked);
      broadcastUsers();
    } catch (err) { console.error("unblock err:", err); }
  });

  // DM invite (explicit)
  socket.on("dm-invite", ({ toName } = {}) => {
    try {
      const sender = users[socket.id];
      if (!sender || !toName) return;
      findSocketsByNameInsensitive(toName).forEach(sid => safeEmit(sid, "dm-invite", { from: sender.name }));
    } catch (err) { console.error("dm-invite err:", err); }
  });

  // DM response (accept/reject)
  socket.on("dm-response", ({ fromName, accepted } = {}) => {
    try {
      const target = users[socket.id];
      if (!target || !fromName) return;
      // find sender sockets
      for (let sid in users) {
        if (users[sid].name === fromName) {
          if (accepted) {
            const room = ["dm", fromName, target.name].sort().join("_");
            // join both sockets (target already on this socket)
            socket.join(room);
            io.sockets.sockets.get(sid)?.join(room);
            // ensure a DM room store exists
            ensureDmRoom(room);
            // emit dm-start to the room with room id and last messages
            io.to(room).emit("dm-start", { room, users: [fromName, target.name], history: dmRooms[room].slice(-MAX_DM_HISTORY) });
          } else {
            safeEmit(sid, "system", { text: `${target.name} rejected your DM request.` });
          }
        }
      }
    } catch (err) { console.error("dm-response err:", err); }
  });

  // DM message within a room
  socket.on("dm-message", ({ room, text } = {}) => {
    try {
      const sender = users[socket.id];
      if (!sender || !room || !text) return;
      const payload = { id: uuidv4(), from: sender.name, text, dp: sender.dp || null, ts: Date.now() };
      // store in dm room history
      pushDmMessage(room, payload);
      // emit to room
      io.to(room).emit("dm-message", payload);
    } catch (err) { console.error("dm-message err:", err); }
  });

  // DM typing indicator
  socket.on("typing", ({ room, isTyping } = {}) => {
    try {
      if (!room) return;
      const u = users[socket.id];
      if (!u) return;
      io.to(room).emit("typing", { room, from: u.name, isTyping: !!isTyping });
    } catch (err) { console.error("typing err:", err); }
  });

  // DM seen
  socket.on("seen", ({ room, from } = {}) => {
    try {
      if (!room) return;
      const u = users[socket.id];
      if (!u) return;
      io.to(room).emit("dm-seen", { room, from: u.name, ts: Date.now() });
    } catch (err) { console.error("seen err:", err); }
  });

  // Reaction (can be used for public messages or DM messages; client provides msgId)
  socket.on("reaction", ({ msgId, emoji } = {}) => {
    try {
      const user = users[socket.id];
      if (!user || !msgId || !emoji) return;
      ensureReactionSlot(msgId);
      // initialize set if needed
      if (!reactions[msgId][emoji]) reactions[msgId][emoji] = new Set();
      const emojiSet = reactions[msgId][emoji];
      if (emojiSet.has(user.name)) {
        emojiSet.delete(user.name);
      } else {
        emojiSet.add(user.name);
      }
      // store back
      reactions[msgId][emoji] = emojiSet;

      // broadcast summary to all clients
      io.emit("reaction", { msgId, summary: reactionSummary(msgId) });

      // send detailed list only to admins
      const detail = reactionDetailForAdmin(msgId);
      for (let sid in users) {
        if (users[sid].role === "admin") safeEmit(sid, "reaction-detail", { msgId, detail });
      }
    } catch (err) { console.error("reaction err:", err); }
  });

  // Pin a message (admin only)
  socket.on("pin", ({ msgId } = {}) => {
    try {
      const user = users[socket.id];
      if (!user || user.role !== "admin") return;
      const msg = messages.find(m => m.id === msgId);
      if (msg) {
        pinned = msg;
        io.emit("pinned", pinned);
      }
    } catch (err) { console.error("pin err:", err); }
  });

  // request history
  socket.on("get-history", () => sendHistory(socket.id));

  // request dm-room history (client can call with room)
  socket.on("get-dm-history", ({ room } = {}) => {
    try {
      if (!room) return;
      ensureDmRoom(room);
      safeEmit(socket.id, "dm-history", { room, history: dmRooms[room].slice(-MAX_DM_HISTORY) });
    } catch (err) { console.error("get-dm-history err:", err); }
  });

  // get blocklist
  socket.on("get-blocklist", () => safeEmit(socket.id, "blocklist", users[socket.id].blocked || []));

  // disconnect
  socket.on("disconnect", (reason) => {
    try {
      if (users[socket.id]) {
        users[socket.id].lastSeen = new Date().toISOString();
        users[socket.id].status = "offline";
        console.log("❌ disconnected:", users[socket.id].name, "reason:", reason);
        delete users[socket.id];
        broadcastUsers();
      }
    } catch (err) { console.error("disconnect err:", err); }
  });
});

// Base routes for health check
app.get("/", (req, res) => res.send("🚀 Live Chat Backend ✅"));
app.get("/health", (req, res) => res.json({ ok: true, users: Object.keys(users).length }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
