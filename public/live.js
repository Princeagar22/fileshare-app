class LiveTransfer {
    constructor() {
        this.sessionId = null;
        this.peerConnection = null;
        this.dataChannel = null;
        this.file = null;
        this.isSender = false;
        this.isReceiver = false;
        
        this.initializeElements();
        this.attachEventListeners();
    }
    
    initializeElements() {
        // Setup elements
        this.startTransferBtn = document.getElementById('startTransferBtn');
        this.joinTransferBtn = document.getElementById('joinTransferBtn');
        this.sessionIdInput = document.getElementById('sessionIdInput');
        
        // Transfer container elements
        this.transferContainer = document.getElementById('transferContainer');
        this.senderView = document.getElementById('senderView');
        this.receiverView = document.getElementById('receiverView');
        
        // Sender elements
        this.liveFileInput = document.getElementById('liveFileInput');
        this.liveFileName = document.getElementById('liveFileName');
        this.senderSessionId = document.getElementById('senderSessionId');
        this.sendFileBtn = document.getElementById('sendFileBtn');
        this.transferStatus = document.getElementById('transferStatus');
        
        // Receiver elements
        this.receiverSessionId = document.getElementById('receiverSessionId');
        this.fileInfo = document.getElementById('fileInfo');
        this.receivedFileName = document.getElementById('receivedFileName');
        this.receivedFileSize = document.getElementById('receivedFileSize');
        this.receivedFileType = document.getElementById('receivedFileType');
        this.receiveFileBtn = document.getElementById('receiveFileBtn');
        this.receiveStatus = document.getElementById('receiveStatus');
    }
    
    attachEventListeners() {
        this.startTransferBtn.addEventListener('click', () => this.startNewTransfer());
        this.joinTransferBtn.addEventListener('click', () => this.joinTransfer());
        this.liveFileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        this.sendFileBtn.addEventListener('click', () => this.sendFile());
    }
    
    async startNewTransfer() {
        try {
            // Create a new session
            const response = await fetch('/api/live-session', {
                method: 'POST'
            });
            
            const data = await response.json();
            this.sessionId = data.sessionId;
            
            // Show sender view
            this.isSender = true;
            this.showSenderView();
            
            // Initialize WebRTC
            await this.initializeWebRTC(true);
            
        } catch (error) {
            console.error('Error starting transfer:', error);
            this.updateStatus('Error starting transfer. Please try again.');
        }
    }
    
    async joinTransfer() {
        const sessionId = this.sessionIdInput.value.trim();
        if (!sessionId) {
            alert('Please enter a session ID');
            return;
        }
        
        try {
            // Check if session exists
            const response = await fetch(`/api/live-session/${sessionId}`);
            if (!response.ok) {
                throw new Error('Session not found');
            }
            
            const sessionData = await response.json();
            this.sessionId = sessionId;
            
            // Show receiver view
            this.isReceiver = true;
            this.showReceiverView(sessionData);
            
            // Initialize WebRTC
            await this.initializeWebRTC(false);
            
        } catch (error) {
            console.error('Error joining transfer:', error);
            alert('Invalid session ID or session expired');
        }
    }
    
    showSenderView() {
        this.transferContainer.classList.remove('hidden');
        this.senderView.classList.remove('hidden');
        this.receiverView.classList.add('hidden');
        this.senderSessionId.textContent = this.sessionId;
    }
    
    showReceiverView(sessionData) {
        this.transferContainer.classList.remove('hidden');
        this.senderView.classList.add('hidden');
        this.receiverView.classList.remove('hidden');
        this.receiverSessionId.textContent = this.sessionId;
        
        if (sessionData.senderConnected && sessionData.fileName) {
            this.showFileInfo(sessionData);
        }
    }
    
    handleFileSelect(event) {
        const file = event.target.files[0];
        if (file) {
            this.file = file;
            this.liveFileName.textContent = file.name;
            this.sendFileBtn.disabled = false;
        }
    }
    
    async initializeWebRTC(isSender) {
        // This is a simplified implementation
        // In a real application, you would implement full WebRTC here
        this.updateStatus(isSender ? 'Waiting for receiver to connect...' : 'Connecting to sender...');
        
        // Simulate connection process
        setTimeout(() => {
            if (isSender) {
                this.updateStatus('Receiver connected. Ready to send file.');
            } else {
                this.updateStatus('Connected to sender. Waiting for file...');
            }
        }, 2000);
    }
    
    async sendFile() {
        if (!this.file) {
            alert('Please select a file first');
            return;
        }
        
        try {
            // Register as sender
            await fetch(`/api/live-session/${this.sessionId}/sender`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    fileName: this.file.name,
                    fileSize: this.file.size,
                    fileType: this.file.type
                })
            });
            
            this.updateStatus(`Sending file: ${this.file.name}...`);
            
            // In a real implementation, you would send the file via WebRTC data channel
            // This is a simulation
            setTimeout(() => {
                this.updateStatus('File sent successfully!');
            }, 3000);
            
        } catch (error) {
            console.error('Error sending file:', error);
            this.updateStatus('Error sending file. Please try again.');
        }
    }
    
    showFileInfo(fileInfo) {
        this.receivedFileName.textContent = fileInfo.fileName;
        this.receivedFileSize.textContent = this.formatFileSize(fileInfo.fileSize);
        this.receivedFileType.textContent = fileInfo.fileType || 'Unknown';
        this.fileInfo.classList.remove('hidden');
        this.receiveFileBtn.classList.remove('hidden');
    }
    
    updateStatus(message) {
        if (this.isSender) {
            this.transferStatus.textContent = message;
        } else {
            this.receiveStatus.textContent = message;
        }
    }
    
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

// Initialize the live transfer when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new LiveTransfer();
});