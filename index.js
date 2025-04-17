const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
});

const MAX_VIEWERS = 10;

const rooms = {};
const socketToRoom = {};

io.on('connection', (socket) => {
  console.log(`🔌 New client connected: ${socket.id}`);

  // CREATE ROOM
  socket.on('create-room', (roomId) => {
    if (rooms[roomId]) {
      socket.emit('room-exists');
      return;
    }

    rooms[roomId] = {
      hostId: socket.id,
      viewers: new Set(),
      isStreaming: false,
      messages: []
    };

    socketToRoom[socket.id] = roomId;
    socket.join(roomId);

    console.log(`🛠 Room created: ${roomId} by ${socket.id}`);
    socket.emit('room-created', { roomId });
    emitRoomInfo(roomId);
  });

  // JOIN ROOM
  socket.on('join-room', (roomId) => {
    if (!rooms[roomId]) {
      socket.emit('invalid-room');
      return;
    }

    if (rooms[roomId].viewers.size >= MAX_VIEWERS) {
      socket.emit('room-full');
      return;
    }

    rooms[roomId].viewers.add(socket.id);
    socketToRoom[socket.id] = roomId;
    socket.join(roomId);

    console.log(`👋 Viewer ${socket.id} joined room ${roomId}`);

    socket.emit('room-joined', {
      roomId,
      hostId: rooms[roomId].hostId,
      isHostStreaming: rooms[roomId].isStreaming,
      viewerCount: rooms[roomId].viewers.size,
      messages: rooms[roomId].messages
    });

    // Let host know a viewer joined (triggers WebRTC offer)
    io.to(rooms[roomId].hostId).emit('user-joined', socket.id);

    // If host is already streaming, inform viewer and start WebRTC offer process
    if (rooms[roomId].isStreaming) {
      console.log(`📺 Viewer ${socket.id} joined while host is streaming`);
      socket.emit('host-started-streaming');
      // Trigger WebRTC signaling (offer)
      socket.emit('viewer-joined', rooms[roomId].hostId);
    }

    emitRoomInfo(roomId);
  });

  // HOST STARTS STREAMING
  socket.on('host-streaming', (roomId) => {
    if (rooms[roomId] && rooms[roomId].hostId === socket.id) {
      rooms[roomId].isStreaming = true;
      rooms[roomId].viewers.forEach(viewerId => {
        io.to(viewerId).emit('host-started-streaming');
        io.to(viewerId).emit('viewer-joined', socket.id); // Trigger WebRTC offer for viewers
      });
      console.log(`🎥 Host ${socket.id} started streaming in room ${roomId}`);
      emitRoomInfo(roomId);
    }
  });

  // WebRTC SIGNALING EVENTS
  socket.on('offer', ({ target, sdp }) => {
    console.log(`📡 Sending offer to ${target}`);
    io.to(target).emit('offer', { sdp, sender: socket.id });
  });

  socket.on('answer', ({ target, sdp }) => {
    console.log(`📡 Sending answer to ${target}`);
    io.to(target).emit('answer', { sdp, sender: socket.id });
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    console.log(`📡 Sending ICE candidate to ${target}`);
    io.to(target).emit('ice-candidate', { candidate, sender: socket.id });
  });

  // Optional Chat
  socket.on('send-message', (message) => {
    console.log(`💬 Message from ${socket.id}: ${message}`);
    const roomId = socketToRoom[socket.id];
    if (roomId && rooms[roomId]) {
      const newMessage = { sender: socket.id, message };
      rooms[roomId].messages.push(newMessage);
      io.to(roomId).emit('new-message', newMessage);
    }
  });

  // LEAVING A ROOM
  socket.on('leave-room', () => {
    console.log(`🚪 ${socket.id} is leaving the room`);
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      leaveRoom(socket, roomId);
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      leaveRoom(socket, roomId);
    }
  });

  function leaveRoom(socket, roomId) {
    if (!rooms[roomId]) return;

    const isHost = rooms[roomId].hostId === socket.id;

    if (isHost) {
      io.to(roomId).emit('host-left');
      rooms[roomId].viewers.forEach(viewerId => {
        io.to(viewerId).emit('room-closed');
        delete socketToRoom[viewerId];
      });
      delete rooms[roomId];
    } else {
      rooms[roomId].viewers.delete(socket.id);
      io.to(rooms[roomId].hostId).emit('user-left', socket.id);
    }

    delete socketToRoom[socket.id];
    socket.leave(roomId);
    emitRoomInfo(roomId);
    console.log(`🚪 ${socket.id} left room ${roomId}`);
  }

  function emitRoomInfo(roomId) {
    if (!rooms[roomId]) return;

    const info = {
      hostId: rooms[roomId].hostId,
      viewerCount: rooms[roomId].viewers.size,
      isHostActive: io.sockets.sockets.has(rooms[roomId].hostId),
      isHostStreaming: rooms[roomId].isStreaming,
    };

    io.to(roomId).emit('room-info', info);
  }
});

// Healthcheck endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    activeRooms: Object.keys(rooms).length
  });
});

// Server start
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
