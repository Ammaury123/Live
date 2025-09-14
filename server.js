// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// In-memory stores
let users = {}; // socketId -> { id, uid?, name, email, dp, role, textColor, lastSeen, blocked: [names], status }
let badwords = []; // simple array of bad words (lowercase)
let messages = []; // public messages (keep last 8)
let pendingMentions = {}; // username -> [ { from, text, ts } ] for offline mentions

const MAX_HISTORY = 8;

// helper: safe emit users list (without exposing internal socket internals)
function broadcastUsers() {
  try {
    const list = Object.values(users).map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      dp: u.dp || null,
      role: u.role,
      textColor: u.textColor || "#000000",
      status: u.status || "offline",
      blocked: u.blocked || []
    }));
    io.emit("users", list);
  } catch (e) {
    console.error("broadcastUsers error:", e);
  }
}

// helper: send chat history to a socket
function sendHistory(socket) {
  try {
    socket.emit("chat-history", messages);
  } catch (e) {
    console.error("sendHistory error:", e);
  }
}

// helper: find socket id(s) by username
function findSocketsByName(name) {
  const ids = [];
  for (let sid in users) {
    if (users[sid].name === name) ids.push(sid);
  }
  return ids;
}

// sanitize simple: check badwords
function containsBadword(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return badwords.some(w => w && t.includes(w));
}

// When a mention happens, deliver to online target(s) or store pending
function handleMention(targetName, fromName, text) {
  try {
    const sockets = findSocketsByName(targetName);
    const mentionPayload = { from: fromName, text, ts: Date.now() };

    if (sockets.length > 0) {
      // deliver to all sockets of that username (could be multiple devices)
      sockets.forEach(sid => {
        io.to(sid).emit("mention", mentionPayload);
      });
    } else {
      // offline -> store pending
      if (!pendingMentions[targetName]) pendingMentions[targetName] = [];
      pendingMentions[targetName].push(mentionPayload);
      // cap pending mentions per user to avoid memory blow (e.g., 50)
      if (pendingMentions[targetName].length > 50) {
        pendingMentions[targetName] = pendingMentions[targetName].slice(-50);
      }
    }
  } catch (e) {
    console.error("handleMention error:", e);
  }
}

// DM invite helper
function sendDmInvite(toName, fromName) {
  try {
    const sockets = findSocketsByName(toName);
    sockets.forEach(sid => io.to(sid).emit("dm-invite", { from: fromName }));
  } catch (e) {
    console.error("sendDmInvite error:", e);
  }
}

// message object creator
function createMsgObj(user, text) {
  return {
    id: uuidv4(),
    name: user.role === "admin" ? `🛡️ Admin (${user.name})` : user.name,
    rawName: user.name, // original name (for permission checks)
    text,
    role: user.role,
    color: user.textColor || "#000",
    dp: user.dp || null,
    ts: Date.now()
  };
}

