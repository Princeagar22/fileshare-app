const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Store session information in memory
const sessions = new Map();

// Middleware
app.use(express.static('public'));
app.use(express.json({ limit: '500mb' })); // Increase limit for file transfers
app.use(express.raw({ type: 'application/octet-stream', limit: '500mb' })); // For binary data

// Generate a simple 6-word code with unique words
function generateSimpleCode() {
    const words = ['apple', 'banana', 'cherry', 'dragon', 'elephant', 'forest', 'grape', 'house', 'island', 'jungle', 'kitchen', 'lemon', 'mountain', 'night', 'ocean', 'planet', 'queen', 'river', 'sun', 'tree'];
    const selectedWords = [];
    const availableWords = [...words];
    
    // Select 6 unique words
    for (let i = 0; i < 6; i++) {
        const randomIndex = Math.floor(Math.random() * availableWords.length);
        selectedWords.push(availableWords[randomIndex]);
        availableWords.splice(randomIndex, 1); // Remove selected word to avoid duplicates
    }
    
    return selectedWords.join('-');
}

// Routes

// Home page - live transfer
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create a new live transfer session
app.post('/api/session', (req, res) => {
    const code = generateSimpleCode();
    const sessionId = uuidv4();
    
    sessions.set(code, {
        sessionId: sessionId,
        code: code,
        fileName: null,
        fileSize: null,
        fileType: null,
        fileBuffer: null, // Store file data as buffer
        senderConnected: false,
        receiverConnected: false,
        createdAt: new Date()
    });
    
    res.json({ code });
});

// Get session info
app.get('/api/session/:code', (req, res) => {
    const session = sessions.get(req.params.code);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json({
        code: session.code,
        fileName: session.fileName,
        fileSize: session.fileSize,
        fileType: session.fileType,
        senderConnected: session.senderConnected,
        receiverConnected: session.receiverConnected
    });
});

// Join as sender
app.post('/api/session/:code/sender', (req, res) => {
    const session = sessions.get(req.params.code);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    session.senderConnected = true;
    session.fileName = req.body.fileName;
    session.fileSize = req.body.fileSize;
    session.fileType = req.body.fileType;
    
    res.json({ success: true });
});

// Join as receiver
app.post('/api/session/:code/receiver', (req, res) => {
    const session = sessions.get(req.params.code);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    session.receiverConnected = true;
    
    res.json({ success: true });
});

// Upload file data
app.post('/api/session/:code/file', (req, res) => {
    const session = sessions.get(req.params.code);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    // Store file data as raw buffer
    if (req.body && req.body.length > 0) {
        session.fileBuffer = req.body;
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'No file data received' });
    }
});

// Download file data
app.get('/api/session/:code/file', (req, res) => {
    const session = sessions.get(req.params.code);
    if (!session || !session.fileBuffer) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    // Set headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${session.fileName}"`);
    res.setHeader('Content-Type', session.fileType || 'application/octet-stream');
    res.setHeader('Content-Length', session.fileBuffer.length);
    
    // Send file buffer
    res.send(session.fileBuffer);
    
    // Clean up session after download
    sessions.delete(req.params.code);
});

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Visit http://localhost:${PORT} to access the live transfer app`);
});