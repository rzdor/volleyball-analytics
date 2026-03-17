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
  const fileTypesHint = document.getElementById('fileTypesHint');
  const videoUrlHint = document.getElementById('videoUrlHint');
  const statusSummary = document.getElementById('statusSummary');
  const statusFacts = document.getElementById('statusFacts');
  const statusStages = document.getElementById('statusStages');
  const statusError = document.getElementById('statusError');
  const detailsLink = document.getElementById('detailsLink');
  const downloadLink = document.getElementById('downloadLink');
  const detectionLink = document.getElementById('detectionLink');
  const processedPreview = document.getElementById('processedPreview');
  const uploadedList = document.getElementById('uploadedList');
  const processedList = document.getElementById('processedList');
  const refreshLibraryBtn = document.getElementById('refreshLibrary');
  let activeRecordId = null;
  let statusPollTimeout = null;
  let maxUploadBytes = null;
  let maxUploadSizeLabel = '5 GB';

  updateSubmitState();
  fetchUploadConfig();
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

    if (typeof maxUploadBytes === 'number' && file.size > maxUploadBytes) {
      alert(`Please select a video smaller than ${maxUploadSizeLabel}.`);
      videoInput.value = '';
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
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    const precision = unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
  }

  async function fetchUploadConfig() {
    try {
      const response = await fetch('/api/videos/config');
      if (!response.ok) {
        throw new Error('Failed to load upload config');
      }

      const config = await response.json();
      if (typeof config.maxVideoBytes === 'number') {
        maxUploadBytes = config.maxVideoBytes;
      }
      if (config.maxVideoSizeLabel) {
        maxUploadSizeLabel = config.maxVideoSizeLabel;
      }

      if (fileTypesHint) {
        fileTypesHint.textContent = `Supported: MP4, WebM, MOV, AVI (max ${maxUploadSizeLabel})`;
      }
      if (videoUrlHint) {
        videoUrlHint.textContent = `Use a direct link to your cloud video (publicly accessible, max ${maxUploadSizeLabel}).`;
      }
    } catch (error) {
      console.error('Unable to fetch upload config', error);
    }
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
    activeRecordId = result.recordId || null;
    results.classList.remove('hidden');
    results.scrollIntoView({ behavior: 'smooth' });

    renderPendingStatus(result);

    if (activeRecordId) {
      pollVideoStatus(activeRecordId, true);
    }
  }

  function renderPendingStatus(result) {
    statusSummary.textContent = 'Upload complete. Waiting for the processing pipeline to pick up this video.';
    updateDetailsLink(result.recordId || null);
    renderStatusFacts([
      ['Record ID', result.recordId || 'Pending'],
      ['Blob', result.blobName || 'Pending'],
      ['Container', result.container || 'Pending']
    ]);
    renderStatusStages([
      { label: 'Upload accepted', state: 'done', detail: 'Stored in Blob Storage.' },
      { label: 'Convert to 720p', state: 'active', detail: 'Waiting for ingestion/status record.' },
      { label: 'Trim and split scenes', state: 'todo', detail: 'Will start after conversion completes.' },
      { label: 'Detect players', state: 'todo', detail: 'Will start after trim completes.' },
      { label: 'Completed', state: 'todo', detail: 'Outputs will appear here.' }
    ]);
    statusError.textContent = '';
    statusError.classList.add('hidden');
    updateResultLinks({});
  }

  async function pollVideoStatus(recordId, immediate = false) {
    clearStatusPolling();

    if (!recordId) {
      return;
    }

    const run = async () => {
      try {
        const response = await fetch(`/api/videos/status/${encodeURIComponent(recordId)}`);

        if (response.status === 404) {
          statusSummary.textContent = 'Upload complete. Waiting for the ingestion function to create the tracking record.';
          scheduleStatusPoll(recordId);
          return;
        }

        if (!response.ok) {
          throw new Error('Failed to fetch processing status');
        }

        const status = await response.json();
        renderVideoStatus(status);

        if (!isTerminalStatus(status.status)) {
          scheduleStatusPoll(recordId);
          return;
        }

        fetchExistingVideos();
      } catch (error) {
        console.error('Status polling error:', error);
        statusSummary.textContent = 'Unable to refresh processing status right now.';
        scheduleStatusPoll(recordId);
      }
    };

    if (immediate) {
      await run();
      return;
    }

    statusPollTimeout = window.setTimeout(run, 3000);
  }

  function scheduleStatusPoll(recordId) {
    clearStatusPolling();
    statusPollTimeout = window.setTimeout(() => {
      pollVideoStatus(recordId, true);
    }, 3000);
  }

  function clearStatusPolling() {
    if (statusPollTimeout) {
      window.clearTimeout(statusPollTimeout);
      statusPollTimeout = null;
    }
  }

  function renderVideoStatus(status) {
    updateDetailsLink(status.recordId || null);
    const summary = [];
    summary.push(`Stage: ${formatStage(status.currentStage)}`);
    summary.push(`Status: ${formatStatus(status.status)}`);

    if (status.status === 'completed') {
      summary.push('Processing finished successfully.');
    } else if (status.status === 'failed') {
      summary.push('Processing failed.');
    } else if (status.status === 'processing') {
      summary.push('The worker is actively processing this video.');
    } else if (status.status === 'queued') {
      summary.push('The job is queued and waiting for a worker.');
    }

    statusSummary.textContent = summary.join(' ');

    const facts = [
      ['Record ID', status.recordId],
      ['Source blob', status.sourceBlobName],
      ['Uploaded', formatDateTime(status.uploadedAt)],
      ['Updated', formatDateTime(status.updatedAt)],
      ['Current stage', formatStage(status.currentStage)]
    ];

    if (status.processedOutputFolder) {
      facts.push(['Output folder', status.processedOutputFolder]);
    }

    if (typeof status.processedSceneCount === 'number') {
      facts.push(['Scene files', String(status.processedSceneCount)]);
    }

    renderStatusFacts(facts);

    renderStatusStages([
      {
        label: 'Upload accepted',
        state: 'done',
        detail: formatDateTime(status.uploadedAt)
      },
      {
        label: 'Convert to 720p',
        state: getStageState(status, 'convert'),
        detail: describeStage(status.convert)
      },
      {
        label: 'Trim and split scenes',
        state: getStageState(status, 'trim'),
        detail: describeStage(status.trim)
      },
      {
        label: 'Detect stage',
        state: getStageState(status, 'detect'),
        detail: describeStage(status.detect)
      },
      {
        label: 'Completed',
        state: status.status === 'completed' ? 'done' : status.status === 'failed' ? 'blocked' : 'todo',
        detail: status.completedAt ? formatDateTime(status.completedAt) : 'Waiting for final outputs.'
      }
    ]);

    if (status.errorMessage) {
      statusError.textContent = status.errorMessage;
      statusError.classList.remove('hidden');
    } else {
      statusError.textContent = '';
      statusError.classList.add('hidden');
    }

    updateResultLinks(status);
  }

  function renderStatusFacts(items) {
    statusFacts.innerHTML = items.map(([label, value]) => {
      return `<div class="status-fact"><span class="status-fact-label">${escapeHtml(label)}</span><span class="status-fact-value">${escapeHtml(value || '—')}</span></div>`;
    }).join('');
  }

  function renderStatusStages(items) {
    statusStages.innerHTML = items.map((item) => {
      return `<div class="status-stage status-stage-${item.state}">
        <div class="status-stage-header">
          <span class="status-stage-label">${escapeHtml(item.label)}</span>
          <span class="status-stage-badge">${escapeHtml(formatStageState(item.state))}</span>
        </div>
        <p>${escapeHtml(item.detail || '—')}</p>
      </div>`;
    }).join('');
  }

  function updateResultLinks(status) {
    if (status.processedBlobUrl) {
      downloadLink.href = status.processedBlobUrl;
      downloadLink.classList.remove('hidden');
      processedPreview.src = status.processedBlobUrl;
      processedPreview.classList.remove('hidden');
    } else {
      downloadLink.removeAttribute('href');
      downloadLink.classList.add('hidden');
      processedPreview.removeAttribute('src');
      processedPreview.classList.add('hidden');
    }

    if (status.detectionBlobUrl) {
      detectionLink.href = status.detectionBlobUrl;
      detectionLink.classList.remove('hidden');
    } else {
      detectionLink.removeAttribute('href');
      detectionLink.classList.add('hidden');
    }
  }

  function updateDetailsLink(recordId) {
    if (!detailsLink || !recordId) {
      detailsLink?.removeAttribute('href');
      detailsLink?.classList.add('hidden');
      return;
    }

    detailsLink.href = `/videos/${encodeURIComponent(recordId)}`;
    detailsLink.classList.remove('hidden');
  }

  function getStageState(status, stageName) {
    if (status.status === 'failed' && status.currentStage === 'failed') {
      const failedStage = getFailedStageName(status);
      if (failedStage === stageName) {
        return 'blocked';
      }

      const stage = status[stageName];
      return stage && stage.completedAt ? 'done' : 'todo';
    }

    const stage = status[stageName];
    if (stage && stage.completedAt) return 'done';
    if (status.currentStage === stageName && status.status === 'processing') return 'active';
    if (status.currentStage === stageName && status.status === 'queued') return 'active';
    if (stageName === 'trim' && status.convert && status.convert.completedAt) return 'active';
    if (stageName === 'detect' && status.trim && status.trim.completedAt) return 'active';
    return 'todo';
  }

  function getFailedStageName(status) {
    const orderedStages = ['detect', 'trim', 'convert'];

    return orderedStages.find((stageName) => {
      const stage = status[stageName];
      return stage && (stage.failedAt || stage.errorMessage);
    }) || 'convert';
  }

  function describeStage(stage) {
    if (!stage) {
      return 'Waiting to start.';
    }
    if (stage.completedAt) {
      const duration = typeof stage.durationMs === 'number' ? ` (${formatMilliseconds(stage.durationMs)})` : '';
      return `Completed ${formatDateTime(stage.completedAt)}${duration}`;
    }
    if (stage.failedAt) {
      return `Failed ${formatDateTime(stage.failedAt)}${stage.errorMessage ? `: ${stage.errorMessage}` : ''}`;
    }
    if (stage.startedAt) {
      return `Started ${formatDateTime(stage.startedAt)}`;
    }
    if (stage.queuedAt) {
      return `Queued ${formatDateTime(stage.queuedAt)}`;
    }
    return 'Waiting to start.';
  }

  function isTerminalStatus(status) {
    return status === 'completed' || status === 'failed';
  }

  function formatStatus(status) {
    return (status || 'unknown').replace(/-/g, ' ');
  }

  function formatStage(stage) {
    return (stage || 'unknown').replace(/-/g, ' ');
  }

  function formatStageState(state) {
    if (state === 'done') return 'Done';
    if (state === 'active') return 'In progress';
    if (state === 'blocked') return 'Failed';
    return 'Pending';
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  function formatMilliseconds(value) {
    if (value < 1000) {
      return `${value} ms`;
    }
    return `${(value / 1000).toFixed(1)} s`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
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

      if (item.detailUrl) {
        const detail = document.createElement('a');
        detail.href = item.detailUrl;
        detail.textContent = 'Details';
        detail.className = 'video-download-link';
        detail.style.marginLeft = '0.5rem';
        li.appendChild(detail);
      }

      const metaParts = [];
      if (item.status && item.currentStage) {
        metaParts.push(`${formatStatus(item.status)} / ${formatStage(item.currentStage)}`);
      }
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

  window.addEventListener('beforeunload', () => {
    clearStatusPolling();
  });
});
