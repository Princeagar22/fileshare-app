const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for development
    methods: ["GET", "POST"],
  },
});
const PORT = process.env.PORT || 3000;

// In-memory store for active transfer rooms
// This maps a generated code to the sender's socket ID and potentially the receiver's socket ID
// For a production app, use a persistent store (e.g., Redis) and add expiration logic.
const transferRooms = {}; // code -> { senderSocketId: string, receiverSocketId: string | null, fileMetadata: object | null, lastActivity: number }

// Serve static files (your frontend)
app.use(express.static(__dirname));

// Middleware to parse JSON bodies
app.use(express.json());

// --- Socket.IO Logic ---

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  socket.emit("connected", { message: "Connected to signaling server." }); // Confirm connection to client

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    // Clean up any rooms where this socket was a sender or receiver
    for (const code in transferRooms) {
      const room = transferRooms[code];
      if (room.senderSocketId === socket.id) {
        console.log(`Sender ${socket.id} disconnected. Deleting room ${code}.`);
        // Notify receiver if connected
        if (
          room.receiverSocketId &&
          io.sockets.sockets.has(room.receiverSocketId)
        ) {
          io.to(room.receiverSocketId).emit("transfer_interrupted", {
            code: code,
            message: "Sender disconnected. Transfer cannot proceed.",
          });
        }
        delete transferRooms[code];
      } else if (room.receiverSocketId === socket.id) {
        console.log(`Receiver ${socket.id} disconnected from room ${code}.`);
        room.receiverSocketId = null; // Mark receiver as disconnected, sender can wait for new receiver
        // Notify sender if connected
        if (
          room.senderSocketId &&
          io.sockets.sockets.has(room.senderSocketId)
        ) {
          io.to(room.senderSocketId).emit("transfer_interrupted", {
            code: code,
            message: "Receiver disconnected. Waiting for a new receiver...",
          });
        }
      }
    }
  });

  // Sender registers to get a unique code
  socket.on("register_sender", (callback) => {
    const code = nanoid(6); // Generate a 6-character unique code
    transferRooms[code] = {
      senderSocketId: socket.id,
      receiverSocketId: null,
      fileMetadata: null, // Will be set by sender later when file is selected
      lastActivity: Date.now(),
    };
    console.log(`Sender ${socket.id} registered. Code: ${code}`);
    callback({ code: code }); // Send code back to sender
  });

  // Sender provides file metadata after selecting a file
  socket.on("sender_file_metadata", (data) => {
    const { code, fileName, fileSize, fileType } = data;
    const room = transferRooms[code];
    if (room && room.senderSocketId === socket.id) {
      room.fileMetadata = { fileName, fileSize, fileType };
      room.lastActivity = Date.now();
      console.log(
        `Sender ${socket.id} provided metadata for ${code}: ${fileName}, ${fileSize} bytes`,
      );
      // If a receiver is already waiting, notify them about the file metadata
      if (
        room.receiverSocketId &&
        io.sockets.sockets.has(room.receiverSocketId)
      ) {
        io.to(room.receiverSocketId).emit("sender_ready_with_metadata", {
          code: code,
          fileMetadata: room.fileMetadata,
          senderSocketId: room.senderSocketId,
        });
      }
    } else {
      console.warn(
        `Sender ${socket.id} tried to set metadata for invalid/unregistered code ${code}`,
      );
      socket.emit("transfer_error", {
        code: code,
        message: "Failed to set file metadata: Invalid or expired code.",
      });
    }
  });

  // Receiver joins with a code
  socket.on("register_receiver", (code, callback) => {
    const room = transferRooms[code];
    if (!room) {
      console.log(
        `Receiver ${socket.id} tried to join non-existent code: ${code}`,
      );
      return callback({ success: false, message: "Invalid or expired code." });
    }
    if (room.receiverSocketId) {
      console.log(
        `Receiver ${socket.id} tried to join code ${code}, but a receiver is already present.`,
      );
      return callback({
        success: false,
        message: "Another receiver is already connected to this code.",
      });
    }
    if (room.senderSocketId === socket.id) {
      console.log(`Receiver ${socket.id} tried to join own code ${code}.`);
      return callback({
        success: false,
        message: "Cannot receive from yourself. Share the code with a friend.",
      });
    }

    room.receiverSocketId = socket.id;
    room.lastActivity = Date.now();
    console.log(
      `Receiver ${socket.id} joined code: ${code}. Notifying sender ${room.senderSocketId}.`,
    );

    // Notify sender that a receiver has joined
    if (io.sockets.sockets.has(room.senderSocketId)) {
      io.to(room.senderSocketId).emit("receiver_joined", {
        code: code,
        receiverSocketId: socket.id,
        fileMetadata: room.fileMetadata, // Send metadata to sender too, if needed
      });
    }

    // Send success and file metadata to the receiver
    callback({
      success: true,
      fileMetadata: room.fileMetadata, // Receiver needs to know file details
      senderSocketId: room.senderSocketId,
    });
  });

  // --- WebRTC Signaling ---
  // These events simply relay messages between sender and receiver

  socket.on("webrtc_offer", (data) => {
    const { code, offer, targetSocketId } = data;
    const room = transferRooms[code];
    if (
      room &&
      room.senderSocketId === socket.id &&
      room.receiverSocketId === targetSocketId
    ) {
      console.log(
        `Relaying offer from sender ${socket.id} to receiver ${room.receiverSocketId} for code ${code}`,
      );
      room.lastActivity = Date.now();
      io.to(room.receiverSocketId).emit("webrtc_offer", {
        code: code,
        senderSocketId: socket.id, // Receiver needs to know who sent the offer
        offer: offer,
      });
    } else {
      console.warn(
        `Could not relay offer for code ${code} from ${socket.id}. Room or receiver not found, or target mismatch.`,
      );
      socket.emit("transfer_error", {
        code: code,
        message:
          "Failed to relay offer: Receiver not connected or room expired.",
      });
    }
  });

  socket.on("webrtc_answer", (data) => {
    const { code, answer, targetSocketId } = data;
    const room = transferRooms[code];
    if (
      room &&
      room.receiverSocketId === socket.id &&
      room.senderSocketId === targetSocketId
    ) {
      console.log(
        `Relaying answer from receiver ${socket.id} to sender ${room.senderSocketId} for code ${code}`,
      );
      room.lastActivity = Date.now();
      io.to(room.senderSocketId).emit("webrtc_answer", {
        code: code,
        receiverSocketId: socket.id, // Sender needs to know who sent the answer
        answer: answer,
      });
    } else {
      console.warn(
        `Could not relay answer for code ${code} from ${socket.id}. Room or sender not found, or target mismatch.`,
      );
      socket.emit("transfer_error", {
        code: code,
        message:
          "Failed to relay answer: Sender not connected or room expired.",
      });
    }
  });

  socket.on("webrtc_ice_candidate", (data) => {
    const { code, candidate, targetSocketId } = data;
    const room = transferRooms[code];
    if (room) {
      room.lastActivity = Date.now();
      // Relay to the other peer in the room
      if (
        room.senderSocketId === socket.id &&
        room.receiverSocketId === targetSocketId &&
        io.sockets.sockets.has(targetSocketId)
      ) {
        // console.log(`Relaying ICE candidate from sender ${socket.id} to receiver ${targetSocketId} for code ${code}`);
        io.to(targetSocketId).emit("webrtc_ice_candidate", {
          code: code,
          candidate: candidate,
        });
      } else if (
        room.receiverSocketId === socket.id &&
        room.senderSocketId === targetSocketId &&
        io.sockets.sockets.has(targetSocketId)
      ) {
        // console.log(`Relaying ICE candidate from receiver ${socket.id} to sender ${targetSocketId} for code ${code}`);
        io.to(targetSocketId).emit("webrtc_ice_candidate", {
          code: code,
          candidate: candidate,
        });
      } else {
        console.warn(
          `Could not relay ICE candidate for code ${code} from ${socket.id} to target ${targetSocketId}. Target not found in room or not connected.`,
        );
      }
    } else {
      console.warn(
        `Could not relay ICE candidate for code ${code}. Room not found.`,
      );
      socket.emit("transfer_error", {
        code: code,
        message: "Failed to relay ICE candidate: Room expired.",
      });
    }
  });
});

