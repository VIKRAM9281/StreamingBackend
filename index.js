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

// Mappings
const socketInstances = new Map();       // socket.id → socket
const customIdToSocketId = new Map();    // custom ID → socket.id
const socketIdToCustomId = new Map();    // socket.id → custom ID
const pendingSignals = new Map();        // socket.id → array of pending signals

app.use(cors());

app.get('/', (req, res) => {
  res.send('Stream server is running successfully');
});

io.on('connection', (socket) => {
  console.log(`🔌 Raw socket connected: ${socket.id}`);

  socket.on('identify', (customid, name) => {
    const customId = customid?.toString().trim();
    if (!customId || typeof customId !== 'string') {
      console.error('Invalid identify data');
      socket.emit('invalid-identify');
      return;
    }

    if (customIdToSocketId.has(customId)) {
      console.error(`Custom ID ${customId} is already in use`);
      socket.emit('socket-id-in-use');
      return;
    }
    socket.name = name?.toString().trim() || 'Anonymous';
    customIdToSocketId.set(customId, socket.id);
    socketIdToCustomId.set(socket.id, customId);
    socketInstances.set(socket.id, socket);
    console.log(`✅ Socket ${socket.id} identified as ${customId} (${socket.name})`);
    processQueuedSignals(socket.id);
  });

  socket.on('create-room', (roomId) => {
    if (!roomId || typeof roomId !== 'string') {
      socket.emit('invalid-room');
      return;
    }

    if (rooms[roomId]) {
      socket.emit('room-exists');
      return;
    }

    rooms[roomId] = {
      hostId: socket.id,
      viewers: new Set(),
      isStreaming: false,
      isHostReady: false,
      messages: [],
      approvedViewerIds: new Set(), // Store multiple approved viewers
      isViewerStreaming: new Set(), // Track streaming viewers
    };

    socketToRoom[socket.id] = roomId;
    socket.join(roomId);

    socket.emit('room-created', { roomId, socketid: socket.id });
    emitRoomInfo(roomId);
  });

  socket.on('join-room', (roomIdRaw) => {
    const roomId = roomIdRaw.toString();
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

    socket.emit('room-joined', {
      roomId,
      hostId: rooms[roomId].hostId,
      isHostStreaming: rooms[roomId].isStreaming,
      viewerCount: rooms[roomId].viewers.size,
      messages: rooms[roomId].messages,
      approvedViewerIds: Array.from(rooms[roomId].approvedViewerIds),
    });

    if (rooms[roomId].isHostReady) {
      const hostSocket = socketInstances.get(rooms[roomId].hostId);
      if (hostSocket) {
        hostSocket.emit('user-joined', socket.id);
      } else {
        console.warn(`⚠️ Host socket not found for room ${roomId}`);
      }
    }

    if (rooms[roomId].isStreaming) {
      socket.emit('host-started-streaming');
      socket.emit('viewer-joined', rooms[roomId].hostId);
    }

    // Notify new viewer about existing streaming viewers
    rooms[roomId].isViewerStreaming.forEach((viewerId) => {
      socket.emit('viewer-started-streaming', viewerId);
    });

    emitRoomInfo(roomId);
  });

  socket.on('host-streaming', (roomId) => {
    if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) return;

    rooms[roomId].isStreaming = true;
    rooms[roomId].isHostReady = true;

    rooms[roomId].viewers.forEach((viewerId) => {
      const viewerSocket = socketInstances.get(viewerId);
      if (viewerSocket) {
        viewerSocket.emit('host-started-streaming');
        viewerSocket.emit('viewer-joined', socket.id);
      }
    });

    console.log(`🎥 Host ${socket.id} started streaming in room ${roomId}`);
    emitRoomInfo(roomId);
  });

  socket.on('viewer-streaming', (roomId) => {
    if (!rooms[roomId] || !rooms[roomId].approvedViewerIds.has(socket.id)) return;

    rooms[roomId].isViewerStreaming.add(socket.id);

    // Notify all participants (host and other viewers) about the new viewer stream
    io.to(roomId).emit('viewer-started-streaming', socket.id);

    console.log(`🎥 Viewer ${socket.id} started streaming in room ${roomId}`);
    emitRoomInfo(roomId);
  });

  socket.on('offer', ({ target, sdp }) => {
    if (!target || !sdp) return;
    const targetSocket = socketInstances.get(target);
    if (targetSocket) {
      console.log(`📤 Sending offer from ${socket.id} to ${target}`);
      targetSocket.emit('offer', { sdp, sender: socket.id });
    } else {
      console.warn(`⚠️ Target socket ${target} not found for offer`);
      queueSignal(target, { event: 'offer', data: { sdp, sender: socket.id } });
    }
  });

  socket.on('answer', ({ target, sdp }) => {
    if (!target || !sdp) return;
    const targetSocket = socketInstances.get(target);
    if (targetSocket) {
      console.log(`📤 Sending answer from ${socket.id} to ${target}`);
      targetSocket.emit('answer', { sdp, sender: socket.id });
    } else {
      console.warn(`⚠️ Target socket ${target} not found for answer`);
      queueSignal(target, { event: 'answer', data: { sdp, sender: socket.id } });
    }
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    if (!target || !candidate) return;
    const targetSocket = socketInstances.get(target);
    if (targetSocket) {
      console.log(`📤 Sending ICE candidate from ${socket.id} to ${target}`);
      targetSocket.emit('ice-candidate', { candidate, sender: socket.id });
    } else {
      console.warn(`⚠️ Target socket ${target} not found for ICE candidate`);
      queueSignal(target, { event: 'ice-candidate', data: { candidate, sender: socket.id } });
    }
  });

  socket.on('send-message', (message) => {
    if (!message || typeof message !== 'string') return;

    const roomId = socketToRoom[socket.id];
    if (roomId && rooms[roomId]) {
      const newMessage = { sender: socket.id, message };
      rooms[roomId].messages.push(newMessage);
      io.to(roomId).emit('new-message', newMessage);
    }
  });

  socket.on('leave-room', () => {
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      leaveRoom(socket, roomId);
    }
  });

  socket.on('disconnect', () => {
    const customId = socketIdToCustomId.get(socket.id);
    console.log(`❌ Disconnected: ${customId || socket.id}`);

    socketInstances.delete(socket.id);
    pendingSignals.delete(socket.id);
    if (customId) customIdToSocketId.delete(customId);
    socketIdToCustomId.delete(socket.id);

    const roomId = socketToRoom[socket.id];
    if (roomId) {
      leaveRoom(socket, roomId);
    }
  });

  socket.on('request-stream', () => {
    const roomId = socketToRoom[socket.id];
    if (!roomId || !rooms[roomId]) return;

    const hostId = rooms[roomId].hostId;
    const hostSocket = socketInstances.get(hostId);

    if (hostSocket) {
      hostSocket.emit('incoming-stream-request', {
        viewerId: socket.id,
        name: socket.name || socketIdToCustomId.get(socket.id) || 'Unknown',
      });
    }
  });

  socket.on('respond-stream-request', ({ viewerId, accepted }) => {
    const roomId = socketToRoom[socket.id];
    if (!roomId || !rooms[roomId] || rooms[roomId].hostId !== socket.id) return;

    const viewerSocket = socketInstances.get(viewerId);
    if (viewerSocket) {
      if (accepted) {
        rooms[roomId].approvedViewerIds.add(viewerId);
        viewerSocket.emit('stream-request-response', {
          accepted: true,
          roomId,
          hostId: socket.id,
        });
        console.log(`✅ Host ${socket.id} accepted stream request from ${viewerId}`);
        // Process any queued signals for the viewer
        processQueuedSignals(viewerId);
      } else {
        viewerSocket.emit('stream-request-response', {
          accepted: false,
          roomId,
        });
        console.log(`❌ Host ${socket.id} rejected stream request from ${viewerId}`);
      }
    }
  });

  socket.on('stop-viewer-stream', (viewerId) => {
    const roomId = socketToRoom[socket.id];
    if (!roomId || !rooms[roomId] || rooms[roomId].hostId !== socket.id) return;

    if (rooms[roomId].approvedViewerIds.has(viewerId)) {
      rooms[roomId].approvedViewerIds.delete(viewerId);
      rooms[roomId].isViewerStreaming.delete(viewerId);

      const viewerSocket = socketInstances.get(viewerId);
      if (viewerSocket) {
        viewerSocket.emit('viewer-stopped-streaming', viewerId);
      }
      io.to(roomId).emit('viewer-stopped-streaming', viewerId);
      console.log(`🛑 Host ${socket.id} stopped stream for viewer ${viewerId}`);
      emitRoomInfo(roomId);
    }
  });

  function queueSignal(targetId, signal) {
    if (!pendingSignals.has(targetId)) {
      pendingSignals.set(targetId, []);
    }
    pendingSignals.get(targetId).push(signal);
    console.log(`📥 Queued signal for ${targetId}: ${signal.event}`);
  }

  function processQueuedSignals(socketId) {
    if (pendingSignals.has(socketId)) {
      const signals = pendingSignals.get(socketId);
      const socket = socketInstances.get(socketId);
      if (socket) {
        signals.forEach(({ event, data }) => {
          console.log(`📤 Processing queued ${event} for ${socketId}`);
          socket.emit(event, data);
        });
      }
      pendingSignals.delete(socketId);
    }
  }

  function leaveRoom(socket, roomId) {
    if (!rooms[roomId]) return;

    const isHost = rooms[roomId].hostId === socket.id;

    if (isHost) {
      io.to(roomId).emit('host-left');
      rooms[roomId].viewers.forEach((viewerId) => {
        const viewerSocket = socketInstances.get(viewerId);
        if (viewerSocket) {
          viewerSocket.emit('room-closed');
          viewerSocket.leave(roomId);
        }
        delete socketToRoom[viewerId];
        pendingSignals.delete(viewerId);
      });
      delete rooms[roomId];
    } else {
      rooms[roomId].viewers.delete(socket.id);
      if (rooms[roomId].approvedViewerIds.has(socket.id)) {
        rooms[roomId].approvedViewerIds.delete(socket.id);
        rooms[roomId].isViewerStreaming.delete(socket.id);
        io.to(roomId).emit('viewer-stopped-streaming', socket.id);
      }
      const hostSocket = socketInstances.get(rooms[roomId].hostId);
      if (hostSocket) {
        hostSocket.emit('user-left', socket.id);
      }
    }

    delete socketToRoom[socket.id];
    pendingSignals.delete(socket.id);
    socket.leave(roomId);
    emitRoomInfo(roomId);
  }

  function emitRoomInfo(roomId) {
    if (!rooms[roomId]) return;

    const info = {
      hostId: rooms[roomId].hostId,
      viewerCount: rooms[roomId].viewers.size,
      isHostActive: socketInstances.has(rooms[roomId].hostId),
      isHostStreaming: rooms[roomId].isStreaming,
      isViewerStreaming: Array.from(rooms[roomId].isViewerStreaming),
      approvedViewerIds: Array.from(rooms[roomId].approvedViewerIds),
    };

    io.to(roomId).emit('room-info', info);
  }
});

// Utility APIs
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
    approvedViewerIds: Array.from(rooms[roomId].approvedViewerIds),
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