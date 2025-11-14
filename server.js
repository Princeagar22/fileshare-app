const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Store file information in memory (in production, use a database)
const fileStore = new Map();

// Configure multer for file uploads with larger limits
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    // Generate unique filename to prevent conflicts
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// Increase file size limits (500MB)
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB limit
  }
});

// Serve static files from public directory
app.use(express.static('public'));
app.use('/download', express.static('uploads'));

// Middleware to parse JSON
app.use(express.json());

// Routes

// Home page - file upload form
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Upload file endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Generate a unique code for this file
  const code = uuidv4().substring(0, 8).toUpperCase();
  
  // Store file information
  fileStore.set(code, {
    filename: req.file.filename,
    originalName: req.file.originalname,
    path: req.file.path,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploadTime: new Date(),
    downloadCount: 0 // Track downloads
  });

  // Return the code to the user
  res.json({ 
    success: true, 
    code: code,
    message: 'File uploaded successfully! Share the code with the recipient.'
  });
});

// Download page
app.get('/download/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

// Get file info by code
app.get('/api/file/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const fileInfo = fileStore.get(code);
  
  if (!fileInfo) {
    return res.status(404).json({ error: 'File not found or code expired' });
  }
  
  res.json({
    code: code,
    originalName: fileInfo.originalName,
    size: fileInfo.size,
    uploadTime: fileInfo.uploadTime,
    downloadCount: fileInfo.downloadCount
  });
});

// Download file by code
app.get('/api/download/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const fileInfo = fileStore.get(code);
  
  if (!fileInfo) {
    return res.status(404).json({ error: 'File not found or code expired' });
  }
  
  // Increment download counter
  fileInfo.downloadCount += 1;
  
  // Set headers for file download
  res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.originalName}"`);
  res.setHeader('Content-Type', fileInfo.mimetype);
  
  // Stream file for better performance with large files
  const fileStream = fs.createReadStream(fileInfo.path);
  fileStream.pipe(res);
  
  // Handle stream events
  fileStream.on('error', (err) => {
    console.error('File stream error:', err);
    res.status(500).json({ error: 'Error streaming file' });
  });
  
  fileStream.on('end', () => {
    console.log(`File ${fileInfo.originalName} downloaded successfully`);
  });
});

// Health check endpoint for load balancer
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to access the file sharing app`);
});