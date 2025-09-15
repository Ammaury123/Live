// server.js (fixed + improved)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// In-memory stores
let users = {};         // socketId -> { id, name, role, textColor, dp, blocked:[], status, lastSeen, uid }
let messages = [];      // public messages (keep last MAX_HISTORY)
let dmRooms = {};       // room -> [ messages (MAX_DM_HISTORY) ]
let pendingMentions = {}; // lowercaseName -> [ mentionPayload... ]
let pinned = null;
let reactions = {};     // global msgId -> { emoji -> Set(usernames) }
let dmReactions = {};   // room -> { msgId -> { emoji -> Set(usernames) } }

const MAX_HISTORY = 8;
const MAX_DM_HISTORY = 8;

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
    lastSeen: u.lastSeen || null,
    blocked: u.blocked || []
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

function ensureReactionSlot(msgId) {
  if (!reactions[msgId]) reactions[msgId] = {};
}
function ensureDmReactionSlot(room, msgId) {
  if (!dmReactions[room]) dmReactions[room] = {};
  if (!dmReactions[room][msgId]) dmReactions[room][msgId] = {};
}
function reactionSummaryForMap(map) {
  const summary = {};
  for (const emoji in map) summary[emoji] = (map[emoji] && map[emoji].size) || 0;
  return summary;
}
function reactionDetailForAdmin(map) {
  const detail = {};
  for (const emoji in map) detail[emoji] = Array.from(map[emoji] || []);
  return detail;
}

