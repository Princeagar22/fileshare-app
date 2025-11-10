document.addEventListener("DOMContentLoaded", () => {
  // --- UI Elements ---
  const fileInput = document.getElementById("fileInput");
  const sendButton = document.getElementById("sendButton");
  const sendStatusMessage = document.getElementById("sendStatusMessage");
  const sendProgressContainer = document.getElementById("sendProgressContainer");
  const sendProgressBar = document.getElementById("sendProgressBar");
  const sendProgressPercent = document.getElementById("sendProgressPercent");
  const sendSpeed = document.getElementById("sendSpeed");
  const sendETA = document.getElementById("sendETA");

  const receiveCodeInput = document.getElementById("receiveCodeInput");
  const receiveButton = document.getElementById("receiveButton");
  const receiveStatusMessage = document.getElementById("receiveStatusMessage");
  const receiveProgressContainer = document.getElementById("receiveProgressContainer");
  const receiveProgressBar = document.getElementById("receiveProgressBar");
  const receiveProgressPercent = document.getElementById("receiveProgressPercent");
  const receiveSpeed = document.getElementById("receiveSpeed");
  const receiveETA = document.getElementById("receiveETA");

  const codePopup = document.getElementById("codePopup");
  const displayCode = document.getElementById("displayCode");
  const copyCodeButton = document.getElementById("copyCodeButton");
  const closePopupButton = document.getElementById("closePopupButton");

  // --- WebRTC Related Variables ---
  let socket = null;
  let peerConnection = null;
  let dataChannel = null;
  let currentTransferCode = null;
  let isSender = false;
  let fileToSend = null;

  const receivedChunks = [];
  let receivedBytes = 0;
  let fileMetadata = null;
  let downloadStartTime = null; // For receiver ETA
  let lastReceivedBytes = 0;
  let lastReceiveTime = Date.now();
  let receiveSpeedMbps = 0;

  let bytesSent = 0; // For sender progress
  let sendStartTime = null;
  let lastBytesSent = 0;
  let lastSendTime = Date.now();
  let sendSpeedMbps = 0;

  // Optimize chunk size based on browser capabilities for better performance
  const CHUNK_SIZE = 256 * 1024; // Increased to 256KB for better performance
  let readOffset = 0; // Current position in the file being read

  // STUN/TURN servers for NAT traversal
  // **IMPORTANT**: For reliable transfers, especially across different networks,
  // you will need a TURN server. Public STUN servers are often not enough.
  // Obtain TURN credentials from a service like Twilio, Xirsys, or host your own coturn server.
  const iceServers = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      // Example of a TURN server. Replace with your actual credentials!
      // {
      //   urls: 'turn:YOUR_TURN_SERVER_URL:PORT?transport=udp',
      //   username: 'YOUR_USERNAME',
      //   credential: 'YOUR_PASSWORD',
      // },
      // {
      //   urls: 'turn:YOUR_TURN_SERVER_URL:PORT?transport=tcp',
      //   username: 'YOUR_USERNAME',
      //   credential: 'YOUR_PASSWORD',
      // },
    ],
  };

  // --- Socket.IO Initialization and Event Handlers ---
  function initializeSocket() {
    if (socket && socket.connected) {
      return;
    }
    socket = io();

    socket.on("connect", () => {
      console.log("Connected to Socket.IO:", socket.id);
      updateOverallStatus("Connected to server.", "info");
      resetAllTransferStates(); // Clear any stale state on fresh connect
      showNotification("Connected to FileShare server", "success");
    });

    socket.on("disconnect", () => {
      console.log("Disconnected from Socket.IO");
      updateOverallStatus("Disconnected from server. Please refresh.", "error");
      resetAllTransferStates();
      showNotification("Disconnected from server", "error");
    });

    // --- Signaling events (relayed by server) ---
    socket.on("webrtc_offer", async (data) => {
      console.log("Received WebRTC Offer:", data);
      if (!isSender && currentTransferCode === data.code && !peerConnection) {
        peerConnection = createPeerConnection(data.code, false); // Create receiver PC
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(data.offer),
        );
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit("webrtc_answer", {
          code: data.code,
          answer: peerConnection.localDescription,
          targetSocketId: data.senderSocketId,
        });
        receiveStatusMessage.textContent = "Negotiating connection...";
        updateStatusMessage(receiveStatusMessage, "info");
        showNotification("Negotiating connection...", "info");
      } else if (peerConnection) {
        console.warn(
          "Offer received but peerConnection already exists or I am sender.",
        );
      }
    });

    socket.on("webrtc_answer", async (data) => {
      console.log("Received WebRTC Answer:", data);
      if (isSender && currentTransferCode === data.code && peerConnection) {
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(data.answer),
        );
        sendStatusMessage.textContent =
          "Connection established. Ready to send.";
        updateStatusMessage(sendStatusMessage, "success");
        showNotification("Connection established. Ready to send file", "success");
      }
    });

    socket.on("webrtc_ice_candidate", async (data) => {
      // console.log("Received ICE Candidate:", data);
      if (
        currentTransferCode === data.code &&
        peerConnection &&
        data.candidate
      ) {
        try {
          await peerConnection.addIceCandidate(data.candidate);
        } catch (e) {
          console.error("Error adding received ICE candidate:", e);
        }
      }
    });

    socket.on("receiver_joined", async (data) => {
      console.log("Receiver joined for my code:", data);
      if (isSender && currentTransferCode === data.code) {
        sendStatusMessage.textContent = `Receiver connected. Preparing to send "${data.fileMetadata.fileName}"...`;
        updateStatusMessage(sendStatusMessage, "info");
        showNotification(`Receiver connected. Preparing to send "${data.fileMetadata.fileName}"`, "info");
        // Sender creates the offer and data channel
        peerConnection = createPeerConnection(
          data.code,
          true,
          data.receiverSocketId,
        );
        dataChannel = peerConnection.createDataChannel("fileTransfer", {
          ordered: true, // Ensure messages are delivered reliably and in order
          maxRetransmits: null, // No limit on retransmissions for reliability
        });
        setupDataChannelEvents(dataChannel, data.code); // Setup sender's data channel events

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit("webrtc_offer", {
          code: data.code,
          offer: peerConnection.localDescription,
          targetSocketId: data.receiverSocketId,
        });
      }
    });

    socket.on("transfer_interrupted", (data) => {
      console.warn("Transfer interrupted:", data);
      if (currentTransferCode === data.code) {
        const msg = `Transfer interrupted: ${data.message}`;
        updateOverallStatus(msg, "warning");
        resetAllTransferStates();
        showNotification(msg, "warning");
      }
    });
  }

  // --- WebRTC Peer Connection Setup ---
  function createPeerConnection(code, isInitiator, targetSocketId = null) {
    if (peerConnection) {
      console.warn(
        "Existing peerConnection detected, closing before creating new one.",
      );
      peerConnection.close();
      peerConnection = null;
    }

    const pc = new RTCPeerConnection(iceServers);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        // console.log("Sending ICE candidate:", event.candidate);
        socket.emit("webrtc_ice_candidate", {
          code: code,
          candidate: event.candidate,
          targetSocketId:
            targetSocketId ||
            (isInitiator ? currentReceiverSocketId : currentSenderSocketId),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`Connection State: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        if (isSender) {
          sendStatusMessage.textContent =
            "Peer connected! Waiting for data channel...";
          updateStatusMessage(sendStatusMessage, "success");
          showNotification("Peer connected! Waiting for data channel...", "success");
        } else {
          receiveStatusMessage.textContent =
            "Peer connected! Waiting for data channel...";
          updateStatusMessage(receiveStatusMessage, "success");
          showNotification("Peer connected! Waiting for data channel...", "success");
        }
      } else if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
        const msg = `Connection failed or disconnected: ${pc.connectionState}.`;
        console.error(msg);
        updateOverallStatus(msg, "error");
        resetAllTransferStates();
        showNotification(msg, "error");
      }
    };

    pc.ondatachannel = (event) => {
      console.log("Received Data Channel:", event);
      if (!isInitiator) {
        // Receiver receives the data channel
        dataChannel = event.channel;
        setupDataChannelEvents(dataChannel, code);
      }
    };

    pc.onnegotiationneeded = async () => {
      // This event fires on the initiator (sender in our case)
      if (isInitiator) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit("webrtc_offer", {
            code: code,
            offer: pc.localDescription,
            targetSocketId: targetSocketId, // Ensure we send to the correct receiver
          });
        } catch (e) {
          console.error("Error on negotiationneeded:", e);
        }
      }
    };

    return pc;
  }

  // --- Data Channel Event Handlers ---
  function setupDataChannelEvents(channel, code) {
    channel.onopen = () => {
      console.log("Data channel is open!");
      if (isSender) {
        sendStatusMessage.textContent =
          "Data channel open! Starting file transfer...";
        updateStatusMessage(sendStatusMessage, "info");
        showProgressDisplay(sendProgressContainer);
        showNotification("Data channel open! Starting file transfer...", "info");
        sendFileOverDataChannel(fileToSend, channel, code);
      } else {
        receiveStatusMessage.textContent =
          "Data channel open! Ready to receive file.";
        updateStatusMessage(receiveStatusMessage, "info");
        showProgressDisplay(receiveProgressContainer);
        showNotification("Data channel open! Ready to receive file", "info");
      }
    };

    channel.onclose = () => {
      console.log("Data channel closed.");
      // This might fire multiple times or on normal completion.
      // Finalize logic should primarily be in the 'complete' message handler.
      if (isSender && bytesSent < fileToSend.size) {
        // Check if sender didn't finish
        updateOverallStatus(
          "Sender: Data channel closed before transfer complete.",
          "warning",
        );
        resetAllTransferStates();
        showNotification("Data channel closed before transfer complete", "warning");
      } else if (!isSender && receivedBytes < fileMetadata.fileSize) {
        // Check if receiver didn't finish
        updateOverallStatus(
          "Receiver: Data channel closed before transfer complete.",
          "warning",
        );
        resetAllTransferStates();
        showNotification("Data channel closed before transfer complete", "warning");
      }
    };

    channel.onerror = (error) => {
      console.error("Data channel error:", error);
      const msg = `Data channel error: ${error.message}`;
      updateOverallStatus(msg, "error");
      resetAllTransferStates();
      showNotification(msg, "error");
    };

    channel.onmessage = (event) => {
      if (!isSender) {
        handleReceivedMessage(event.data, code);
      }
    };
  }

  // --- File Sending Logic (Sender) ---
  async function sendFileOverDataChannel(file, channel, code) {
    bytesSent = 0;
    sendStartTime = Date.now();
    lastBytesSent = 0;
    lastSendTime = Date.now();
    readOffset = 0;

    // First send file metadata
    const metadata = {
      type: "metadata",
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      code: code, // Include code for receiver context
    };
    channel.send(JSON.stringify(metadata));
    console.log("Sent file metadata:", metadata);

    const fileReader = new FileReader();

    fileReader.onload = (event) => {
      const chunk = event.target.result; // ArrayBuffer
      if (channel.readyState === "open") {
        try {
          channel.send(chunk);
          bytesSent += chunk.byteLength;
          updateSenderProgress(file.size, code);

          readOffset += chunk.byteLength;
          if (readOffset < file.size) {
            readNextChunk();
          } else {
            console.log("File sending complete!");
            sendStatusMessage.textContent = `File "${file.name}" sent successfully!`;
            updateStatusMessage(sendStatusMessage, "success");
            showNotification(`File "${file.name}" sent successfully!`, "success");
            // Optionally send a "transfer_complete" message to receiver via data channel
            channel.send(JSON.stringify({ type: "complete", code: code }));
          }
        } catch (e) {
          console.error("Error sending chunk over data channel:", e);
          updateOverallStatus(
            `Sender: Error sending chunk: ${e.message}`,
            "error",
          );
          resetAllTransferStates();
          showNotification(`Error sending chunk: ${e.message}`, "error");
        }
      } else {
        console.warn("Data channel not open, cannot send chunk.");
        updateOverallStatus(
          "Sender: Data channel closed, transfer interrupted.",
          "warning",
        );
        resetAllTransferStates();
        showNotification("Data channel closed, transfer interrupted", "warning");
      }
    };

    fileReader.onerror = (error) => {
      console.error("Error reading file:", error);
      updateOverallStatus(`Error reading file: ${error.message}`, "error");
      resetAllTransferStates();
      showNotification(`Error reading file: ${error.message}`, "error");
    };

    function readNextChunk() {
      const slice = file.slice(readOffset, readOffset + CHUNK_SIZE);
      fileReader.readAsArrayBuffer(slice);
    }

    readNextChunk(); // Start reading the first chunk
  }

  function updateSenderProgress(fileSize, code) {
    const currentTime = Date.now();
    const elapsedTimeSinceLastUpdate = (currentTime - lastSendTime) / 1000;
    const bytesSentThisInterval = bytesSent - lastBytesSent;

    if (elapsedTimeSinceLastUpdate > 0) {
      sendSpeedMbps =
        (bytesSentThisInterval * 8) /
        (elapsedTimeSinceLastUpdate * 1024 * 1024);
    } else {
      sendSpeedMbps = 0; // Avoid division by zero
    }

    const percentage = Math.min(100, (bytesSent / fileSize) * 100).toFixed(2);
    const remainingBytes = fileSize - bytesSent;
    let etaSeconds =
      sendSpeedMbps > 0
        ? remainingBytes / ((sendSpeedMbps * 1024 * 1024) / 8)
        : Infinity;

    let etaFormatted = "--:--";
    if (etaSeconds !== Infinity) {
      const minutes = Math.floor(etaSeconds / 60);
      const seconds = Math.floor(etaSeconds % 60);
      etaFormatted = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }

    const progressData = {
      code: code,
      percentage: parseFloat(percentage),
      speed: parseFloat(sendSpeedMbps.toFixed(2)),
      eta: etaFormatted,
      bytesTransferred: bytesSent,
      fileSize: fileSize,
    };

    updateProgressUI(
      sendProgressBar,
      sendProgressPercent,
      sendSpeed,
      sendETA,
      progressData,
    );

    lastBytesSent = bytesSent;
    lastSendTime = currentTime;
  }

  // --- File Receiving Logic (Receiver) ---
  function handleReceivedMessage(data, code) {
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "metadata") {
          fileMetadata = msg;
          console.log("Received file metadata:", fileMetadata);
          receiveStatusMessage.textContent = `Receiving "${fileMetadata.fileName}"...`;
          updateStatusMessage(receiveStatusMessage, "info");
          showNotification(`Receiving "${fileMetadata.fileName}"...`, "info");
          receivedBytes = 0; // Reset for new transfer
          receivedChunks.length = 0; // Clear previous chunks
          downloadStartTime = Date.now();
          lastReceivedBytes = 0;
          lastReceiveTime = Date.now();
        } else if (msg.type === "complete") {
          console.log("File transfer complete via data channel message.");
          finalizeReceivedFile(code);
        }
      } catch (e) {
        console.warn("Received non-JSON string message:", data, e);
        // Treat as a chunk if parsing failed but we are expecting file data
        if (fileMetadata && data.length < 1000) {
          // Simple heuristic: if it's a short string, might be a malformed chunk
          processFileChunk(data, code); // Try to process as chunk
        } else if (fileMetadata) {
          console.warn(
            "Received large string as data after metadata, might be corrupted chunk.",
          );
          // Potentially handle as error or discard
        }
      }
    } else if (data instanceof ArrayBuffer) {
      if (fileMetadata) {
        processFileChunk(data, code);
      } else {
        console.warn("Received file chunk before metadata. Discarding.");
      }
    }
  }

  function processFileChunk(chunk, code) {
    receivedChunks.push(chunk);
    receivedBytes += chunk.byteLength;

    updateReceiverProgress(fileMetadata.fileSize, code);

    if (receivedBytes >= fileMetadata.fileSize) {
      console.log(
        "All chunks received based on file size. Waiting for completion message.",
      );
      // The 'complete' message from sender will trigger finalizeReceivedFile
    }
  }

  function updateReceiverProgress(fileSize, code) {
    const currentTime = Date.now();
    const elapsedTimeSinceLastUpdate = (currentTime - lastReceiveTime) / 1000;
    const bytesReceivedThisInterval = receivedBytes - lastReceivedBytes;

    if (elapsedTimeSinceLastUpdate > 0) {
      receiveSpeedMbps =
        (bytesReceivedThisInterval * 8) /
        (elapsedTimeSinceLastUpdate * 1024 * 1024);
    } else {
      receiveSpeedMbps = 0;
    }

    const percentage = Math.min(100, (receivedBytes / fileSize) * 100).toFixed(
      2,
    );
    const remainingBytes = fileSize - receivedBytes;
    let etaSeconds =
      receiveSpeedMbps > 0
        ? remainingBytes / ((receiveSpeedMbps * 1024 * 1024) / 8)
        : Infinity;

    let etaFormatted = "--:--";
    if (etaSeconds !== Infinity) {
      const minutes = Math.floor(etaSeconds / 60);
      const seconds = Math.floor(etaSeconds % 60);
      etaFormatted = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }

    const progressData = {
      code: code,
      percentage: parseFloat(percentage),
      speed: parseFloat(receiveSpeedMbps.toFixed(2)),
      eta: etaFormatted,
      bytesTransferred: receivedBytes,
      fileSize: fileSize,
    };

    updateProgressUI(
      receiveProgressBar,
      receiveProgressPercent,
      receiveSpeed,
      receiveETA,
      progressData,
    );

    lastReceivedBytes = receivedBytes;
    lastReceiveTime = currentTime;
  }

  function finalizeReceivedFile(code) {
    if (!fileMetadata) {
      console.error("Cannot finalize file: no metadata available.");
      updateOverallStatus(
        "Error: No file metadata to finalize download.",
        "error",
      );
      resetAllTransferStates();
      showNotification("Error: No file metadata to finalize download", "error");
      return;
    }
    if (receivedBytes < fileMetadata.fileSize) {
      console.warn(
        "Received complete message, but total bytes received less than expected. Data might be incomplete.",
      );
      // Attempt to download what was received anyway
    }

    const receivedBlob = new Blob(receivedChunks, {
      type: fileMetadata.fileType,
    });
    const downloadUrl = URL.createObjectURL(receivedBlob);

    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = fileMetadata.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);

    receiveStatusMessage.textContent = `File "${fileMetadata.fileName}" downloaded successfully!`;
    updateStatusMessage(receiveStatusMessage, "success");
    updateReceiverProgress(fileMetadata.fileSize, code); // Final 100% update
    showNotification(`File "${fileMetadata.fileName}" downloaded successfully!`, "success");
    resetAllTransferStates();
  }

  // --- UI Utility Functions ---
  function showProgressDisplay(container) {
    container.classList.remove("hidden");
    container.classList.add("show");
  }

  function resetProgressDisplay(container) {
    container.classList.remove("show");
    container.classList.add("hidden");
    const progressBar = container.querySelector(".progress-bar-inner");
    const progressPercent = container.querySelector(
      ".progress-text span:nth-child(1)",
    );
    const speed = container.querySelector(".progress-text span:nth-child(2)");
    const eta = container.querySelector(".transfer-details span");

    if (progressBar) progressBar.style.width = "0%";
    if (progressPercent) progressPercent.textContent = "0%";
    if (speed) speed.textContent = "0 Mbps";
    if (eta) eta.textContent = "ETA: --:--";
  }

  function updateProgressUI(
    progressBar,
    progressPercent,
    speedDisplay,
    etaDisplay,
    data,
  ) {
    progressBar.style.width = `${data.percentage}%`;
    progressPercent.textContent = `${data.percentage}%`;
    speedDisplay.textContent = `${data.speed} Mbps`;
    etaDisplay.textContent = `ETA: ${data.eta}`;

    // Ensure status message is not showing an error color during active transfer
    const statusMessageElement = progressBar
      .closest(".transfer-box")
      .querySelector(".status-message");
    if (statusMessageElement && statusMessageElement.classList.contains("error")) {
      updateStatusMessage(statusMessageElement, "info");
    }
  }

  function updateOverallStatus(message, type = "info") {
    updateStatusMessage(sendStatusMessage, type);
    sendStatusMessage.textContent = message;
    updateStatusMessage(receiveStatusMessage, type);
    receiveStatusMessage.textContent = message;
  }

  function updateStatusMessage(element, type) {
    // Remove all status classes
    element.classList.remove("error", "success", "info", "warning");
    // Add the appropriate class
    element.classList.add(type);
  }

  function showCodePopup(code) {
    displayCode.textContent = code;
    codePopup.classList.add("show");
    codePopup.classList.remove("hidden");
  }

  function hideCodePopup() {
    codePopup.classList.remove("show");
    codePopup.classList.add("hidden");
    displayCode.textContent = "";
  }

  // Notification system
  function showNotification(message, type) {
    // Create notification element
    const notification = document.createElement("div");
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
      <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle'}"></i>
      <span>${message}</span>
    `;
    
    // Add to body
    document.body.appendChild(notification);
    
    // Remove after 3 seconds
    setTimeout(() => {
      notification.classList.add("hide");
      setTimeout(() => {
        document.body.removeChild(notification);
      }, 300);
    }, 3000);
  }

  function resetAllTransferStates() {
    if (peerConnection) {
      peerConnection.close();
    }
    peerConnection = null;
    dataChannel = null;
    currentTransferCode = null;
    isSender = false;
    fileToSend = null;

    receivedChunks.length = 0;
    receivedBytes = 0;
    fileMetadata = null;
    downloadStartTime = null;
    lastReceivedBytes = 0;
    lastReceiveTime = Date.now();
    receiveSpeedMbps = 0;

    bytesSent = 0;
    sendStartTime = null;
    lastBytesSent = 0;
    lastSendTime = Date.now();
    sendSpeedMbps = 0;

    hideCodePopup();
    resetProgressDisplay(sendProgressContainer);
    resetProgressDisplay(receiveProgressContainer);

    sendStatusMessage.textContent =
      "Connected to server. Select a file to send.";
    updateStatusMessage(sendStatusMessage, "info");
    receiveStatusMessage.textContent =
      "Connected to server. Enter code to receive.";
    updateStatusMessage(receiveStatusMessage, "info");

    fileInput.value = ""; // Clear file input
    fileInput.setAttribute("data-file-name", ""); // Clear custom display
    sendButton.disabled = true; // Disable send button until file is chosen
    receiveCodeInput.value = ""; // Clear receive input
    receiveButton.disabled = false; // Enable receive button
  }

  // --- Event Listeners ---

  // Custom file input display logic
  fileInput.addEventListener("change", function () {
    fileToSend = this.files[0];
    if (fileToSend) {
      const fileName = fileToSend.name;
      this.setAttribute("data-file-name", fileName);
      sendStatusMessage.textContent = `File selected: ${fileName}`;
      updateStatusMessage(sendStatusMessage, "info");
      sendButton.disabled = false; // Enable send button
    } else {
      this.setAttribute("data-file-name", "");
      sendStatusMessage.textContent = "Please select a file.";
      updateStatusMessage(sendStatusMessage, "error");
      sendButton.disabled = true; // Disable send button
    }
    resetProgressDisplay(sendProgressContainer);
  });

  // Send Button Logic
  sendButton.addEventListener("click", async () => {
    if (!fileToSend) {
      sendStatusMessage.textContent = "Please select a file first.";
      updateStatusMessage(sendStatusMessage, "error");
      showNotification("Please select a file first", "error");
      return;
    }

    if (!socket || !socket.connected) {
      updateOverallStatus(
        "Connection lost. Please refresh and try again.",
        "error",
      );
      showNotification("Connection lost. Please refresh and try again.", "error");
      initializeSocket(); // Try to reconnect
      return;
    }

    isSender = true;
    sendStatusMessage.textContent = "Generating code...";
    updateStatusMessage(sendStatusMessage, "info");
    hideCodePopup();
    resetProgressDisplay(sendProgressContainer);
    sendButton.disabled = true; // Disable button during process

    // Request a code from the server
    socket.emit("register_sender", (response) => {
      if (response.code) {
        currentTransferCode = response.code;
        showCodePopup(currentTransferCode);
        sendStatusMessage.textContent = `Share code ${currentTransferCode}. Waiting for friend...`;
        updateStatusMessage(sendStatusMessage, "success");
        showNotification(`Share code ${currentTransferCode} with your friend`, "info");

        // Store file metadata for signaling server (not sending file data here)
        fileMetadata = {
          // Store it locally too
          fileName: fileToSend.name,
          fileSize: fileToSend.size,
          fileType: fileToSend.type,
          code: currentTransferCode,
        };
        socket.emit("sender_file_metadata", fileMetadata); // Inform server about metadata
      } else {
        sendStatusMessage.textContent = `Error generating code: ${response.message || "Unknown error"}`;
        updateStatusMessage(sendStatusMessage, "error");
        showNotification(`Error generating code: ${response.message || "Unknown error"}`, "error");
        resetAllTransferStates();
      }
      sendButton.disabled = false; // Re-enable if not waiting
    });
  });

  // Receive Button Logic
  receiveButton.addEventListener("click", async () => {
    const code = receiveCodeInput.value.trim();

    if (!code) {
      receiveStatusMessage.textContent = "Please enter a receive code.";
      updateStatusMessage(receiveStatusMessage, "error");
      showNotification("Please enter a receive code", "error");
      return;
    }

    if (!socket || !socket.connected) {
      updateOverallStatus(
        "Connection lost. Please refresh and try again.",
        "error",
      );
      showNotification("Connection lost. Please refresh and try again.", "error");
      initializeSocket(); // Try to reconnect
      return;
    }

    isSender = false;
    currentTransferCode = code; // Set active code for receiver
    receiveStatusMessage.textContent = `Joining code "${code}"...`;
    updateStatusMessage(receiveStatusMessage, "info");
    resetProgressDisplay(receiveProgressContainer);
    receiveButton.disabled = true; // Disable button during process

    socket.emit("register_receiver", code, (response) => {
      if (response.success) {
        console.log("Joined as receiver. Response:", response);
        fileMetadata = response.fileMetadata; // Store metadata
        if (fileMetadata) {
          receiveStatusMessage.textContent = `Code accepted. Waiting for sender to connect for "${fileMetadata.fileName}"...`;
        } else {
          receiveStatusMessage.textContent =
            "Code accepted. Waiting for sender to connect...";
        }
        updateStatusMessage(receiveStatusMessage, "success");
        showNotification("Code accepted. Waiting for sender to connect...", "success");
        peerConnection = createPeerConnection(
          code,
          false,
          response.senderSocketId,
        ); // Create PC for receiver
        // Data channel will be created by sender and received via pc.ondatachannel
      } else {
        receiveStatusMessage.textContent = `Error: ${response.message || "Invalid or expired code."}`;
        updateStatusMessage(receiveStatusMessage, "error");
        showNotification(`Error: ${response.message || "Invalid or expired code."}`, "error");
        resetAllTransferStates();
      }
      receiveButton.disabled = false; // Re-enable if not waiting
    });
  });

  // Popup Event Listeners
  copyCodeButton.addEventListener("click", () => {
    const codeToCopy = displayCode.textContent;
    navigator.clipboard
      .writeText(codeToCopy)
      .then(() => {
        // Show visual feedback
        const originalText = copyCodeButton.innerHTML;
        copyCodeButton.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => {
          copyCodeButton.innerHTML = originalText;
        }, 2000);
        showNotification("Code copied to clipboard!", "success");
      })
      .catch((err) => {
        console.error("Failed to copy text: ", err);
        showNotification("Failed to copy code. Please copy manually.", "error");
        alert("Failed to copy code. Please copy manually.");
      });
  });

  closePopupButton.addEventListener("click", hideCodePopup);

  // Close popup if clicked outside
  codePopup.addEventListener("click", (e) => {
    if (e.target === codePopup) {
      hideCodePopup();
    }
  });

  // Add notification container to body
  const notificationContainer = document.createElement("div");
  notificationContainer.className = "notification-container";
  document.body.appendChild(notificationContainer);

  // Initial setup
  initializeSocket();
  sendButton.disabled = true; // Initially disable send button until file is chosen
});