// Global variables
let currentCode = null;
let selectedFile = null;

// DOM Elements
const sendBtn = document.getElementById('sendBtn');
const receiveBtn = document.getElementById('receiveBtn');
const codeInput = document.getElementById('codeInput');
const senderView = document.getElementById('senderView');
const receiverView = document.getElementById('receiverView');
const fileInput = document.getElementById('fileInput');
const fileName = document.getElementById('fileName');
const shareCode = document.getElementById('shareCode');
const receiveCode = document.getElementById('receiveCode');
const copyCodeBtn = document.getElementById('copyCodeBtn');
const sendFileBtn = document.getElementById('sendFileBtn');
const downloadBtn = document.getElementById('downloadBtn');
const transferStatus = document.getElementById('transferStatus');
const receiveStatus = document.getElementById('receiveStatus');
const receivedFileName = document.getElementById('receivedFileName');
const receivedFileSize = document.getElementById('receivedFileSize');
const fileInfo = document.getElementById('fileInfo');

// Event Listeners
sendBtn.addEventListener('click', startSending);
receiveBtn.addEventListener('click', startReceiving);
fileInput.addEventListener('change', handleFileSelect);
copyCodeBtn.addEventListener('click', copyCode);
sendFileBtn.addEventListener('click', sendFile);
downloadBtn.addEventListener('click', downloadFile);

// Functions
async function startSending() {
    try {
        // Create a new session
        const response = await fetch('/api/session', {
            method: 'POST'
        });
        
        const data = await response.json();
        currentCode = data.code;
        
        // Show sender view
        senderView.classList.remove('hidden');
        shareCode.textContent = currentCode;
        
        // Hide other views
        receiverView.classList.add('hidden');
        
    } catch (error) {
        console.error('Error starting session:', error);
        transferStatus.textContent = 'Error starting session. Please try again.';
    }
}

async function startReceiving() {
    const code = codeInput.value.trim();
    if (!code) {
        alert('Please enter a code');
        return;
    }
    
    try {
        // Check if session exists
        const response = await fetch(`/api/session/${code}`);
        if (!response.ok) {
            throw new Error('Session not found');
        }
        
        const sessionData = await response.json();
        currentCode = code;
        
        // Show receiver view
        receiverView.classList.remove('hidden');
        receiveCode.textContent = currentCode;
        
        // Hide other views
        senderView.classList.add('hidden');
        
        // If sender is connected and file info is available
        if (sessionData.senderConnected && sessionData.fileName) {
            showFileInfo(sessionData);
        }
        
        // Join as receiver
        await fetch(`/api/session/${code}/receiver`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });
        
        receiveStatus.textContent = 'Connected. Waiting for file...';
        
    } catch (error) {
        console.error('Error joining session:', error);
        alert('Invalid code or session expired');
    }
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        selectedFile = file;
        fileName.textContent = file.name;
        sendFileBtn.disabled = false;
    }
}

function copyCode() {
    navigator.clipboard.writeText(currentCode)
        .then(() => {
            const originalText = copyCodeBtn.textContent;
            copyCodeBtn.textContent = 'Copied!';
            setTimeout(() => {
                copyCodeBtn.textContent = originalText;
            }, 2000);
        })
        .catch(err => {
            console.error('Failed to copy: ', err);
        });
}

async function sendFile() {
    if (!selectedFile) {
        alert('Please select a file first');
        return;
    }
    
    try {
        // Register as sender
        await fetch(`/api/session/${currentCode}/sender`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fileName: selectedFile.name,
                fileSize: selectedFile.size,
                fileType: selectedFile.type
            })
        });
        
        transferStatus.textContent = `Sending file: ${selectedFile.name}...`;
        
        // Read file as array buffer
        const arrayBuffer = await selectedFile.arrayBuffer();
        
        // Send file data as raw binary
        const response = await fetch(`/api/session/${currentCode}/file`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream'
            },
            body: arrayBuffer
        });
        
        if (response.ok) {
            transferStatus.textContent = 'File sent successfully!';
        } else {
            throw new Error('Failed to send file');
        }
        
    } catch (error) {
        console.error('Error sending file:', error);
        transferStatus.textContent = 'Error sending file. Please try again.';
    }
}

function downloadFile() {
    // Create download link
    const downloadUrl = `/api/session/${currentCode}/file`;
    
    // Create temporary link and trigger download
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    receiveStatus.textContent = 'File downloaded successfully!';
}

function showFileInfo(fileInfoData) {
    receivedFileName.textContent = fileInfoData.fileName;
    receivedFileSize.textContent = formatFileSize(fileInfoData.fileSize);
    fileInfo.classList.remove('hidden');
    downloadBtn.classList.remove('hidden');
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}