// --- Cleanup Logic (for in-memory transferRooms) ---
const ROOM_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
const ROOM_INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity

setInterval(() => {
  const now = Date.now();
  for (const code in transferRooms) {
    const room = transferRooms[code];
    // Clean up if sender disconnected, or room is inactive for too long
    const isSenderConnected = io.sockets.sockets.has(room.senderSocketId);
    const isReceiverConnected =
      room.receiverSocketId && io.sockets.sockets.has(room.receiverSocketId);

    if (
      !isSenderConnected ||
      (now - room.lastActivity > ROOM_INACTIVITY_TIMEOUT &&
        !isReceiverConnected)
    ) {
      console.log(`Cleaning up inactive/disconnected room: ${code}`);
      if (isSenderConnected) {
        // Notify sender if still connected
        io.to(room.senderSocketId).emit("transfer_interrupted", {
          code: code,
          message: "Transfer room expired due to inactivity.",
        });
      }
      if (isReceiverConnected) {
        // Notify receiver if still connected
        io.to(room.receiverSocketId).emit("transfer_interrupted", {
          code: code,
          message: "Transfer room expired due to inactivity.",
        });
      }
      delete transferRooms[code];
    }
  }
}, ROOM_CLEANUP_INTERVAL);

server.listen(PORT, () => {
  console.log(`Signaling server is running on http://localhost:${PORT}`);
});
