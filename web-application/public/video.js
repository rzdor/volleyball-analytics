document.addEventListener('DOMContentLoaded', () => {
  const pageSubtitle = document.getElementById('pageSubtitle');
  const detailLoading = document.getElementById('detailLoading');
  const detailError = document.getElementById('detailError');
  const detailErrorText = document.getElementById('detailErrorText');
  const detailContent = document.getElementById('detailContent');
  const detailSummary = document.getElementById('detailSummary');
  const detailFacts = document.getElementById('detailFacts');
  const detailStages = document.getElementById('detailStages');
  const managePlayersLink = document.getElementById('managePlayersLink');
  const assetLinks = document.getElementById('assetLinks');
  const sceneList = document.getElementById('sceneList');
  const detectionFacts = document.getElementById('detectionFacts');
  const detailPreview = document.getElementById('detailPreview');

  const recordId = decodeURIComponent(window.location.pathname.split('/').pop() || '').trim();

  if (!recordId) {
    showError('Missing record ID in the page URL.');
    return;
  }

  loadDetails(recordId);

  async function loadDetails(currentRecordId) {
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(currentRecordId)}/details`);
      if (!response.ok) {
        throw new Error(response.status === 404 ? 'Video record not found.' : 'Failed to load video details.');
      }

      const details = await response.json();
      renderDetails(details);
    } catch (error) {
      console.error('Video details error:', error);
      showError(error.message || 'Failed to load video details.');
    }
  }

  function renderDetails(details) {
    detailLoading.classList.add('hidden');
    detailError.classList.add('hidden');
    detailContent.classList.remove('hidden');

    pageSubtitle.textContent = `${details.sourceBlobName || 'Video'} • Record ${details.recordId}`;
    if (managePlayersLink && details.playersPageUrl) {
      managePlayersLink.href = details.playersPageUrl;
      managePlayersLink.classList.remove('hidden');
    }

    const summary = [
      `Status: ${formatStatus(details.status)}`,
      `Current stage: ${formatStage(details.currentStage)}`,
    ];

    if (details.status === 'completed') {
      summary.push('Processing finished successfully.');
    } else if (details.status === 'failed') {
      summary.push('Processing failed.');
    }

    detailSummary.textContent = summary.join(' ');

    renderFacts(detailFacts, [
      ['Record ID', details.recordId],
      ['Source blob', details.sourceBlobName],
      ['Uploaded', formatDateTime(details.uploadedAt)],
      ['Updated', formatDateTime(details.updatedAt)],
      ['Output folder', details.processedOutputFolder || '—'],
      ['Scene files', typeof details.processedSceneCount === 'number' ? String(details.processedSceneCount) : '—'],
    ]);

    renderStages([
      { label: 'Upload accepted', state: 'done', detail: formatDateTime(details.uploadedAt) },
      { label: 'Convert to 720p', state: getStageState(details, 'convert'), detail: describeStage(details.convert) },
      { label: 'Trim and split scenes', state: getStageState(details, 'trim'), detail: describeStage(details.trim) },
      { label: 'Detect players', state: getStageState(details, 'detect'), detail: describeStage(details.detect) },
      {
        label: 'Completed',
        state: details.status === 'completed' ? 'done' : details.status === 'failed' ? 'blocked' : 'todo',
        detail: details.completedAt ? formatDateTime(details.completedAt) : 'Waiting for final outputs.',
      },
    ]);

    renderAssets(details);
    renderScenes(details.splitParts || []);
    renderDetection(details.detectionSummary, details.detectionFile);

    if (details.trimmedVideo && details.trimmedVideo.url) {
      detailPreview.src = details.trimmedVideo.url;
      detailPreview.classList.remove('hidden');
    } else {
      detailPreview.removeAttribute('src');
      detailPreview.classList.add('hidden');
    }
  }

  function renderFacts(container, items) {
    container.innerHTML = items.map(([label, value]) => {
      return `<div class="status-fact"><span class="status-fact-label">${escapeHtml(label)}</span><span class="status-fact-value">${escapeHtml(value || '—')}</span></div>`;
    }).join('');
  }

  function renderStages(items) {
    detailStages.innerHTML = items.map((item) => {
      return `<div class="status-stage status-stage-${item.state}">
        <div class="status-stage-header">
          <span class="status-stage-label">${escapeHtml(item.label)}</span>
          <span class="status-stage-badge">${escapeHtml(formatStageState(item.state))}</span>
        </div>
        <p>${escapeHtml(item.detail || '—')}</p>
      </div>`;
    }).join('');
  }

  function renderAssets(details) {
    const assets = [
      { label: 'Source video', asset: details.sourceVideo },
      { label: 'Converted 720p video', asset: details.convertedVideo },
      { label: 'Trimmed full video', asset: details.trimmedVideo },
      { label: 'Detection JSON', asset: details.detectionFile },
      { label: 'Player manifest', asset: details.playerManifestBlobName ? {
        name: details.playerManifestBlobName.split('/').pop(),
        url: details.playerManifestBlobUrl,
        downloadUrl: details.playerManifestBlobUrl,
      } : null },
    ].filter(item => item.asset);

    if (assets.length === 0) {
      assetLinks.innerHTML = '<p class="detail-empty">No file links are available yet.</p>';
      return;
    }

    assetLinks.innerHTML = assets.map(({ label, asset }) => {
      return `<div class="asset-item">
        <div>
          <div class="asset-label">${escapeHtml(label)}</div>
          <div class="asset-meta">${escapeHtml(asset.name)}</div>
        </div>
        <div class="asset-actions">
          <a href="${escapeAttribute(asset.url)}" target="_blank" rel="noopener noreferrer">Open</a>
          <a href="${escapeAttribute(asset.downloadUrl)}" target="_blank" rel="noopener noreferrer">Download</a>
        </div>
      </div>`;
    }).join('');
  }

  function renderScenes(splitParts) {
    sceneList.innerHTML = '';

    if (!splitParts.length) {
      sceneList.innerHTML = '<li class="muted">No split scene files yet.</li>';
      return;
    }

    splitParts.forEach((part) => {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = part.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = part.name;
      li.appendChild(link);

      const download = document.createElement('a');
      download.href = part.downloadUrl;
      download.target = '_blank';
      download.rel = 'noopener noreferrer';
      download.textContent = 'Download';
      download.className = 'video-download-link';
      download.style.marginLeft = '0.5rem';
      li.appendChild(download);

      const meta = [];
      if (typeof part.size === 'number') {
        meta.push(formatFileSize(part.size));
      }
      if (part.lastModified) {
        meta.push(formatDateTime(part.lastModified));
      }

      if (meta.length > 0) {
        const metaEl = document.createElement('span');
        metaEl.className = 'video-meta';
        metaEl.textContent = meta.join(' • ');
        li.appendChild(metaEl);
      }

      sceneList.appendChild(li);
    });
  }

  function renderDetection(summary, detectionFile) {
    if (!summary) {
      renderFacts(detectionFacts, [
        ['Players found', detectionFile ? 'Detection file exists but summary is not available.' : 'Detection is not ready yet.'],
      ]);
      return;
    }

    renderFacts(detectionFacts, [
      ['Players found', String(summary.playerCount)],
      ['Peak players in frame', String(summary.peakPlayersInFrame)],
      ['Teams detected', String(summary.teamCount)],
      ['Sampled frames', String(summary.sampledFrames)],
    ]);
  }

  function showError(message) {
    detailLoading.classList.add('hidden');
    detailContent.classList.add('hidden');
    detailError.classList.remove('hidden');
    detailErrorText.textContent = message;
    pageSubtitle.textContent = 'Unable to load this video record.';
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

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }
});
