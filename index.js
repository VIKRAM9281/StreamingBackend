const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.set('trust proxy', true);
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

app.use(cors());

app.get('/', (req, res) => {
  res.send('Stream server is running successfully.');
});

io.on('connection', (socket) => {
  console.log(`🔌 New client connected: ${socket.id}`);

  socket.on('create-room', (roomId) => {
    if (!roomId || typeof roomId !== 'string') {
      console.log('Invalid room ID');
      socket.emit('invalid-room');
      return;
    }

    if (rooms[roomId]) {
      console.log(`❌ Room ${roomId} already exists`);
      socket.emit('room-exists');
      return;
    }

    rooms[roomId] = {
      hostId: socket.id,
      viewers: new Set(),
      approvedStreamers: new Set(),
      isStreaming: false,
      isHostReady: false,
      messages: [],
      viewerList: [],
    };

    socketToRoom[socket.id] = roomId;
    socket.join(roomId);

    console.log(`🛠 Room created: ${roomId} by ${socket.id}`);
    socket.emit('room-created', { roomId });
    emitRoomInfo(roomId);
  });

  socket.on('join-room', (roomId) => {
    if (!roomId || typeof roomId !== 'string') {
      socket.emit('invalid-room');
      return;
    }

    if (!rooms[roomId]) {
      socket.emit('invalid-room');
      return;
    }

    if (rooms[roomId].viewers.size >= MAX_VIEWERS) {
      socket.emit('room-full');
      return;
    }

    rooms[roomId].viewers.add(socket.id);
    rooms[roomId].viewerList = Array.from(rooms[roomId].viewers);
    socketToRoom[socket.id] = roomId;
    socket.join(roomId);

    socket.emit('room-joined', {
      roomId,
      hostId: rooms[roomId].hostId,
      isHostStreaming: rooms[roomId].isStreaming,
      viewerCount: rooms[roomId].viewers.size,
      viewerList: rooms[roomId].viewerList,
      messages: rooms[roomId].messages,
    });

    if (rooms[roomId].isHostReady) {
      io.to(rooms[roomId].hostId).emit('user-joined', socket.id);
    }

    if (rooms[roomId].isStreaming) {
      socket.emit('host-started-streaming');
      socket.emit('viewer-joined', rooms[roomId].hostId);
    }

    rooms[roomId].approvedStreamers.forEach((streamerId) => {
      socket.emit('user-started-streaming', { streamerId });
    });

    console.log(`👤 Viewer ${socket.id} joined room ${roomId}`);
    emitRoomInfo(roomId);
  });

  socket.on('host-streaming', (roomId) => {
    if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) {
      return;
    }

    rooms[roomId].isStreaming = true;
    rooms[roomId].isHostReady = true;
    rooms[roomId].viewers.forEach((viewerId) => {
      console.log(`📢 Notifying viewer ${viewerId} that host is streaming`);
      io.to(viewerId).emit('host-started-streaming');
      io.to(viewerId).emit('viewer-joined', socket.id);
    });
    console.log(`🎥 Host ${socket.id} started streaming in room ${roomId}`);
    emitRoomInfo(roomId);
  });

  socket.on('stop-streaming', (roomId) => {
    if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) {
      return;
    }

    rooms[roomId].isStreaming = false;
    rooms[roomId].viewers.forEach((viewerId) => {
      io.to(viewerId).emit('host-stopped-streaming');
    });
    console.log(`🛑 Host ${socket.id} stopped streaming in room ${roomId}`);
    emitRoomInfo(roomId);
  });

  socket.on('stream-request', ({ roomId, viewerId }) => {
    if (!rooms[roomId] || !rooms[roomId].viewers.has(viewerId)) {
      console.log(`❌ Invalid stream request from ${viewerId} in room ${roomId}`);
      return;
    }

    console.log(`📩 Stream request from viewer ${viewerId} in room ${roomId}`);
    io.to(rooms[roomId].hostId).emit('stream-request', { viewerId });
  });

  socket.on('stream-permission', ({ viewerId, allowed }) => {
    const roomId = socketToRoom[socket.id];
    if (!roomId || !rooms[roomId] || rooms[roomId].hostId !== socket.id) {
      console.log(`❌ Invalid permission from ${socket.id} for ${viewerId}`);
      return;
    }

    console.log(`📜 Stream permission for ${viewerId}: ${allowed ? 'allowed' : 'denied'}`);
    io.to(viewerId).emit('stream-permission', { allowed });
    if (allowed) {
      rooms[roomId].approvedStreamers.add(viewerId);
      io.to(roomId).emit('user-started-streaming', { streamerId: viewerId });
    }
  });

  socket.on('user-started-streaming', ({ roomId, streamerId }) => {
    if (!rooms[roomId] || !rooms[roomId].approvedStreamers.has(streamerId)) {
      console.log(`❌ Unauthorized streaming attempt by ${streamerId} in room ${roomId}`);
      return;
    }

    console.log(`🎥 Viewer ${streamerId} started streaming in room ${roomId}`);
    // Removed redundant emission since stream-permission already notifies the room
  });

  socket.on('chat-message', ({ roomId, message }) => {
    if (!rooms[roomId] || !message || typeof message !== 'string') {
      return;
    }

    const newMessage = { senderId: socket.id, message };
    rooms[roomId].messages.push(newMessage);
    console.log(`💬 Chat message from ${socket.id} in room ${roomId}: ${message}`);
    io.to(roomId).emit('chat-message', newMessage);
  });

  socket.on('reaction', ({ roomId, type }) => {
    if (!rooms[roomId] || !type || typeof type !== 'string') {
      return;
    }

    console.log(`😊 Reaction ${type} from ${socket.id} in room ${roomId}`);
    io.to(roomId).emit('reaction', { senderId: socket.id, type });
  });

  socket.on('offer', ({ target, sdp }) => {
    if (!target || !sdp) {
      console.error('Invalid offer data');
      return;
    }
    console.log(`📡 Sending offer from ${socket.id} to ${target}`);
    io.to(target).emit('offer', { sdp, sender: socket.id });
  });

  socket.on('answer', ({ target, sdp }) => {
    if (!target || !sdp) {
      console.error('Invalid answer data');
      return;
    }
    console.log(`📡 Sending answer from ${socket.id} to ${target}`);
    io.to(target).emit('answer', { sdp, sender: socket.id });
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    if (!target || !candidate) {
      console.error('Invalid ICE candidate data');
      return;
    }
    console.log(`📡 Sending ICE candidate from ${socket.id} to ${target}`);
    io.to(target).emit('ice-candidate', { candidate, sender: socket.id });
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
        io.sockets.sockets.get(viewerId)?.leave(roomId);
      });
      delete rooms[roomId];
    } else {
      rooms[roomId].viewers.delete(socket.id);
      rooms[roomId].approvedStreamers.delete(socket.id);
      rooms[roomId].viewerList = Array.from(rooms[roomId].viewers);
      console.log(`🚪 Viewer ${socket.id} left room ${roomId}`);
      io.to(roomId).emit('user-left', socket.id);
      io.to(roomId).emit('room-info', {
        viewerCount: rooms[roomId].viewers.size,
        viewerList: rooms[roomId].viewerList,
      });
    }

    delete socketToRoom[socket.id];
    socket.leave(roomId);
  }

  function emitRoomInfo(roomId) {
    if (!rooms[roomId]) return;

    const info = {
      hostId: rooms[roomId].hostId,
      viewerCount: rooms[roomId].viewers.size,
      viewerList: rooms[roomId].viewerList,
      isHostActive: io.sockets.sockets.has(rooms[roomId].hostId),
      isHostStreaming: rooms[roomId].isStreaming,
    };

    console.log(`📊 Emitting room info for ${roomId}:`, info);
    io.to(roomId).emit('room-info', info);
  }
});

app.get('/Roomcount', (req, res) => {
  res.status(200).json({
    status: 'ok',
    activeRooms: Object.keys(rooms).length,
  });
});

app.get('/rooms', (req, res) => {
  const roomList = Object.keys(rooms).map((roomId) => ({
    roomId,
    viewerCount: rooms[roomId].viewers.size,
    isStreaming: rooms[roomId].isStreaming,
    hostId: rooms[roomId].hostId,
  }));

  res.status(200).json({
    status: 'ok',
    rooms: roomList,
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});