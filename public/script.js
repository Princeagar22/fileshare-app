// Handle file selection
document.getElementById('fileInput').addEventListener('change', function(e) {
    const fileName = e.target.files[0] ? e.target.files[0].name : 'Choose a file...';
    document.getElementById('fileName').textContent = fileName;
});

// Handle form submission
document.getElementById('uploadForm').addEventListener('submit', function(e) {
    e.preventDefault();
    
    const fileInput = document.getElementById('fileInput');
    const uploadBtn = document.getElementById('uploadBtn');
    const uploadResult = document.getElementById('uploadResult');
    const shareCode = document.getElementById('shareCode');
    
    if (!fileInput.files[0]) {
        alert('Please select a file to upload');
        return;
    }
    
    // Show uploading state
    uploadBtn.textContent = 'Uploading...';
    uploadBtn.disabled = true;
    
    // Create FormData object
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    
    // Send file to server
    fetch('/upload', {
        method: 'POST',
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // Display the code
            shareCode.textContent = data.code;
            uploadResult.classList.remove('hidden');
            
            // Reset form
            document.getElementById('uploadForm').reset();
            document.getElementById('fileName').textContent = 'Choose a file...';
        } else {
            alert('Upload failed: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(error => {
        console.error('Error:', error);
        alert('Upload failed: ' + error.message);
    })
    .finally(() => {
        // Reset button
        uploadBtn.textContent = 'Upload File';
        uploadBtn.disabled = false;
    });
});

// Copy code to clipboard
document.getElementById('copyCodeBtn').addEventListener('click', function() {
    const code = document.getElementById('shareCode').textContent;
    navigator.clipboard.writeText(code)
        .then(() => {
            const originalText = this.textContent;
            this.textContent = 'Copied!';
            setTimeout(() => {
                this.textContent = originalText;
            }, 2000);
        })
        .catch(err => {
            console.error('Failed to copy: ', err);
        });
});