// socket handlers
io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  // set default skeleton for socket
  users[socket.id] = users[socket.id] || {
    id: socket.id,
    name: "Guest",
    email: null,
    dp: null,
    role: "user",
    textColor: "#000000",
    lastSeen: new Date().toISOString(),
    blocked: [],
    status: "online"
  };

  // send current users list
  broadcastUsers();

  // join handler: client should send profile data (prefer this over random names)
  socket.on("join", (payload = {}) => {
    try {
      const { name, email, dp, role, textColor, uid } = payload;
      users[socket.id] = {
        id: socket.id,
        uid: uid || null, // optional firebase uid if provided
        name: (name && String(name)) || users[socket.id].name || ("User" + Math.floor(Math.random()*10000)),
        email: email || users[socket.id].email || null,
        dp: dp || users[socket.id].dp || null,
        role: role || users[socket.id].role || "user",
        textColor: textColor || users[socket.id].textColor || "#000000",
        lastSeen: new Date().toISOString(),
        blocked: users[socket.id].blocked || [],
        status: "online"
      };

      // send last history only to this socket
      sendHistory(socket);

      // if this username has pending mentions -> send them and clear
      const uname = users[socket.id].name;
      if (pendingMentions[uname] && pendingMentions[uname].length) {
        pendingMentions[uname].forEach(m => {
          socket.emit("mention", m);
        });
        delete pendingMentions[uname];
      }

      broadcastUsers();
      console.log("👤 Joined:", users[socket.id].name, "role:", users[socket.id].role);
    } catch (e) {
      console.error("join handler error:", e);
    }
  });

  // public chat message
  socket.on("chat message", (payload) => {
    try {
      const user = users[socket.id];
      if (!user) return;

      const text = (typeof payload === "string") ? payload : (payload.text || "");
      if (!text.trim()) return;

      // check badwords
      if (containsBadword(text)) {
        io.to(socket.id).emit("system", { text: "❌ You used blocked words and were disconnected." });
        socket.disconnect();
        return;
      }

      const msg = createMsgObj(user, text);

      // store history (last MAX_HISTORY)
      messages.push(msg);
      if (messages.length > MAX_HISTORY) messages = messages.slice(-MAX_HISTORY);

      // mention parsing:
      // pattern: @username or @username dm
      // simple parser: split by spaces, find tokens starting with @
      const tokens = text.split(/\s+/);
      tokens.forEach((tok, idx) => {
        if (tok.startsWith("@") && tok.length > 1) {
          const raw = tok.slice(1).replace(/[^\w\-_.]/g, ""); // allow common chars
          if (!raw) return;
          // check if next token is 'dm'
          const next = tokens[idx + 1] ? tokens[idx + 1].toLowerCase() : "";
          if (next === "dm") {
            // send DM invite to raw
            sendDmInvite(raw, user.name);
          } else {
            // normal mention -> notify that user
            handleMention(raw, user.name, text);
          }
        }
      });

      // broadcast to everyone except blocked pairs
      for (let sid in users) {
        const recip = users[sid];
        // Admins see everything
        if (user.role !== "admin" && recip.role !== "admin") {
          // if recip blocked the sender, skip
          if (recip.blocked && recip.blocked.includes(user.name)) continue;
          // if sender blocked recip, skip as well
          if (user.blocked && user.blocked.includes(recip.name)) continue;
        }
        io.to(sid).emit("chat message", msg);
      }
    } catch (e) {
      console.error("chat message handler error:", e);
    }
  });

  // delete public or in-room
  // payload: { msgId, room } - if room provided -> room delete; else global public delete
  socket.on("delete", (payload = {}) => {
    try {
      const { msgId, room } = payload;
      const user = users[socket.id];
      if (!user) return;

      if (room) {
        // allow only admin OR someone in room to request (we won't maintain per-msg sender for DM here)
        io.to(room).emit("delete", { msgId });
        return;
      }

      // public delete: only admin or original sender can delete
      const msgIndex = messages.findIndex(m => m.id === msgId);
      if (msgIndex === -1) {
        // might be already deleted; still emit a removal
        io.emit("delete", { msgId });
        return;
      }
      const msg = messages[msgIndex];
      // permission check
      if (user.role === "admin" || msg.rawName === user.name) {
        // remove from messages (history)
        messages.splice(msgIndex, 1);
        io.emit("delete", { msgId });
      } else {
        io.to(socket.id).emit("system", { text: "❌ You cannot delete this message." });
      }
    } catch (e) {
      console.error("delete handler error:", e);
    }
  });

  // block/unblock by name (client sends targetName)
  socket.on("block", (targetName) => {
    try {
      const user = users[socket.id];
      if (!user || user.role === "admin") return;

      if (!user.blocked.includes(targetName)) user.blocked.push(targetName);

      // also add reciprocal block so both won't see each other (admin exempt)
      for (let sid in users) {
        if (users[sid].name === targetName && users[sid].role !== "admin") {
          if (!users[sid].blocked.includes(user.name)) users[sid].blocked.push(user.name);
        }
      }

      // emit updated blocklist to this socket
      io.to(socket.id).emit("blocklist", user.blocked);
      broadcastUsers();
    } catch (e) {
      console.error("block handler error:", e);
    }
  });

  socket.on("unblock", (targetName) => {
    try {
      const user = users[socket.id];
      if (!user) return;
      user.blocked = (user.blocked || []).filter(n => n !== targetName);

      // remove reciprocal only if present
      for (let sid in users) {
        if (users[sid].name === targetName) {
          users[sid].blocked = (users[sid].blocked || []).filter(n => n !== user.name);
        }
      }

      io.to(socket.id).emit("blocklist", user.blocked);
      broadcastUsers();
    } catch (e) {
      console.error("unblock handler error:", e);
    }
  });

  // DM invite (explicit)
  socket.on("dm-invite", ({ toName }) => {
    try {
      const sender = users[socket.id];
      if (!sender) return;
      sendDmInvite(toName, sender.name);
    } catch (e) {
      console.error("dm-invite error:", e);
    }
  });

  // DM response
  socket.on("dm-response", ({ fromName, accepted }) => {
    try {
      const target = users[socket.id];
      if (!target) return;
      for (let sid in users) {
        if (users[sid].name === fromName) {
          if (accepted) {
            const room = ["dm", fromName, target.name].sort().join("_");
            socket.join(room);
            io.sockets.sockets.get(sid)?.join(room);

            io.to(room).emit("dm-start", { room, users: [fromName, target.name] });
            console.log(`💬 DM started between ${fromName} & ${target.name}`);
          } else {
            io.to(sid).emit("system", { text: `${target.name} rejected your DM request.` });
          }
        }
      }
    } catch (e) {
      console.error("dm-response error:", e);
    }
  });

  // DM message (room must be provided)
  socket.on("dm-message", ({ room, text }) => {
    try {
      const sender = users[socket.id];
      if (!sender || !room) return;
      const msgId = uuidv4();
      const payload = { id: msgId, from: sender.name, text, dp: sender.dp || null, ts: Date.now() };
      io.to(room).emit("dm-message", payload);
    } catch (e) {
      console.error("dm-message error:", e);
    }
  });

  // DM delete
  socket.on("dm-delete", ({ room, msgId }) => {
    try {
      const user = users[socket.id];
      if (!user || !room) return;
      // allow anyone in room who created message or admin to request deletion
      // NOTE: for full check, DM messages should be stored per-room with sender info; keep simple and allow admin or requester who owns message id (we don't track)
      io.to(room).emit("dm-delete", { msgId });
    } catch (e) {
      console.error("dm-delete error:", e);
    }
  });

  // DM seen
  socket.on("dm-seen", ({ room, from }) => {
    try {
      if (!room) return;
      io.to(room).emit("dm-seen", { room, from });
    } catch (e) {
      console.error("dm-seen error:", e);
    }
  });

  // Admin actions
  socket.on("admin-banner", (data) => {
    try {
      const admin = users[socket.id];
      if (admin?.role === "admin") {
        io.emit("show-banner", data);
        console.log("📢 Banner sent:", data);
      }
    } catch (e) {
      console.error("admin-banner error:", e);
    }
  });

  socket.on("admin-add-badword", (word) => {
    try {
      const admin = users[socket.id];
      if (admin?.role === "admin") {
        badwords.push((word||"").toLowerCase());
      }
    } catch (e) {
      console.error("admin-add-badword error:", e);
    }
  });

  socket.on("admin-del-badword", (word) => {
    try {
      const admin = users[socket.id];
      if (admin?.role === "admin") {
        badwords = badwords.filter(w => w !== (word||"").toLowerCase());
      }
    } catch (e) {
      console.error("admin-del-badword error:", e);
    }
  });

  socket.on("admin-block-user", (uidOrSocketId) => {
    try {
      const admin = users[socket.id];
      if (admin?.role === "admin") {
        // admin passes a socket id to disconnect
        io.to(uidOrSocketId).disconnectSockets();
      }
    } catch (e) {
      console.error("admin-block-user error:", e);
    }
  });

  socket.on("admin-watch-dms", () => {
    try {
      const admin = users[socket.id];
      if (admin?.role !== "admin") return;
      const rooms = [];
      io.sockets.adapter.rooms.forEach((v, k) => {
        if (k.startsWith("dm_")) rooms.push(k);
      });
      socket.emit("dm-rooms", rooms);
    } catch (e) {
      console.error("admin-watch-dms error:", e);
    }
  });

  socket.on("admin-schedule", ({ text, time }) => {
    try {
      const admin = users[socket.id];
      if (admin?.role !== "admin") return;
      const sendTime = new Date(time).getTime();
      const delay = sendTime - Date.now();
      if (delay > 0) {
        setTimeout(() => {
          const sysMsg = {
            id: uuidv4(),
            name: "System",
            rawName: "System",
            text,
            role: "system",
            color: "#111",
            dp: null,
            ts: Date.now()
          };
          messages.push(sysMsg);
          if (messages.length > MAX_HISTORY) messages = messages.slice(-MAX_HISTORY);
          io.emit("chat message", sysMsg);
        }, delay);
      }
    } catch (e) {
      console.error("admin-schedule error:", e);
    }
  });

  socket.on("admin-dm-message", ({ room, text }) => {
    try {
      const admin = users[socket.id];
      if (admin?.role === "admin") {
        const msg = { id: uuidv4(), from: "Admin", text, dp: null, ts: Date.now() };
        io.to(room).emit("dm-message", msg);
      }
    } catch (e) {
      console.error("admin-dm-message error:", e);
    }
  });

  // request recent history manually
  socket.on("get-history", () => {
    sendHistory(socket);
  });

  // disconnect handling
  socket.on("disconnect", () => {
    try {
      if (users[socket.id]) {
        users[socket.id].lastSeen = new Date().toISOString();
        users[socket.id].status = "offline";
        console.log("❌ Disconnected:", users[socket.id].name);
        delete users[socket.id];
        broadcastUsers();
      }
    } catch (e) {
      console.error("disconnect handler error:", e);
    }
  });

}); // io.on connection end

// base route
app.get("/", (req, res) => {
  res.send("🚀 Live Chat Backend ✅ with Admin + DM + Block + Delete + Banner + Mentions + Last8");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
