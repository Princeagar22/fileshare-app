document.addEventListener("DOMContentLoaded", () => {
  // --- UI Elements ---
  const fileInput = document.getElementById("fileInput");
  const sendButton = document.getElementById("sendButton");
  const sendStatusMessage = document.getElementById("sendStatusMessage");
  const sendProgressContainer = document.getElementById(
    "sendProgressContainer",
  );
  const sendProgressBar = document.getElementById("sendProgressBar");
  const sendProgressPercent = document.getElementById("sendProgressPercent");
  const sendSpeed = document.getElementById("sendSpeed");
  const sendETA = document.getElementById("sendETA");

  const receiveCodeInput = document.getElementById("receiveCodeInput");
  const receiveButton = document.getElementById("receiveButton");
  const receiveStatusMessage = document.getElementById("receiveStatusMessage");
  const receiveProgressContainer = document.getElementById(
    "receiveProgressContainer",
  );
  const receiveProgressBar = document.getElementById("receiveProgressBar");
  const receiveProgressPercent = document.getElementById(
    "receiveProgressPercent",
  );
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
  let downloadStartTime = null;
  let lastReceivedBytes = 0;
  let lastReceiveTime = Date.now();
  let receiveSpeedMbps = 0;

  // STUN servers for NAT traversal (Google's public STUN server is commonly used)
  const iceServers = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      // You might need TURN servers for more complex network setups (e.g., restricted corporate networks)
      // { urls: 'turn:YOUR_TURN_SERVER_URL', username: 'YOUR_USERNAME', credential: 'YOUR_PASSWORD' }
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
      sendStatusMessage.textContent = "Connected to server.";
      sendStatusMessage.style.color = "initial";
      receiveStatusMessage.textContent =
        "Connected to server. Enter code to receive.";
      receiveStatusMessage.style.color = "initial";
    });

    socket.on("disconnect", () => {
      console.log("Disconnected from Socket.IO");
      sendStatusMessage.textContent =
        "Disconnected from server. Please refresh.";
      sendStatusMessage.style.color = "red";
      receiveStatusMessage.textContent =
        "Disconnected from server. Please refresh.";
      receiveStatusMessage.style.color = "red";
      resetAllTransferStates();
    });

    // --- Signaling events (relayed by server) ---
    socket.on("webrtc_offer", async (data) => {
      console.log("Received WebRTC Offer:", data);
      if (!isSender && currentTransferCode === data.code) {
        // Only receiver should process this
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
        receiveStatusMessage.style.color = "blue";
      }
    });

    socket.on("webrtc_answer", async (data) => {
      console.log("Received WebRTC Answer:", data);
      if (isSender && currentTransferCode === data.code) {
        // Only sender should process this
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(data.answer),
        );
        sendStatusMessage.textContent =
          "Connection established. Ready to send.";
        sendStatusMessage.style.color = "green";
      }
    });

    socket.on("webrtc_ice_candidate", async (data) => {
      console.log("Received ICE Candidate:", data);
      if (currentTransferCode === data.code && peerConnection) {
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
        sendStatusMessage.style.color = "blue";
        // Sender creates the offer and data channel
        peerConnection = createPeerConnection(
          data.code,
          true,
          data.receiverSocketId,
        );
        dataChannel = peerConnection.createDataChannel("fileTransfer", {
          reliable: true,
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
        sendStatusMessage.textContent = msg;
        sendStatusMessage.style.color = "orange";
        receiveStatusMessage.textContent = msg;
        receiveStatusMessage.style.color = "orange";
        resetAllTransferStates();
      }
    });
  }

  // --- WebRTC Peer Connection Setup ---
  function createPeerConnection(code, isInitiator, targetSocketId = null) {
    const pc = new RTCPeerConnection(iceServers);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("Sending ICE candidate:", event.candidate);
        socket.emit("webrtc_ice_candidate", {
          code: code,
          candidate: event.candidate,
          targetSocketId:
            targetSocketId ||
            (isInitiator ? currentReceiverSocketId : currentSenderSocketId), // Determine target
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`Connection State: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        if (isSender) {
          sendStatusMessage.textContent = "Peer connected! Ready to send file.";
          sendStatusMessage.style.color = "green";
        } else {
          receiveStatusMessage.textContent =
            "Peer connected! Waiting for file.";
          receiveStatusMessage.style.color = "green";
        }
      } else if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
        const msg = `Connection failed or disconnected: ${pc.connectionState}.`;
        console.error(msg);
        if (isSender) sendStatusMessage.textContent = msg;
        else receiveStatusMessage.textContent = msg;
        resetAllTransferStates();
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

    return pc;
  }

  // --- Data Channel Event Handlers ---
  function setupDataChannelEvents(channel, code) {
    channel.onopen = () => {
      console.log("Data channel is open!");
      if (isSender) {
        sendStatusMessage.textContent =
          "Data channel open! Starting file transfer...";
        sendStatusMessage.style.color = "blue";
        showProgressDisplay(sendProgressContainer);
        sendFileOverDataChannel(fileToSend, channel, code);
      } else {
        receiveStatusMessage.textContent =
          "Data channel open! Ready to receive file.";
        receiveStatusMessage.style.color = "blue";
        showProgressDisplay(receiveProgressContainer);
        // Receiver waits for metadata first, then file chunks
      }
    };

    channel.onclose = () => {
      console.log("Data channel closed.");
      if (isSender)
        sendStatusMessage.textContent =
          "File transfer finished (channel closed).";
      else
        receiveStatusMessage.textContent =
          "File transfer finished (channel closed).";
      resetAllTransferStates();
    };

    channel.onerror = (error) => {
      console.error("Data channel error:", error);
      const msg = `Data channel error: ${error.message}`;
      if (isSender) sendStatusMessage.textContent = msg;
      else receiveStatusMessage.textContent = msg;
      resetAllTransferStates();
    };

    channel.onmessage = (event) => {
      if (!isSender) {
        // Receiver processes incoming messages
        handleReceivedMessage(event.data, code);
      }
    };
  }

  // --- File Sending Logic (Sender) ---
  const CHUNK_SIZE = 16 * 1024; // 16KB chunks
  let bytesSent = 0;
  let sendStartTime = null;
  let lastBytesSent = 0;
  let lastSendTime = Date.now();

  async function sendFileOverDataChannel(file, channel, code) {
    bytesSent = 0;
    sendStartTime = Date.now();
    lastBytesSent = 0;
    lastSendTime = Date.now();

    // First send file metadata
    const metadata = {
      type: "metadata",
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
    };
    channel.send(JSON.stringify(metadata));
    console.log("Sent file metadata:", metadata);

    const fileReader = new FileReader();
    let offset = 0;

    fileReader.onload = (event) => {
      const chunk = event.target.result;
      channel.send(chunk);
      bytesSent += chunk.byteLength;

      updateSenderProgress(file.size, code);

      offset += chunk.byteLength;
      if (offset < file.size) {
        readNextChunk();
      } else {
        console.log("File sending complete!");
        sendStatusMessage.textContent = `File "${file.name}" sent successfully!`;
        sendStatusMessage.style.color = "green";
        // Optionally send a "transfer_complete" message
        channel.send(JSON.stringify({ type: "complete", code: code }));
      }
    };

    fileReader.onerror = (error) => {
      console.error("Error reading file:", error);
      sendStatusMessage.textContent = `Error reading file: ${error.message}`;
      sendStatusMessage.style.color = "red";
      resetAllTransferStates();
    };

    function readNextChunk() {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      fileReader.readAsArrayBuffer(slice);
    }

    readNextChunk(); // Start reading the first chunk
  }

  function updateSenderProgress(fileSize, code) {
    const currentTime = Date.now();
    const elapsedTimeSinceLastUpdate = (currentTime - lastSendTime) / 1000;
    const bytesSentThisInterval = bytesSent - lastBytesSent;

    let speedMbps = 0;
    if (elapsedTimeSinceLastUpdate > 0) {
      speedMbps =
        (bytesSentThisInterval * 8) /
        (elapsedTimeSinceLastUpdate * 1024 * 1024);
    }

    const percentage = Math.min(100, (bytesSent / fileSize) * 100).toFixed(2);
    const remainingBytes = fileSize - bytesSent;
    let etaSeconds =
      speedMbps > 0
        ? remainingBytes / ((speedMbps * 1024 * 1024) / 8)
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
      speed: parseFloat(speedMbps.toFixed(2)),
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
          receiveStatusMessage.style.color = "blue";
          receivedBytes = 0; // Reset for new transfer
          receivedChunks.length = 0; // Clear previous chunks
          downloadStartTime = Date.now();
          lastReceivedBytes = 0;
          lastReceiveTime = Date.now();
          // Start a periodic update for receiver progress
          // The actual speed will be calculated from onmessage events
        } else if (msg.type === "complete") {
          console.log("File transfer complete via data channel.");
          finalizeReceivedFile(code);
        }
      } catch (e) {
        console.warn("Received non-JSON string message:", data);
        // Treat as a chunk if parsing failed but we are expecting file data
        if (fileMetadata) {
          processFileChunk(data, code);
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
      // This condition might be met slightly before or after the 'complete' message
      // Ensure that finalizeReceivedFile is only called once after all data.
      // It's safer to rely on the 'complete' message from sender.
      console.log("All chunks received based on file size.");
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
    receiveStatusMessage.style.color = "green";
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
    if (statusMessageElement && statusMessageElement.style.color !== "red") {
      // Don't overwrite explicit error messages
      statusMessageElement.textContent = `Transferring "${fileMetadata ? fileMetadata.fileName : "file"}"...`;
      statusMessageElement.style.color = "blue";
    }
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

  function resetAllTransferStates() {
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
    hideCodePopup();
    resetProgressDisplay(sendProgressContainer);
    resetProgressDisplay(receiveProgressContainer);
    // Reset status messages to default connect message
    sendStatusMessage.textContent =
      "Connected to server. Select a file to send.";
    sendStatusMessage.style.color = "initial";
    receiveStatusMessage.textContent =
      "Connected to server. Enter code to receive.";
    receiveStatusMessage.style.color = "initial";
    fileInput.value = ""; // Clear file input
    fileInput.setAttribute("data-file-name", ""); // Clear custom display
    receiveCodeInput.value = ""; // Clear receive input
  }

  // --- Event Listeners ---

  // Custom file input display logic
  fileInput.addEventListener("change", function () {
    fileToSend = this.files[0];
    if (fileToSend) {
      const fileName = fileToSend.name;
      this.setAttribute("data-file-name", fileName);
      sendStatusMessage.textContent = `File selected: ${fileName}`;
      sendStatusMessage.style.color = "initial";
      sendButton.disabled = false; // Enable send button
    } else {
      this.setAttribute("data-file-name", "");
      sendStatusMessage.textContent = "Please select a file.";
      sendStatusMessage.style.color = "red";
      sendButton.disabled = true; // Disable send button
    }
    resetProgressDisplay(sendProgressContainer);
  });

  // Send Button Logic
  sendButton.addEventListener("click", async () => {
    if (!fileToSend) {
      sendStatusMessage.textContent = "Please select a file first.";
      sendStatusMessage.style.color = "red";
      return;
    }

    if (!socket || !socket.connected) {
      sendStatusMessage.textContent =
        "Connection lost. Please refresh and try again.";
      sendStatusMessage.style.color = "red";
      initializeSocket();
      return;
    }

    isSender = true;
    sendStatusMessage.textContent = "Generating code...";
    sendStatusMessage.style.color = "blue";
    hideCodePopup();
    resetProgressDisplay(sendProgressContainer);

    // Request a code from the server
    socket.emit("register_sender", (response) => {
      if (response.code) {
        currentTransferCode = response.code;
        showCodePopup(currentTransferCode);
        sendStatusMessage.textContent = `Share code ${currentTransferCode}. Waiting for friend...`;
        sendStatusMessage.style.color = "green";

        // Now, send file metadata to the signaling server (not the file itself)
        socket.emit("sender_file_metadata", {
          code: currentTransferCode,
          fileName: fileToSend.name,
          fileSize: fileToSend.size,
          fileType: fileToSend.type,
        });
      } else {
        sendStatusMessage.textContent = `Error generating code: ${response.message || "Unknown error"}`;
        sendStatusMessage.style.color = "red";
        resetAllTransferStates();
      }
    });
  });

  // Receive Button Logic
  receiveButton.addEventListener("click", async () => {
    const code = receiveCodeInput.value.trim();

    if (!code) {
      receiveStatusMessage.textContent = "Please enter a receive code.";
      receiveStatusMessage.style.color = "red";
      return;
    }

    if (!socket || !socket.connected) {
      receiveStatusMessage.textContent =
        "Connection lost. Please refresh and try again.";
      receiveStatusMessage.style.color = "red";
      initializeSocket();
      return;
    }

    isSender = false;
    currentTransferCode = code; // Set active code for receiver
    receiveStatusMessage.textContent = `Joining code "${code}"...`;
    receiveStatusMessage.style.color = "blue";
    resetProgressDisplay(receiveProgressContainer);

    socket.emit("register_receiver", code, (response) => {
      if (response.success) {
        console.log("Joined as receiver. Response:", response);
        fileMetadata = response.fileMetadata; // Store metadata
        if (fileMetadata) {
          receiveStatusMessage.textContent = `Code accepted. Waiting for sender "${fileMetadata.fileName}"...`;
        } else {
          receiveStatusMessage.textContent =
            "Code accepted. Waiting for sender...";
        }
        receiveStatusMessage.style.color = "green";
        peerConnection = createPeerConnection(
          code,
          false,
          response.senderSocketId,
        ); // Create PC for receiver
        // Data channel will be created by sender and received via pc.ondatachannel
      } else {
        receiveStatusMessage.textContent = `Error: ${response.message || "Invalid or expired code."}`;
        receiveStatusMessage.style.color = "red";
        resetAllTransferStates();
      }
    });
  });

  // Popup Event Listeners
  copyCodeButton.addEventListener("click", () => {
    const codeToCopy = displayCode.textContent;
    navigator.clipboard
      .writeText(codeToCopy)
      .then(() => {
        alert("Code copied to clipboard!");
      })
      .catch((err) => {
        console.error("Failed to copy text: ", err);
      });
  });

  closePopupButton.addEventListener("click", hideCodePopup);

  // Close popup if clicked outside
  codePopup.addEventListener("click", (e) => {
    if (e.target === codePopup) {
      hideCodePopup();
    }
  });

  // Initial setup
  initializeSocket();
  sendButton.disabled = true; // Initially disable send button until file is chosen
});
