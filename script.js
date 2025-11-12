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

  // Optimize chunk size for maximum performance - increased to 1MB
  const CHUNK_SIZE = 1024 * 1024; // 1MB chunks for faster transfers
  let readOffset = 0; // Current position in the file being read

  // Enhanced STUN/TURN servers configuration for better connectivity
  const iceServers = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.stunprotocol.org:3478" },
      { urls: "stun:stun.voiparound.com" },
      { urls: "stun:stun.voipbuster.com" },
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
          "Connection established. Waiting for data channel...";
        updateStatusMessage(sendStatusMessage, "info");
        showNotification("Connection established. Waiting for data channel...", "info");
      }
    });

    socket.on("webrtc_ice_candidate", async (data) => {
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
          ordered: true,
          maxRetransmits: null,
          maxPacketLifeTime: null,
        });
        setupDataChannelEvents(dataChannel, data.code); // Setup sender's data channel events

        const offer = await peerConnection.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false,
        });
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

    const pc = new RTCPeerConnection({
      ...iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 10,
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
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
        dataChannel = event.channel;
        dataChannel.binaryType = "arraybuffer";
        setupDataChannelEvents(dataChannel, code);
      }
    };

    pc.onnegotiationneeded = async () => {
      if (isInitiator && peerConnection && peerConnection.signalingState === "stable") {
        try {
          const offer = await pc.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false,
          });
          await pc.setLocalDescription(offer);
          socket.emit("webrtc_offer", {
            code: code,
            offer: pc.localDescription,
            targetSocketId: targetSocketId,
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
    channel.binaryType = "arraybuffer";
    
    channel.onopen = () => {
      console.log("Data channel is open!");
      if (isSender) {
        sendStatusMessage.textContent =
          "Data channel open! Starting file transfer...";
        updateStatusMessage(sendStatusMessage, "info");
        showProgressDisplay(sendProgressContainer);
        showNotification("Data channel open! Starting file transfer...", "info");
        // Start sending file immediately when data channel opens
        setTimeout(() => {
          sendFileOverDataChannel(fileToSend, channel, code);
        }, 100);
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
      if (isSender && bytesSent < fileToSend.size) {
        updateOverallStatus(
          "Sender: Data channel closed before transfer complete.",
          "warning",
        );
        resetAllTransferStates();
        showNotification("Data channel closed before transfer complete", "warning");
      } else if (!isSender && receivedBytes < fileMetadata.fileSize) {
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
    if (!file) {
      console.error("No file to send");
      updateOverallStatus("Error: No file selected to send.", "error");
      showNotification("Error: No file selected to send.", "error");
      return;
    }

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
      code: code,
    };
    
    try {
      channel.send(JSON.stringify(metadata));
      console.log("Sent file metadata:", metadata);
      sendStatusMessage.textContent = `Sending "${file.name}"...`;
      updateStatusMessage(sendStatusMessage, "info");
    } catch (e) {
      console.error("Error sending metadata:", e);
      updateOverallStatus(`Error sending metadata: ${e.message}`, "error");
      showNotification(`Error sending metadata: ${e.message}`, "error");
      return;
    }

    const fileReader = new FileReader();

    fileReader.onload = (event) => {
      const chunk = event.target.result;
      if (channel.readyState === "open") {
        try {
          channel.send(chunk);
          bytesSent += chunk.byteLength;
          updateSenderProgress(file.size, code);

          readOffset += chunk.byteLength;
          if (readOffset < file.size) {
            setTimeout(readNextChunk, 0);
          } else {
            console.log("File sending complete!");
            sendStatusMessage.textContent = `File "${file.name}" sent successfully!`;
            updateStatusMessage(sendStatusMessage, "success");
            showNotification(`File "${file.name}" sent successfully!`, "success");
            try {
              channel.send(JSON.stringify({ type: "complete", code: code }));
            } catch (e) {
              console.error("Error sending completion message:", e);
            }
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

    readNextChunk();
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
      sendSpeedMbps = 0;
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
          receivedBytes = 0;
          receivedChunks.length = 0;
          downloadStartTime = Date.now();
          lastReceivedBytes = 0;
          lastReceiveTime = Date.now();
        } else if (msg.type === "complete") {
          console.log("File transfer complete via data channel message.");
          finalizeReceivedFile(code);
        }
      } catch (e) {
        console.warn("Received non-JSON string message:", data, e);
        if (fileMetadata && data.length < 1000) {
          processFileChunk(data, code);
        } else if (fileMetadata) {
          console.warn(
            "Received large string as data after metadata, might be corrupted chunk.",
          );
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
    updateReceiverProgress(fileMetadata.fileSize, code);
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
    element.classList.remove("error", "success", "info", "warning");
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
    const notification = document.createElement("div");
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
      <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle'}"></i>
      <span>${message}</span>
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.classList.add("show");
    }, 10);
    
    setTimeout(() => {
      notification.classList.remove("show");
      setTimeout(() => {
        if (notification.parentNode) {
          document.body.removeChild(notification);
        }
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

    fileInput.value = "";
    fileInput.setAttribute("data-file-name", "");
    sendButton.disabled = true;
    receiveCodeInput.value = "";
    receiveButton.disabled = false;
  }

  // --- Event Listeners ---
  fileInput.addEventListener("change", function () {
    fileToSend = this.files[0];
    if (fileToSend) {
      const fileName = fileToSend.name;
      this.setAttribute("data-file-name", fileName);
      sendStatusMessage.textContent = `File selected: ${fileName}`;
      updateStatusMessage(sendStatusMessage, "info");
      sendButton.disabled = false;
    } else {
      this.setAttribute("data-file-name", "");
      sendStatusMessage.textContent = "Please select a file.";
      updateStatusMessage(sendStatusMessage, "error");
      sendButton.disabled = true;
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
      initializeSocket();
      return;
    }

    isSender = true;
    sendStatusMessage.textContent = "Generating code...";
    updateStatusMessage(sendStatusMessage, "info");
    hideCodePopup();
    resetProgressDisplay(sendProgressContainer);
    sendButton.disabled = true;

    socket.emit("register_sender", (response) => {
      if (response.code) {
        currentTransferCode = response.code;
        showCodePopup(currentTransferCode);
        sendStatusMessage.textContent = `Share code ${currentTransferCode}. Waiting for friend...`;
        updateStatusMessage(sendStatusMessage, "success");
        showNotification(`Share code ${currentTransferCode} with your friend`, "info");

        fileMetadata = {
          fileName: fileToSend.name,
          fileSize: fileToSend.size,
          fileType: fileToSend.type,
          code: currentTransferCode,
        };
        socket.emit("sender_file_metadata", fileMetadata);
      } else {
        sendStatusMessage.textContent = `Error generating code: ${response.error || "Unknown error"}`;
        updateStatusMessage(sendStatusMessage, "error");
        showNotification(`Error generating code: ${response.error || "Unknown error"}`, "error");
        resetAllTransferStates();
      }
      sendButton.disabled = false;
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

    if (!/^\d{6}$/.test(code)) {
      receiveStatusMessage.textContent = "Please enter a valid 6-digit code.";
      updateStatusMessage(receiveStatusMessage, "error");
      showNotification("Please enter a valid 6-digit code", "error");
      return;
    }

    if (!socket || !socket.connected) {
      updateOverallStatus(
        "Connection lost. Please refresh and try again.",
        "error",
      );
      showNotification("Connection lost. Please refresh and try again.", "error");
      initializeSocket();
      return;
    }

    isSender = false;
    currentTransferCode = code;
    receiveStatusMessage.textContent = `Joining code "${code}"...`;
    updateStatusMessage(receiveStatusMessage, "info");
    resetProgressDisplay(receiveProgressContainer);
    receiveButton.disabled = true;

    socket.emit("register_receiver", code, (response) => {
      if (response.success) {
        console.log("Joined as receiver. Response:", response);
        fileMetadata = response.fileMetadata;
        if (response.message) {
          receiveStatusMessage.textContent = response.message;
          updateStatusMessage(receiveStatusMessage, "info");
          showNotification(response.message, "info");
        } else if (fileMetadata) {
          receiveStatusMessage.textContent = `Code accepted. Waiting for sender to connect for "${fileMetadata.fileName}"...`;
          updateStatusMessage(receiveStatusMessage, "info");
          showNotification(`Code accepted. Waiting for sender to connect for "${fileMetadata.fileName}"...`, "info");
        } else {
          receiveStatusMessage.textContent =
            "Code accepted. Waiting for sender to connect...";
          updateStatusMessage(receiveStatusMessage, "info");
          showNotification("Code accepted. Waiting for sender to connect...", "info");
        }
        
        if (response.senderSocketId) {
          peerConnection = createPeerConnection(
            code,
            false,
            response.senderSocketId,
          );
        }
      } else {
        receiveStatusMessage.textContent = `Error: ${response.message || "Invalid or expired code."}`;
        updateStatusMessage(receiveStatusMessage, "error");
        showNotification(`Error: ${response.message || "Invalid or expired code."}`, "error");
        resetAllTransferStates();
      }
      receiveButton.disabled = false;
    });
  });

  // Popup Event Listeners
  copyCodeButton.addEventListener("click", () => {
    const codeToCopy = displayCode.textContent;
    navigator.clipboard
      .writeText(codeToCopy)
      .then(() => {
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

  codePopup.addEventListener("click", (e) => {
    if (e.target === codePopup) {
      hideCodePopup();
    }
  });

  const notificationContainer = document.createElement("div");
  notificationContainer.className = "notification-container";
  document.body.appendChild(notificationContainer);

  initializeSocket();
  sendButton.disabled = true;
});

if (typeof window.setImmediate === 'undefined') {
  window.setImmediate = function(callback) {
    return setTimeout(callback, 0);
  };
}