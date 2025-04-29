
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const MAX_VIEWERS = 10;

const rooms = {};
const socketToRoom = {};
app.get("/", (req, res) => {
  res.send('Stream server is running successfully');
});
app.use(cors());

io.on('connection', (socket) => {
  console.log(`🔌 New client connected: ${socket.id}`);

  socket.on('create-room', (roomId) => {
    if (rooms[roomId]) {
      console.log(`❌ Room ${roomId} already exists`);
      socket.emit('room-exists');
      return;
    }

    rooms[roomId] = {
      hostId: socket.id,
      viewers: new Set(),
      isStreaming: false,
      messages: [],
    };

    socketToRoom[socket.id] = roomId;
    socket.join(roomId);

    console.log(`🛠 Room created: ${roomId} by ${socket.id}`);
    socket.emit('room-created', { roomId });
    emitRoomInfo(roomId);
  });

  socket.on('join-room', (roomId) => {
    if (!rooms[roomId]) {
      console.log(`❌ Room ${roomId} does not exist`);
      socket.emit('invalid-room');
      return;
    }

    if (rooms[roomId].viewers.size >= MAX_VIEWERS) {
      console.log(`❌ Room ${roomId} is full`);
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
      messages: rooms[roomId].messages,
    });

    io.to(rooms[roomId].hostId).emit('user-joined', socket.id);

    if (rooms[roomId].isStreaming) {
      console.log(`📺 Viewer ${socket.id} joined while host is streaming`);
      socket.emit('host-started-streaming');
      socket.emit('viewer-joined', rooms[roomId].hostId);
    }

    emitRoomInfo(roomId);
  });

  socket.on('host-streaming', (roomId) => {
    if (rooms[roomId] && rooms[roomId].hostId === socket.id) {
      rooms[roomId].isStreaming = true;
      rooms[roomId].viewers.forEach((viewerId) => {
        console.log(`📢 Notifying viewer ${viewerId} that host is streaming`);
        io.to(viewerId).emit('host-started-streaming');
        io.to(viewerId).emit('viewer-joined', socket.id);
      });
      console.log(`🎥 Host ${socket.id} started streaming in room ${roomId}`);
      emitRoomInfo(roomId);
    }
  });

  socket.on('offer', ({ target, sdp }) => {
    console.log(`📡 Sending offer from ${socket.id} to ${target}`);
    io.to(target).emit('offer', { sdp, sender: socket.id });
  });

  socket.on('answer', ({ target, sdp }) => {
    console.log(`📡 Sending answer from ${socket.id} to ${target}`);
    io.to(target).emit('answer', { sdp, sender: socket.id });
  });
  
  socket.on('ice-candidate', ({ target, candidate }) => {
    console.log(`📡 Sending ICE candidate from ${socket.id} to ${target}`);
    io.to(target).emit('ice-candidate', { candidate, sender: socket.id });
  });

  socket.on('send-message', (message) => {
    console.log(`💬 Message from ${socket.id}: ${message}`);
    const roomId = socketToRoom[socket.id];
    if (roomId && rooms[roomId]) {
      const newMessage = { sender: socket.id, message };
      rooms[roomId].messages.push(newMessage);
      io.to(roomId).emit('new-message', newMessage);
    }
  });

  socket.on('leave-room', () => {
    console.log(`🚪 ${socket.id} is leaving the room`);
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      leaveRoom(socket, roomId);
    }
  });

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
      console.log(`🛑 Host ${socket.id} left, closing room ${roomId}`);
      io.to(roomId).emit('host-left');
      rooms[roomId].viewers.forEach((viewerId) => {
        io.to(viewerId).emit('room-closed');
        delete socketToRoom[viewerId];
      });
      delete rooms[roomId];
    } else {
      rooms[roomId].viewers.delete(socket.id);
      console.log(`🚪 Viewer ${socket.id} left room ${roomId}`);
      io.to(rooms[roomId].hostId).emit('user-left', socket.id);
    }

    delete socketToRoom[socket.id];
    socket.leave(roomId);
    emitRoomInfo(roomId);
  }

  function emitRoomInfo(roomId) {
    if (!rooms[roomId]) return;

    const info = {
      hostId: rooms[roomId].hostId,
      viewerCount: rooms[roomId].viewers.size,
      isHostActive: io.sockets.sockets.has(rooms[roomId].hostId),
      isHostStreaming: rooms[roomId].isStreaming,
    };

    console.log(`📊 Emitting room info for ${roomId}:`, info);
    io.to(roomId).emit('room-info', info);
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    activeRooms: Object.keys(rooms).length,
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});