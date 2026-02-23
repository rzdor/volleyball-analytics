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
  const videoUrlInput = document.getElementById('videoUrl');
  const segmentsSummary = document.getElementById('segmentsSummary');
  const segmentsList = document.getElementById('segmentsList');
  const downloadLink = document.getElementById('downloadLink');
  const processedPreview = document.getElementById('processedPreview');
  const uploadedList = document.getElementById('uploadedList');
  const processedList = document.getElementById('processedList');
  const refreshLibraryBtn = document.getElementById('refreshLibrary');

  updateSubmitState();
  fetchExistingVideos();

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

  videoUrlInput.addEventListener('input', () => {
    if (videoUrlInput.value.trim()) {
      videoInput.value = '';
      filePreview.classList.add('hidden');
      videoPreview.removeAttribute('src');
      fileName.textContent = '';
    }
    updateSubmitState();
  });

  function handleFile(file) {
    if (!file.type.startsWith('video/')) {
      alert('Please select a video file');
      return;
    }

    videoUrlInput.value = '';
    const url = URL.createObjectURL(file);
    videoPreview.src = url;
    fileName.textContent = file.name + ' (' + formatFileSize(file.size) + ')';
    filePreview.classList.remove('hidden');
    updateSubmitState();
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function isValidUrl(value) {
    if (!value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function updateSubmitState() {
    const hasFile = videoInput.files && videoInput.files.length > 0;
    const urlProvided = isValidUrl(videoUrlInput.value.trim());
    trimBtn.disabled = !(hasFile || urlProvided);
  }

  // Upload form submission
  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const file = videoInput.files[0];
    const videoUrl = videoUrlInput.value.trim();

    if (!file && !videoUrl) {
      alert('Please select a video file or paste a public link');
      return;
    }

    if (videoUrl && !isValidUrl(videoUrl)) {
      alert('Please enter a valid HTTP(S) link that anyone with the URL can access');
      return;
    }

    const formData = new FormData();
    if (file) {
      formData.append('video', file);
    }
    if (videoUrl) {
      formData.append('videoUrl', videoUrl);
    }

    await processVideo('/api/videos/trim', formData);
  });

  refreshLibraryBtn?.addEventListener('click', () => {
    fetchExistingVideos();
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
        fetchExistingVideos();
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
    const segments = (result.segments || []).filter(seg => seg && typeof seg.start === 'number' && typeof seg.end === 'number');
    const totalDuration = segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
    segmentsSummary.textContent = `Detected ${segments.length} play segment${segments.length === 1 ? '' : 's'} covering ${formatDuration(totalDuration)}.`;

    segmentsList.innerHTML = segments.map((seg, idx) => {
      return `<div class="analysis-section">
        <h3>Segment ${idx + 1}</h3>
        <p>${formatDuration(seg.start)} → ${formatDuration(seg.end)}</p>
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

  async function fetchExistingVideos() {
    if (!uploadedList || !processedList) return;
    try {
      const response = await fetch('/api/videos/list');
      if (!response.ok) {
        throw new Error('Failed to load existing videos');
      }
      const payload = await response.json();
      renderList(uploadedList, payload.uploads || [], 'No uploads yet.');
      renderList(processedList, payload.processed || [], 'No processed videos yet.');
    } catch (error) {
      console.error('Unable to fetch videos', error);
      renderList(uploadedList, [], 'Unable to load uploads.');
      renderList(processedList, [], 'Unable to load processed videos.');
    }
  }

  function renderList(listEl, items, emptyText) {
    listEl.innerHTML = '';
    if (!items || items.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = emptyText;
      listEl.appendChild(li);
      return;
    }

    items.forEach(item => {
      const li = document.createElement('li');
      const primaryUrl = item.url || item.downloadUrl;
      if (primaryUrl) {
        const link = document.createElement('a');
        link.href = primaryUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = item.name || 'video';
        li.appendChild(link);
      } else {
        li.textContent = item.name || 'video';
      }

      if (item.downloadUrl && item.downloadUrl !== primaryUrl) {
        const download = document.createElement('a');
        download.href = item.downloadUrl;
        download.target = '_blank';
        download.rel = 'noopener noreferrer';
        download.textContent = 'Download';
        download.className = 'video-download-link';
        download.style.marginLeft = '0.5rem';
        li.appendChild(download);
      }

      const metaParts = [];
      if (typeof item.size === 'number') {
        metaParts.push(formatFileSize(item.size));
      }
      if (item.lastModified) {
        try {
          const date = new Date(item.lastModified);
          metaParts.push(date.toLocaleString());
        } catch {
          /* ignore date parse errors */
        }
      }
      if (metaParts.length > 0) {
        const meta = document.createElement('span');
        meta.className = 'video-meta';
        meta.textContent = metaParts.join(' • ');
        li.appendChild(meta);
      }

      listEl.appendChild(li);
    });
  }

  function formatDuration(value) {
    const totalSeconds = Math.max(0, value);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secondsValue = totalSeconds % 60;
    const integerSeconds = Math.floor(secondsValue);
    const fractional = secondsValue - integerSeconds;
    const seconds =
      fractional > 0
        ? `${integerSeconds.toString().padStart(2, '0')}${fractional.toFixed(1).slice(1)}`
        : integerSeconds.toString().padStart(2, '0');
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds}`;
    }
    return `${minutes}:${seconds}`;
  }
});
