const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Users + Messages
let users = {};
let badwords = [];
let messages = []; // ✅ last 6 msgs store

// ✅ User Connection
io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  // User joins
  socket.on("join", ({ name, email, dp, role, textColor }) => {
    users[socket.id] = {
      id: socket.id,
      name: name || "Guest",
      email,
      dp: dp || "", // user DP (Firebase/Google से आएगी)
      role: role || "user",
      textColor: textColor || "#000000",
      lastSeen: "online",
      blocked: []
    };

    // ✅ सिर्फ़ नए user को last 6 messages भेजना
    socket.emit("chat-history", messages);

    io.emit("users", Object.values(users));
    console.log("👤 Joined:", name, "Role:", role);
  });

  // ✅ Live Chat Message
  socket.on("chat message", (payload) => {
    const user = users[socket.id];
    if (!user) return;

    const text = typeof payload === "string" ? payload : payload.text;

    // Badword filter
    const hasBad = badwords.some((w) =>
      text.toLowerCase().includes(w.toLowerCase())
    );
    if (hasBad) {
      io.to(socket.id).emit("system", {
        text: "❌ You are blocked for using bad words!"
      });
      socket.disconnect();
      return;
    }

    const msgId = uuidv4();
    const msgData = {
      id: msgId,
      name: user.role === "admin" ? `🛡️ Admin (${user.name})` : user.name,
      text,
      role: user.role,
      color: user.textColor || "#000",
      dp: user.dp || null
    };

    // ✅ store only last 6
    messages.push(msgData);
    if (messages.length > 6) messages = messages.slice(-6);

    // Send to all except blocked (Admin exempted)
    for (let id in users) {
      const u = users[id];
      if (user.role !== "admin" && u.role !== "admin") {
        if (u.blocked.includes(user.name)) continue;
        if (user.blocked.includes(u.name)) continue;
      }
      io.to(id).emit("chat message", msgData);
    }
  });

  // ✅ Delete Message (Live + DM)
  socket.on("delete", ({ msgId, room }) => {
    if (room) {
      io.to(room).emit("delete", msgId);
    } else {
      messages = messages.filter((m) => m.id !== msgId);
      io.emit("delete", msgId);
    }
  });

  // ✅ Block / Unblock
  socket.on("block", (targetName) => {
    const user = users[socket.id];
    if (!user || user.role === "admin") return;

    if (!user.blocked.includes(targetName)) {
      user.blocked.push(targetName);
    }

    // दोनों तरफ block (admin exempt)
    for (let id in users) {
      if (users[id].name === targetName && users[id].role !== "admin") {
        if (!users[id].blocked.includes(user.name)) {
          users[id].blocked.push(user.name);
        }
      }
    }

    socket.emit("blocklist", user.blocked);
  });

  socket.on("unblock", (targetName) => {
    const user = users[socket.id];
    if (!user) return;
    user.blocked = user.blocked.filter((n) => n !== targetName);
    socket.emit("blocklist", user.blocked);
  });

  // ✅ DM Invite
  socket.on("dm-invite", ({ toName }) => {
    const sender = users[socket.id];
    if (!sender) return;

    for (let id in users) {
      if (users[id].name === toName) {
        io.to(id).emit("dm-invite", { from: sender.name });
      }
    }
  });

  // ✅ DM Response
  socket.on("dm-response", ({ fromName, accepted }) => {
    const target = users[socket.id];
    if (!target) return;

    for (let id in users) {
      if (users[id].name === fromName) {
        if (accepted) {
          const room = ["dm", fromName, target.name].sort().join("_");
          socket.join(room);
          io.sockets.sockets.get(id)?.join(room);

          io.to(room).emit("dm-start", {
            room,
            users: [fromName, target.name]
          });
          console.log(`💬 DM started between ${fromName} & ${target.name}`);
        } else {
          io.to(id).emit("system", {
            text: `${target.name} rejected your DM request.`
          });
        }
      }
    }
  });

  // ✅ DM Message
  socket.on("dm-message", ({ room, text }) => {
    const sender = users[socket.id];
    if (!sender) return;

    const msgId = uuidv4();
    io.to(room).emit("dm-message", {
      id: msgId,
      from: sender.name,
      text,
      dp: sender.dp || null
    });
  });

  // ✅ DM Delete
  socket.on("dm-delete", ({ room, msgId }) => {
    io.to(room).emit("dm-delete", msgId);
  });

  // ✅ Admin: Banner
  socket.on("admin-banner", (data) => {
    const admin = users[socket.id];
    if (admin?.role === "admin") {
      io.emit("show-banner", data);
      console.log("📢 Banner sent:", data);
    }
  });

  // ✅ Admin: Manage Badwords
  socket.on("admin-add-badword", (word) => {
    const admin = users[socket.id];
    if (admin?.role === "admin") {
      badwords.push(word.toLowerCase());
    }
  });

  socket.on("admin-del-badword", (word) => {
    const admin = users[socket.id];
    if (admin?.role === "admin") {
      badwords = badwords.filter((w) => w !== word.toLowerCase());
    }
  });

  // ✅ Admin: Block User
  socket.on("admin-block-user", (uid) => {
    const admin = users[socket.id];
    if (admin?.role === "admin") {
      io.to(uid).disconnectSockets();
    }
  });

  // ✅ Admin: Watch DMs
  socket.on("admin-watch-dms", () => {
    const admin = users[socket.id];
    if (admin?.role !== "admin") return;

    const dms = [];
    io.sockets.adapter.rooms.forEach((value, key) => {
      if (key.startsWith("dm_")) dms.push(key);
    });
    socket.emit("dm-rooms", dms);
  });

  // ✅ Admin: Scheduled Message
  socket.on("admin-schedule", ({ text, time }) => {
    const admin = users[socket.id];
    if (admin?.role !== "admin") return;

    const sendTime = new Date(time).getTime();
    const delay = sendTime - Date.now();
    if (delay > 0) {
      setTimeout(() => {
        io.emit("chat message", {
          id: uuidv4(),
          name: "System",
          text,
          role: "system",
          color: "#111",
          dp: null
        });
      }, delay);
    }
  });

  // ✅ Admin: Send message in DM
  socket.on("admin-dm-message", ({ room, text }) => {
    const admin = users[socket.id];
    if (admin?.role === "admin") {
      io.to(room).emit("dm-message", {
        id: uuidv4(),
        from: "Admin",
        text,
        dp: null
      });
      console.log(`📩 Admin sent message in ${room}: ${text}`);
    }
  });

  // ✅ Disconnect
  socket.on("disconnect", () => {
    if (users[socket.id]) {
      users[socket.id].lastSeen = new Date().toLocaleString();
      console.log("❌ Disconnected:", users[socket.id].name);
      delete users[socket.id];
      io.emit("users", Object.values(users));
    }
  });
});

