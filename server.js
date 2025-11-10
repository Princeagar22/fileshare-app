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

// In-memory store for active transfer codes and associated socket IDs
// This maps a generated code to the sender's socket ID and potentially the receiver's socket ID
const transferRooms = {}; // code -> { senderSocketId: string, receiverSocketId: string | null }

// Serve static files (your frontend)
app.use(express.static(__dirname));
app.use(express.json()); // For parsing application/json

// --- Socket.IO Logic ---

io.on("connection", (socket) => {
  console.log(`A user connected: ${socket.id}`);

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
            message: "Sender disconnected.",
          });
        }
        delete transferRooms[code];
      } else if (room.receiverSocketId === socket.id) {
        console.log(`Receiver ${socket.id} disconnected from room ${code}.`);
        room.receiverSocketId = null; // Mark receiver as disconnected, sender can wait for new receiver
        // Notify sender
        if (
          room.senderSocketId &&
          io.sockets.sockets.has(room.senderSocketId)
        ) {
          io.to(room.senderSocketId).emit("transfer_interrupted", {
            code: code,
            message: "Receiver disconnected.",
          });
        }
      }
    }
  });

  // Sender registers to get a code
  socket.on("register_sender", (callback) => {
    const code = nanoid(6); // Generate a 6-character unique code
    transferRooms[code] = {
      senderSocketId: socket.id,
      receiverSocketId: null,
      fileMetadata: null, // Will be set by sender later when file is selected
    };
    console.log(`Sender ${socket.id} registered. Code: ${code}`);
    callback({ code: code }); // Send code back to sender
  });

  // Sender provides file metadata after selecting a file
  socket.on("sender_file_metadata", (data) => {
    const { code, fileName, fileSize } = data;
    const room = transferRooms[code];
    if (room && room.senderSocketId === socket.id) {
      room.fileMetadata = { fileName, fileSize };
      console.log(
        `Sender ${socket.id} provided metadata for ${code}: ${fileName}, ${fileSize} bytes`,
      );
      // Optionally, tell the sender that metadata is stored.
      // io.to(socket.id).emit("metadata_stored");
    } else {
      console.warn(
        `Sender ${socket.id} tried to set metadata for invalid/unregistered code ${code}`,
      );
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
    console.log(
      `Receiver ${socket.id} joined code: ${code}. Notifying sender ${room.senderSocketId}.`,
    );

    // Notify sender that a receiver has joined
    io.to(room.senderSocketId).emit("receiver_joined", {
      code: code,
      receiverSocketId: socket.id,
      fileMetadata: room.fileMetadata, // Send metadata to sender too, if needed
    });

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
    const { code, offer } = data;
    const room = transferRooms[code];
    if (room && room.senderSocketId === socket.id && room.receiverSocketId) {
      console.log(
        `Relaying offer from sender ${socket.id} to receiver ${room.receiverSocketId} for code ${code}`,
      );
      io.to(room.receiverSocketId).emit("webrtc_offer", {
        code: code,
        senderSocketId: socket.id, // Receiver needs to know who sent the offer
        offer: offer,
      });
    } else {
      console.warn(
        `Could not relay offer for code ${code} from ${socket.id}. Room or receiver not found.`,
      );
    }
  });

  socket.on("webrtc_answer", (data) => {
    const { code, answer } = data;
    const room = transferRooms[code];
    if (room && room.receiverSocketId === socket.id && room.senderSocketId) {
      console.log(
        `Relaying answer from receiver ${socket.id} to sender ${room.senderSocketId} for code ${code}`,
      );
      io.to(room.senderSocketId).emit("webrtc_answer", {
        code: code,
        receiverSocketId: socket.id, // Sender needs to know who sent the answer
        answer: answer,
      });
    } else {
      console.warn(
        `Could not relay answer for code ${code} from ${socket.id}. Room or sender not found.`,
      );
    }
  });

  socket.on("webrtc_ice_candidate", (data) => {
    const { code, candidate, targetSocketId } = data;
    const room = transferRooms[code];
    if (room) {
      // Relay to the other peer in the room
      if (
        room.senderSocketId === socket.id &&
        room.receiverSocketId === targetSocketId
      ) {
        console.log(
          `Relaying ICE candidate from sender ${socket.id} to receiver ${targetSocketId} for code ${code}`,
        );
        io.to(targetSocketId).emit("webrtc_ice_candidate", {
          code: code,
          candidate: candidate,
        });
      } else if (
        room.receiverSocketId === socket.id &&
        room.senderSocketId === targetSocketId
      ) {
        console.log(
          `Relaying ICE candidate from receiver ${socket.id} to sender ${targetSocketId} for code ${code}`,
        );
        io.to(targetSocketId).emit("webrtc_ice_candidate", {
          code: code,
          candidate: candidate,
        });
      } else {
        console.warn(
          `Could not relay ICE candidate for code ${code} from ${socket.id} to target ${targetSocketId}. Target not found in room.`,
        );
      }
    } else {
      console.warn(
        `Could not relay ICE candidate for code ${code}. Room not found.`,
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server is running on http://localhost:${PORT}`);
});
