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

const MAX_VIEWERS = 10; // Maximum viewers per room

// Room structure: { roomId: { hostId: string, viewers: Set<string>, isStreaming: boolean, messages: Array } }
const rooms = {};
const socketToRoom = {};

io.on('connection', (socket) => {
  console.log(`🔌 New client connected: ${socket.id}`);

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

    console.log(`👋 ${socket.id} joined room ${roomId}`);

    io.to(rooms[roomId].hostId).emit('viewer-joined', socket.id);

    socket.emit('room-joined', {
      roomId,
      hostId: rooms[roomId].hostId,
      isHostStreaming: rooms[roomId].isStreaming,
      viewerCount: rooms[roomId].viewers.size,
      messages: rooms[roomId].messages
    });

    if (rooms[roomId].isStreaming) {
      socket.emit('host-started-streaming');
    }

    emitRoomInfo(roomId);
  });

  socket.on('host-streaming', (roomId) => {
    if (rooms[roomId] && rooms[roomId].hostId === socket.id) {
      rooms[roomId].isStreaming = true;
      rooms[roomId].viewers.forEach(viewerId => {
        io.to(viewerId).emit('host-started-streaming');
      });
      console.log(`🎥 Host ${socket.id} started streaming in room ${roomId}`);
      emitRoomInfo(roomId);
    }
  });

  socket.on('offer', ({ target, sdp }) => {
    io.to(target).emit('offer', { sdp, sender: socket.id });
  });

  socket.on('answer', ({ target, sdp }) => {
    io.to(target).emit('answer', { sdp, sender: socket.id });
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    io.to(target).emit('ice-candidate', { candidate, sender: socket.id });
  });

  socket.on('send-message', (message) => {
    const roomId = socketToRoom[socket.id];
    if (roomId && rooms[roomId]) {
      rooms[roomId].messages.push({ sender: socket.id, message });
      io.to(roomId).emit('new-message', { sender: socket.id, message });
    }
  });

  socket.on('leave-room', () => {
    const roomId = socketToRoom[socket.id];
    if (roomId) leaveRoom(socket, roomId);
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    const roomId = socketToRoom[socket.id];
    if (roomId) leaveRoom(socket, roomId);
  });

  function leaveRoom(socket, roomId) {
    if (!rooms[roomId]) return;

    if (rooms[roomId].hostId === socket.id) {
      io.to(roomId).emit('host-left');
      rooms[roomId].viewers.forEach(viewerId => {
        delete socketToRoom[viewerId];
        io.to(viewerId).emit('room-closed');
      });
      delete rooms[roomId];
    } else {
      rooms[roomId].viewers.delete(socket.id);
      io.to(rooms[roomId].hostId).emit('viewer-left', socket.id);
    }

    delete socketToRoom[socket.id];
    socket.leave(roomId);
    emitRoomInfo(roomId);
    console.log(`🚪 ${socket.id} left room ${roomId}`);
  }

  function emitRoomInfo(roomId) {
    if (!rooms[roomId]) return;

    const roomInfo = {
      hostId: rooms[roomId].hostId,
      viewerCount: rooms[roomId].viewers.size,
      isHostActive: io.sockets.sockets.has(rooms[roomId].hostId),
      isHostStreaming: rooms[roomId].isStreaming
    };

    io.to(roomId).emit('room-info', roomInfo);
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    activeRooms: Object.keys(rooms).length
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