// Base Route
app.get("/", (req, res) => {
  res.send("🚀 Live Chat Backend ✅ with Admin + DM + Block + Delete + Banner + Scheduler + Last6Msgs");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});    if (!user) return;

    const text = typeof payload === "string" ? payload : payload.text;

    // Badword filter
    const hasBad = badwords.some((w) =>
      text.toLowerCase().includes(w.toLowerCase())
    );
    if (hasBad) {
      io.to(socket.id).emit("system", {
        text: "❌ You are blocked for using bad words!"
      });
      socket.disconnect();
      return;
    }

    const msgId = uuidv4();
    const msgData = {
      id: msgId,
      name: user.role === "admin" ? `🛡️ Admin (${user.name})` : user.name,
      text,
      role: user.role,
      color: user.textColor || "#000"
    };

    // Send to all except blocked (Admin exempted)
    for (let id in users) {
      const u = users[id];
      if (user.role !== "admin" && u.role !== "admin") {
        if (u.blocked.includes(user.name)) continue;
        if (user.blocked.includes(u.name)) continue;
      }
      io.to(id).emit("chat message", msgData);
    }
  });

  // ✅ Delete Message (Live + DM)
  socket.on("delete", ({ msgId, room }) => {
    if (room) {
      io.to(room).emit("delete", msgId);
    } else {
      io.emit("delete", msgId);
    }
  });

  // ✅ Block / Unblock
  socket.on("block", (targetName) => {
    const user = users[socket.id];
    if (!user || user.role === "admin") return;

    if (!user.blocked.includes(targetName)) {
      user.blocked.push(targetName);
    }

    // Opposite भी block हो (admin exempt)
    for (let id in users) {
      if (users[id].name === targetName && users[id].role !== "admin") {
        if (!users[id].blocked.includes(user.name)) {
          users[id].blocked.push(user.name);
        }
      }
    }

    socket.emit("blocklist", user.blocked);
  });

  socket.on("unblock", (targetName) => {
    const user = users[socket.id];
    if (!user) return;
    user.blocked = user.blocked.filter((n) => n !== targetName);
    socket.emit("blocklist", user.blocked);
  });

  // ✅ DM Invite
  socket.on("dm-invite", ({ toName }) => {
    const sender = users[socket.id];
    if (!sender) return;

    for (let id in users) {
      if (users[id].name === toName) {
        io.to(id).emit("dm-invite", { from: sender.name });
      }
    }
  });

  // ✅ DM Response
  socket.on("dm-response", ({ fromName, accepted }) => {
    const target = users[socket.id];
    if (!target) return;

    for (let id in users) {
      if (users[id].name === fromName) {
        if (accepted) {
          const room = ["dm", fromName, target.name].sort().join("_");
          socket.join(room);
          io.sockets.sockets.get(id)?.join(room);

          io.to(room).emit("dm-start", {
            room,
            users: [fromName, target.name]
          });
          console.log(`💬 DM started between ${fromName} & ${target.name}`);
        } else {
          io.to(id).emit("system", {
            text: `${target.name} rejected your DM request.`
          });
        }
      }
    }
  });

  // ✅ DM Message
  socket.on("dm-message", ({ room, text }) => {
    const sender = users[socket.id];
    if (!sender) return;

    const msgId = uuidv4();
    io.to(room).emit("dm-message", { id: msgId, from: sender.name, text });
  });

  // ✅ DM Delete
  socket.on("dm-delete", ({ room, msgId }) => {
    io.to(room).emit("dm-delete", msgId);
  });

  // ✅ DM Seen
  socket.on("dm-seen", ({ room, from }) => {
    io.to(room).emit("dm-seen", { room, from });
  });

  // ✅ Admin: Send Banner
  socket.on("admin-banner", (data) => {
    const admin = users[socket.id];
    if (admin?.role === "admin") {
      io.emit("show-banner", data);
      console.log("📢 Banner sent:", data);
    }
  });

  // ✅ Admin: Manage Badwords
  socket.on("admin-add-badword", (word) => {
    const admin = users[socket.id];
    if (admin?.role === "admin") {
      badwords.push(word.toLowerCase());
    }
  });

  socket.on("admin-del-badword", (word) => {
    const admin = users[socket.id];
    if (admin?.role === "admin") {
      badwords = badwords.filter((w) => w !== word.toLowerCase());
    }
  });

  // ✅ Admin: Block User
  socket.on("admin-block-user", (uid) => {
    const admin = users[socket.id];
    if (admin?.role === "admin") {
      io.to(uid).disconnect();
    }
  });

  // ✅ Admin: Watch DMs
  socket.on("admin-watch-dms", () => {
    const admin = users[socket.id];
    if (admin?.role !== "admin") return;

    const dms = [];
    io.sockets.adapter.rooms.forEach((value, key) => {
      if (key.startsWith("dm_")) dms.push(key);
    });
    socket.emit("dm-rooms", dms);
  });

  // ✅ Admin: Scheduled Message
  socket.on("admin-schedule", ({ text, time }) => {
    const admin = users[socket.id];
    if (admin?.role !== "admin") return;

    const sendTime = new Date(time).getTime();
    const delay = sendTime - Date.now();
    if (delay > 0) {
      setTimeout(() => {
        io.emit("chat message", {
          id: uuidv4(),
          name: "System",
          text,
          role: "system",
          color: "#111"
        });
      }, delay);
    }
  });

  // ✅ Admin: Send message in DM
  socket.on("admin-dm-message", ({ room, text }) => {
    const admin = users[socket.id];
    if (admin?.role === "admin") {
      io.to(room).emit("dm-message", { id: uuidv4(), from: "Admin", text });
      console.log(`📩 Admin sent message in ${room}: ${text}`);
    }
  });

  // ✅ Disconnect
  socket.on("disconnect", () => {
    if (users[socket.id]) {
      users[socket.id].lastSeen = new Date().toLocaleString();
      console.log("❌ Disconnected:", users[socket.id].name);
      delete users[socket.id];
      io.emit("users", Object.values(users));
    }
  });
});

// Base Route
app.get("/", (req, res) => {
  res.send("🚀 Live Chat Backend ✅ with Admin + DM + Block + Delete + Banner + Scheduler");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
