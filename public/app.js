document.addEventListener('DOMContentLoaded', () => {
  const dropZone = document.getElementById('dropZone');
  const videoInput = document.getElementById('videoInput');
  const filePreview = document.getElementById('filePreview');
  const videoPreview = document.getElementById('videoPreview');
  const fileName = document.getElementById('fileName');
  const uploadForm = document.getElementById('uploadForm');
  const results = document.getElementById('results');
  const loading = document.getElementById('loading');
  const trimBtn = document.getElementById('trimBtn');
  const segmentsSummary = document.getElementById('segmentsSummary');
  const segmentsList = document.getElementById('segmentsList');
  const downloadLink = document.getElementById('downloadLink');
  const processedPreview = document.getElementById('processedPreview');

  trimBtn.disabled = true;

  // Drag and drop handlers
  dropZone.addEventListener('click', () => videoInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  });

  videoInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  });

  function handleFile(file) {
    if (!file.type.startsWith('video/')) {
      alert('Please select a video file');
      return;
    }

    const url = URL.createObjectURL(file);
    videoPreview.src = url;
    fileName.textContent = file.name + ' (' + formatFileSize(file.size) + ')';
    filePreview.classList.remove('hidden');
    trimBtn.disabled = false;
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Upload form submission
  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const file = videoInput.files[0];
    if (!file) {
      alert('Please select a video file');
      return;
    }

    const formData = new FormData();
    formData.append('video', file);

    await processVideo('/api/videos/trim', formData);
  });

  async function processVideo(url, data) {
    showLoading(true);
    results.classList.add('hidden');

    try {
    const response = await fetch(url, {
      method: 'POST',
      body: data
    });
      const result = await response.json();

      if (result.success) {
        displayResults(result);
      } else {
        throw new Error(result.error || 'Processing failed');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('Failed to process video: ' + error.message);
    } finally {
      showLoading(false);
    }
  }

  function showLoading(show) {
    loading.classList.toggle('hidden', !show);
    document.querySelectorAll('button[type="submit"]').forEach(btn => {
      btn.disabled = show;
    });
  }

  function displayResults(result) {
    const segments = (result.segments || []).filter(seg => typeof seg?.start === 'number' && typeof seg?.end === 'number');
    const totalDuration = segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
    segmentsSummary.textContent = `Detected ${segments.length} play segment${segments.length === 1 ? '' : 's'} covering ${formatSeconds(totalDuration)}.`;

    segmentsList.innerHTML = segments.map((seg, idx) => {
      return `<div class="analysis-section">
        <h3>Segment ${idx + 1}</h3>
        <p>${formatSeconds(seg.start)} → ${formatSeconds(seg.end)}</p>
      </div>`;
    }).join('');

    const videoUrl = result.previewUrl || result.downloadUrl;
    if (result.downloadUrl) {
      downloadLink.href = result.downloadUrl;
      downloadLink.classList.remove('hidden');
    } else {
      downloadLink.removeAttribute('href');
      downloadLink.classList.add('hidden');
    }

    if (videoUrl) {
      processedPreview.src = videoUrl;
      processedPreview.classList.remove('hidden');
    } else {
      processedPreview.classList.add('hidden');
    }

    results.classList.remove('hidden');
    results.scrollIntoView({ behavior: 'smooth' });
  }

  function formatSeconds(value) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }
});
