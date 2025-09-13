# LiveChat Server

This is the backend server for the Live Chat app using **Node.js, Express, and Socket.io**.

## Features
- Real-time chat with Socket.io
- Two-way block system (A blocks B → both can't see each other's messages)
- Delete own messages
- Online users tracking (count + list)
- Admin mode → can see all connected users (names + socketId)

## Setup

```bash
# Install dependencies
npm install

# Run the server
npm start