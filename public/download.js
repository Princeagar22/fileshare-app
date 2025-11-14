// Check code button event listener
document.getElementById('checkCodeBtn').addEventListener('click', function() {
    const codeInput = document.getElementById('codeInput');
    const code = codeInput.value.trim().toUpperCase();
    
    if (!code) {
        showError('Please enter a code');
        return;
    }
    
    if (code.length !== 8) {
        showError('Code must be 8 characters long');
        return;
    }
    
    // Hide previous results
    hideError();
    hideFileInfo();
    
    // Show loading state
    const checkBtn = this;
    const originalText = checkBtn.textContent;
    checkBtn.textContent = 'Checking...';
    checkBtn.disabled = true;
    
    // Fetch file information
    fetch(`/api/file/${code}`)
        .then(response => {
            if (!response.ok) {
                throw new Error('File not found or code expired');
            }
            return response.json();
        })
        .then(data => {
            // Display file information
            document.getElementById('fileName').textContent = data.originalName;
            document.getElementById('fileSize').textContent = formatFileSize(data.size);
            document.getElementById('uploadTime').textContent = new Date(data.uploadTime).toLocaleString();
            document.getElementById('downloadCount').textContent = data.downloadCount;
            
            showFileInfo();
            
            // Store code for download
            document.getElementById('downloadBtn').dataset.code = code;
            document.getElementById('directLinkBtn').dataset.code = code;
        })
        .catch(error => {
            showError(error.message || 'Invalid code or file not found');
        })
        .finally(() => {
            // Reset button
            checkBtn.textContent = originalText;
            checkBtn.disabled = false;
        });
});

// Download button event listener
document.getElementById('downloadBtn').addEventListener('click', function() {
    const code = this.dataset.code;
    if (code) {
        window.location.href = `/api/download/${code}`;
    }
});

// Direct link button event listener
document.getElementById('directLinkBtn').addEventListener('click', function() {
    const code = this.dataset.code;
    if (code) {
        const directLink = `${window.location.origin}/api/download/${code}`;
        document.getElementById('directLink').value = directLink;
        document.getElementById('directLinkContainer').classList.remove('hidden');
    }
});

// Copy link button event listener
document.getElementById('copyLinkBtn').addEventListener('click', function() {
    const linkInput = document.getElementById('directLink');
    linkInput.select();
    document.execCommand('copy');
    
    // Show feedback
    const originalText = this.textContent;
    this.textContent = 'Copied!';
    setTimeout(() => {
        this.textContent = originalText;
    }, 2000);
});

// Helper function to format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper function to show error message
function showError(message) {
    document.getElementById('errorMessage').textContent = message;
    document.getElementById('errorContainer').classList.remove('hidden');
}

// Helper function to hide error message
function hideError() {
    document.getElementById('errorContainer').classList.add('hidden');
}

// Helper function to show file info
function showFileInfo() {
    document.getElementById('fileInfo').classList.remove('hidden');
}

// Helper function to hide file info
function hideFileInfo() {
    document.getElementById('fileInfo').classList.add('hidden');
    document.getElementById('directLinkContainer').classList.add('hidden');
}

// Allow Enter key to submit code
document.getElementById('codeInput').addEventListener('keyup', function(event) {
    if (event.key === 'Enter') {
        document.getElementById('checkCodeBtn').click();
    }
});