// Socket handlers
io.on("connection", (socket) => {
  console.log("✅ socket connected:", socket.id);

  // default guest
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

  // broadcast initial presence
  broadcastUsers();

  // join with profile
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

      // send history + pinned
      sendHistory(socket.id);

      // deliver pending mentions for this user (case-insensitive)
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

  // public chat
  socket.on("chat message", (payload) => {
    try {
      const user = users[socket.id];
      if (!user) return;
      const text = (typeof payload === "string") ? payload : (payload.text || "");
      if (!text || !String(text).trim()) return;

      // special token @online
      if (/\B@online\b/i.test(text)) {
        const onlineList = Object.values(users).filter(u => u.status === "online").map(u => u.name);
        safeEmit(socket.id, "online-list", onlineList);
      }

      const msg = createMsgObj(user, String(text).slice(0, 10000));
      messages.push(msg);
      if (messages.length > MAX_HISTORY) messages = messages.slice(-MAX_HISTORY);

      // parse mentions and dm-invite
      const tokens = String(text).split(/\s+/);
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
            if (sids.length > 0) sids.forEach(sid => safeEmit(sid, "mention", mentionPayload));
            else {
              const lc = raw.toLowerCase();
              pendingMentions[lc] = pendingMentions[lc] || [];
              pendingMentions[lc].push(mentionPayload);
              if (pendingMentions[lc].length > 100) pendingMentions[lc] = pendingMentions[lc].slice(-100);
            }
          }
        }
      });

      // broadcast respecting blocks
      for (let sid in users) {
        const recip = users[sid];
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

  // delete public
  socket.on("delete", ({ msgId } = {}) => {
    try {
      const user = users[socket.id];
      if (!user) return;
      const idx = messages.findIndex(m => m.id === msgId);
      if (idx === -1) {
        // still notify clients to remove locally if they want
        io.emit("delete", { msgId });
        return;
      }
      const m = messages[idx];
      if (user.role === "admin" || m.rawName === user.name) {
        messages.splice(idx, 1);
        // cleanup reactions
        delete reactions[msgId];
        io.emit("delete", { msgId });
      } else {
        safeEmit(socket.id, "system", { text: "❌ You cannot delete this message." });
      }
    } catch (err) { console.error("delete err:", err); }
  });

  // block / unblock
  socket.on("block", (targetName) => {
    try {
      const user = users[socket.id];
      if (!user || !targetName) return;
      if (targetName === user.name) { safeEmit(socket.id, "system", { text: "❌ You cannot block yourself." }); return; }
      if (!user.blocked.includes(targetName)) user.blocked.push(targetName);
      // reciprocal block for other sockets with same name
      for (let sid in users) {
        if ((users[sid].name || "") === targetName) {
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

  // dm-response (accept/reject) -> join both sockets to same room
  socket.on("dm-response", ({ fromName, accepted } = {}) => {
    try {
      const target = users[socket.id];
      if (!target || !fromName) return;
      for (let sid in users) {
        if (users[sid].name === fromName) {
          if (accepted) {
            const room = ["dm", fromName, target.name].sort().join("_");
            // join both sockets
            socket.join(room);
            io.sockets.sockets.get(sid)?.join(room);

            ensureDmRoom(room);

            // optionally: add admins to room so they can moderate (if you want)
            for (let aid in users) {
              if (users[aid].role === "admin") io.sockets.sockets.get(aid)?.join(room);
            }

            // send dm-start to both participants (via room). include history
            io.to(room).emit("dm-start", { room, users: [fromName, target.name], history: dmRooms[room].slice(-MAX_DM_HISTORY) });
          } else {
            safeEmit(sid, "system", { text: `${target.name} rejected your DM.` });
          }
        }
      }
    } catch (err) { console.error("dm-response err:", err); }
  });

  // DM message
  socket.on("dm-message", ({ room, text } = {}) => {
    try {
      const sender = users[socket.id];
      if (!sender || !room || !text) return;
      const payload = { id: uuidv4(), from: sender.name, text, ts: Date.now() };
      pushDmMessage(room, payload);
      io.to(room).emit("dm-message", payload);
    } catch (err) { console.error("dm-message err:", err); }
  });

  // DM delete (sender or admin)
  socket.on("dm-delete", ({ room, msgId } = {}) => {
    try {
      if (!room || !msgId) return;
      const user = users[socket.id];
      if (!user) return;
      // Allow admin or the message owner to delete
      const arr = dmRooms[room] || [];
      const idx = arr.findIndex(m => m.id === msgId);
      if (idx === -1) {
        io.to(room).emit("dm-delete", { msgId }); // still notify clients
        return;
      }
      const m = arr[idx];
      if (user.role === "admin" || m.from === user.name) {
        dmRooms[room] = arr.filter(x => x.id !== msgId);
        // cleanup dmReactions for this message
        if (dmReactions[room] && dmReactions[room][msgId]) delete dmReactions[room][msgId];
        io.to(room).emit("dm-delete", { msgId });
      } else {
        safeEmit(socket.id, "system", { text: "❌ You cannot delete this DM message." });
      }
    } catch (err) { console.error("dm-delete err:", err); }
  });

  // DM reaction (toggle by username)
  socket.on("dm-reaction", ({ room, msgId, emoji } = {}) => {
    try {
      const user = users[socket.id];
      if (!user || !room || !msgId || !emoji) return;
      ensureDmReactionSlot(room, msgId);
      const map = dmReactions[room][msgId];
      if (!map[emoji]) map[emoji] = new Set();
      if (map[emoji].has(user.name)) map[emoji].delete(user.name);
      else map[emoji].add(user.name);
      const summary = reactionSummaryForMap(map);
      io.to(room).emit("dm-reaction", { msgId, summary });
      // admin detail
      const detail = reactionDetailForAdmin(map);
      for (let sid in users) if (users[sid].role === "admin") safeEmit(sid, "reaction-detail", { room, msgId, detail });
    } catch (err) { console.error("dm-reaction err:", err); }
  });

  // global/public reaction (toggle)
  socket.on("reaction", ({ msgId, emoji } = {}) => {
    try {
      const user = users[socket.id];
      if (!user || !msgId || !emoji) return;
      ensureReactionSlot(msgId);
      if (!reactions[msgId][emoji]) reactions[msgId][emoji] = new Set();
      if (reactions[msgId][emoji].has(user.name)) reactions[msgId][emoji].delete(user.name);
      else reactions[msgId][emoji].add(user.name);
      const summary = reactionSummaryForMap(reactions[msgId]);
      io.emit("reaction", { msgId, summary });
      // admin detail
      const detail = reactionDetailForAdmin(reactions[msgId]);
      for (let sid in users) if (users[sid].role === "admin") safeEmit(sid, "reaction-detail", { msgId, detail });
    } catch (err) { console.error("reaction err:", err); }
  });

  // typing in DM room
  socket.on("typing", ({ room, isTyping } = {}) => {
    try {
      const u = users[socket.id];
      if (!room || !u) return;
      io.to(room).emit("typing", { from: u.name, isTyping: !!isTyping });
    } catch (err) { console.error("typing err:", err); }
  });

  // seen in DM room
  socket.on("seen", ({ room } = {}) => {
    try {
      const u = users[socket.id];
      if (!room || !u) return;
      io.to(room).emit("dm-seen", { from: u.name, ts: Date.now() });
    } catch (err) { console.error("seen err:", err); }
  });

  // request dm history
  socket.on("get-dm-history", ({ room } = {}) => {
    try {
      if (!room) return;
      ensureDmRoom(room);
      safeEmit(socket.id, "dm-history", { room, history: dmRooms[room].slice(-MAX_DM_HISTORY) });
    } catch (err) { console.error("get-dm-history err:", err); }
  });

  // get blocklist
  socket.on("get-blocklist", () => {
    try { safeEmit(socket.id, "blocklist", users[socket.id].blocked || []); } catch (e) {}
  });

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

// health routes
app.get("/", (req, res) => res.send("🚀 Live Chat Backend ✅"));
app.get("/health", (req, res) => res.json({ ok: true, users: Object.keys(users).length }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
