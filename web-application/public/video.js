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
  const rallyFacts = document.getElementById('rallyFacts');
  const rallyLinks = document.getElementById('rallyLinks');
  const serveFacts = document.getElementById('serveFacts');
  const serveMarkerTrack = document.getElementById('serveMarkerTrack');
  const serveEmpty = document.getElementById('serveEmpty');
  const serveReview = document.getElementById('serveReview');
  const outcomeScoreFacts = document.getElementById('outcomeScoreFacts');
  const outcomeReasonFacts = document.getElementById('outcomeReasonFacts');
  const playActions = document.getElementById('playActions');
  const previewHint = document.getElementById('previewHint');
  const detailPreview = document.getElementById('detailPreview');

  const state = {
    details: undefined,
    savingPlayIndex: undefined,
    playSaveMessage: undefined,
    savingServePlayIndex: undefined,
    serveSaveMessage: undefined,
  };

  const PLAY_OUTCOME_REASON_OPTIONS = [
    { value: 'ace', label: 'Ace' },
    { value: 'kill', label: 'Kill' },
    { value: 'block', label: 'Block' },
    { value: 'error', label: 'Error' },
    { value: 'violation', label: 'Violation' },
    { value: 'other', label: 'Other' },
  ];

  const recordId = decodeURIComponent(window.location.pathname.split('/').pop() || '').trim();

  if (!recordId) {
    showError('Missing record ID in the page URL.');
    return;
  }

  playActions?.addEventListener('click', handlePlayActionClick);
  serveReview?.addEventListener('click', handleServeActionClick);
  serveMarkerTrack?.addEventListener('click', handleServeActionClick);

  loadDetails(recordId);

  async function loadDetails(currentRecordId) {
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(currentRecordId)}/details`);
      if (!response.ok) {
        throw new Error(response.status === 404 ? 'Video record not found.' : 'Failed to load video details.');
      }

      const details = await response.json();
      state.details = details;
      state.savingPlayIndex = undefined;
      state.savingServePlayIndex = undefined;
      renderDetails(details);
    } catch (error) {
      console.error('Video details error:', error);
      showError(error instanceof Error ? error.message : 'Failed to load video details.');
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
      ['Requested URL', details.requestedVideoUrl || '—'],
      ['Uploaded', formatDateTime(details.uploadedAt)],
      ['Updated', formatDateTime(details.updatedAt)],
      ['Output folder', details.processedOutputFolder || '—'],
      ['Scene files', typeof details.processedSceneCount === 'number' ? String(details.processedSceneCount) : '—'],
    ]);

    const stages = [
      { label: 'Upload accepted', state: 'done', detail: formatDateTime(details.uploadedAt) },
    ];

    if (details.requestedVideoUrl) {
      stages.push({ label: 'Import from URL', state: getStageState(details, 'import'), detail: describeStage(details.import) });
    }

    stages.push(
      { label: 'Convert to 720p', state: getStageState(details, 'convert'), detail: describeStage(details.convert) },
      { label: 'Trim and split scenes', state: getStageState(details, 'trim'), detail: describeStage(details.trim) },
      { label: 'Detect players', state: getStageState(details, 'detect'), detail: describeStage(details.detect) },
      {
        label: 'Completed',
        state: details.status === 'completed' ? 'done' : details.status === 'failed' ? 'blocked' : 'todo',
        detail: details.completedAt ? formatDateTime(details.completedAt) : 'Waiting for final outputs.',
      },
    );

    renderStages(stages);

    renderAssets(details);
    renderScenes(details.splitParts || []);
    renderDetection(details.detectionSummary, details.detectionFile, details.playerManifest);
    renderRallySummary(details.playDescriptions);
    renderServes(details.serves);
    renderOutcomeSummary(details.playDescriptions);
    renderPlayActions(details.playDescriptions, details.playerManifest);
    renderPreview(details.trimmedVideo, details.serves);
  }

  function renderFacts(container, items) {
    if (!container) {
      return;
    }

    container.innerHTML = items.map(([label, value]) => {
      return `<div class="status-fact"><span class="status-fact-label">${escapeHtml(label)}</span><span class="status-fact-value">${escapeHtml(formatFactValue(value))}</span></div>`;
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

  function renderDetection(summary, detectionFile, playerManifest) {
    const manifestPlayers = Array.isArray(playerManifest?.players) ? playerManifest.players : [];
    const hasEditablePlayerList = manifestPlayers.length > 0 || Boolean(playerManifest?.generatedAt);
    const playerCountLabel = hasEditablePlayerList ? 'Players in list' : 'Players found';

    if (!summary) {
      renderFacts(detectionFacts, [
        [playerCountLabel, hasEditablePlayerList
          ? String(manifestPlayers.length)
          : (detectionFile ? 'Detection file exists but summary is not available.' : 'Detection is not ready yet.')],
      ]);
      return;
    }

    renderFacts(detectionFacts, [
      [playerCountLabel, String(hasEditablePlayerList ? manifestPlayers.length : summary.playerCount)],
      ['Peak players in frame', String(summary.peakPlayersInFrame)],
      ['Teams detected', String(summary.teamCount)],
      ['Sampled frames', String(summary.sampledFrames)],
    ]);
  }

  function renderRallySummary(playDescriptions) {
    if (!rallyFacts || !rallyLinks) {
      return;
    }

    const plays = Array.isArray(playDescriptions?.plays) ? playDescriptions.plays : [];
    const detectedRallies = typeof playDescriptions?.playCount === 'number' ? playDescriptions.playCount : plays.length;
    const linkedRallies = plays.filter((play) => typeof play?.playIndex === 'number').length;
    const clipCount = plays.filter((play) => typeof play?.sceneUrl === 'string' && play.sceneUrl).length;

    renderFacts(rallyFacts, [
      ['Detected rallies', String(detectedRallies)],
      ['Linked rallies', String(linkedRallies)],
      ['Scene clips available', String(clipCount)],
      ['Generated', formatDateTime(playDescriptions?.generatedAt)],
    ]);

    if (!plays.length) {
      rallyLinks.innerHTML = '<p class="detail-empty">Rally clips are not available yet.</p>';
      return;
    }

    rallyLinks.innerHTML = plays.map((play) => {
      const rallyNumber = typeof play?.playIndex === 'number' ? play.playIndex + 1 : undefined;
      const rallyLabel = rallyNumber ? `Rally ${rallyNumber}` : 'Rally';
      const reviewLink = rallyNumber
        ? `<a href="#rally-${encodeURIComponent(String(rallyNumber))}">Review</a>`
        : '';
      const clipLink = typeof play?.sceneUrl === 'string' && play.sceneUrl
        ? `<a href="${escapeAttribute(play.sceneUrl)}" target="_blank" rel="noopener noreferrer">Open clip</a>`
        : '';
      const downloadLink = typeof play?.sceneDownloadUrl === 'string' && play.sceneDownloadUrl
        ? `<a href="${escapeAttribute(play.sceneDownloadUrl)}" target="_blank" rel="noopener noreferrer">Download</a>`
        : '';
      const metaParts = [
        `Source ${formatSeconds(play?.sourceStartSeconds)} - ${formatSeconds(play?.sourceEndSeconds)}`,
      ];
      if (typeof play?.trimmedStartSeconds === 'number' && typeof play?.trimmedEndSeconds === 'number') {
        metaParts.push(`Trimmed ${formatSeconds(play.trimmedStartSeconds)} - ${formatSeconds(play.trimmedEndSeconds)}`);
      }

      return `<div class="asset-item">
        <div>
          <div class="asset-label">${escapeHtml(rallyLabel)}</div>
          <div class="asset-meta">${escapeHtml(metaParts.join(' • '))}</div>
        </div>
        <div class="asset-actions">
          ${reviewLink}
          ${clipLink}
          ${downloadLink}
        </div>
      </div>`;
    }).join('');
  }

  function renderServes(serveTimeline) {
    if (!serveFacts || !serveReview || !serveEmpty) {
      return;
    }

    renderFacts(serveFacts, [
      ['Active serves', String(toCount(serveTimeline?.summary?.activeServeCount))],
      ['Auto-detected', String(toCount(serveTimeline?.summary?.detectedServeCount))],
      ['Corrected', String(toCount(serveTimeline?.summary?.correctedServeCount))],
      ['Dismissed', String(toCount(serveTimeline?.summary?.dismissedServeCount))],
      ['Missing', String(toCount(serveTimeline?.summary?.missingServeCount))],
      ['Generated', formatDateTime(serveTimeline?.generatedAt)],
    ]);

    const plays = Array.isArray(serveTimeline?.plays) ? serveTimeline.plays : [];
    if (!plays.length) {
      serveEmpty.classList.remove('hidden');
      serveReview.innerHTML = '';
      return;
    }

    serveEmpty.classList.add('hidden');
    serveReview.innerHTML = plays.map((play) => {
      const serve = play?.serve;
      const detectedServe = play?.detectedServe;
      const contactOptions = Array.isArray(play?.contactOptions) ? play.contactOptions : [];
      const isSaving = state.savingServePlayIndex === play.playIndex;
      const saveMessage = state.serveSaveMessage?.playIndex === play.playIndex ? state.serveSaveMessage : undefined;
      const rallyNumber = typeof play?.playIndex === 'number' ? play.playIndex + 1 : undefined;
      const selectionValue = play.reviewStatus === 'dismissed'
        ? '__dismiss__'
        : play.reviewStatus === 'detected'
          ? '__detected__'
          : typeof play.selectedContactIndex === 'number'
            ? String(play.selectedContactIndex)
            : '';
      const serveDetailParts = [];
      if (serve?.detectedActionType) {
        serveDetailParts.push(`Detected as ${formatActionType(serve.detectedActionType)}`);
      }
      if (typeof serve?.actionConfidence === 'number') {
        serveDetailParts.push(formatConfidence(serve.actionConfidence));
      }
      if (serve?.actionReason) {
        serveDetailParts.push(serve.actionReason);
      }
      const serveDetailsHtml = serveDetailParts.length
        ? `<p class="serve-card-note">${escapeHtml(serveDetailParts.join(' • '))}</p>`
        : '';
      const autoDetectedHtml = (play.reviewStatus === 'corrected' || play.reviewStatus === 'dismissed')
        ? `<p class="serve-card-note"><strong>Auto-detected:</strong> ${escapeHtml(formatServeSummary(detectedServe, 'No serve detected automatically.'))}</p>`
        : '';
      const optionHtml = [
        detectedServe
          ? `<option value="__detected__"${selectionValue === '__detected__' ? ' selected' : ''}>Use detected serve — ${escapeHtml(formatServeOptionLabel(detectedServe))}</option>`
          : `<option value=""${selectionValue === '' ? ' selected' : ''}>Select a contact to mark as serve...</option>`,
        ...contactOptions.map((option) => {
          return `<option value="${escapeAttribute(String(option.contactIndex))}"${selectionValue === String(option.contactIndex) ? ' selected' : ''}>${escapeHtml(formatServeOptionLabel(option))}</option>`;
        }),
        `<option value="__dismiss__"${selectionValue === '__dismiss__' ? ' selected' : ''}>No serve for this rally</option>`,
      ].join('');
      const saveMessageHtml = saveMessage
        ? `<p class="serve-status-message ${saveMessage.isError ? 'serve-status-message-error' : 'serve-status-message-success'}">${escapeHtml(saveMessage.text)}</p>`
        : '';
      const rallyReviewLink = rallyNumber
        ? `<a href="#rally-${escapeAttribute(String(rallyNumber))}">Open rally review</a>`
        : '';

      return `<article class="play-card serve-card" data-serve-play-index="${escapeAttribute(String(play.playIndex))}" data-has-review-override="${play.hasReviewOverride ? 'true' : 'false'}">
        <div class="play-card-header">
          <div>
            <h4>${escapeHtml(formatRallyLabel(play.playIndex))}</h4>
            <p class="play-card-meta">
              Source ${escapeHtml(formatSeconds(play.sourceStartSeconds))} - ${escapeHtml(formatSeconds(play.sourceEndSeconds))}
              • Trimmed ${escapeHtml(formatSeconds(play.trimmedStartSeconds))} - ${escapeHtml(formatSeconds(play.trimmedEndSeconds))}
            </p>
          </div>
          <div class="play-card-badges">
            <span class="serve-status-badge serve-status-${escapeAttribute(play.reviewStatus)}">${escapeHtml(formatServeStatus(play.reviewStatus))}</span>
          </div>
        </div>
        <p class="serve-card-current"><strong>Current serve:</strong> ${escapeHtml(formatServeSummary(serve, 'No serve selected for this rally.'))}</p>
        ${autoDetectedHtml}
        ${serveDetailsHtml}
        <div class="serve-controls">
          <label class="form-group serve-control">
            <span>Serve selection</span>
            <select class="text-input serve-selection-select"${isSaving ? ' disabled' : ''}>
              ${optionHtml}
            </select>
          </label>
          <button type="button" class="btn-secondary serve-save-button" data-play-index="${escapeAttribute(String(play.playIndex))}"${isSaving ? ' disabled' : ''}>${isSaving ? 'Saving...' : 'Save serve'}</button>
          <button type="button" class="btn-secondary serve-reset-button" data-play-index="${escapeAttribute(String(play.playIndex))}"${!play.hasReviewOverride || isSaving ? ' disabled' : ''}>Reset</button>
        </div>
        <div class="asset-actions serve-actions">
          ${serve ? `<button type="button" class="btn-secondary serve-jump-button" data-seek-time="${escapeAttribute(String(serve.trimmedTimestamp))}">Jump in preview</button>` : ''}
          ${rallyReviewLink}
          ${play.sceneUrl ? `<a href="${escapeAttribute(play.sceneUrl)}" target="_blank" rel="noopener noreferrer">Open rally clip</a>` : ''}
        </div>
        ${play.updatedAt ? `<p class="serve-card-note">Last updated ${escapeHtml(formatDateTime(play.updatedAt))}</p>` : ''}
        ${saveMessageHtml}
      </article>`;
    }).join('');
  }

  function renderPreview(trimmedVideo, serveTimeline) {
    if (!detailPreview || !previewHint || !serveMarkerTrack) {
      return;
    }

    const activeServes = Array.isArray(serveTimeline?.serves) ? serveTimeline.serves : [];
    const trimmedDuration = typeof serveTimeline?.trimmedDurationSeconds === 'number'
      ? serveTimeline.trimmedDurationSeconds
      : 0;

    if (trimmedVideo && trimmedVideo.url) {
      detailPreview.src = trimmedVideo.url;
      detailPreview.classList.remove('hidden');
      previewHint.textContent = activeServes.length
        ? 'Use a serve marker above or a jump button below to seek the trimmed video.'
        : 'Serve markers will appear here once serve data is available.';
    } else {
      detailPreview.removeAttribute('src');
      detailPreview.classList.add('hidden');
      previewHint.textContent = 'Trimmed preview is not available yet.';
    }

    if (!activeServes.length || trimmedDuration <= 0) {
      serveMarkerTrack.classList.add('hidden');
      serveMarkerTrack.innerHTML = '';
      return;
    }

    serveMarkerTrack.classList.remove('hidden');
    serveMarkerTrack.innerHTML = activeServes.map((serve) => {
      const leftPercent = Math.min(98, Math.max(2, (serve.trimmedTimestamp / trimmedDuration) * 100));
      const markerClass = serve.reviewStatus === 'corrected' ? 'serve-marker serve-marker-corrected' : 'serve-marker';
      const label = `${formatRallyLabel(serve.playIndex)} • ${serve.displayName} • ${formatSeconds(serve.trimmedTimestamp)}`;
      return `<button type="button" class="${markerClass}" style="left: ${leftPercent}%" data-seek-time="${escapeAttribute(String(serve.trimmedTimestamp))}" aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}"></button>`;
    }).join('');
  }

  function renderOutcomeSummary(playDescriptions) {
    const scoreSummary = playDescriptions?.scoreSummary || { main: 0, opponent: 0 };
    const outcomeSummary = playDescriptions?.outcomeSummary || {
      annotatedPlayCount: 0,
      pendingPlayCount: 0,
      reasonCounts: {},
    };
    const reasonCounts = outcomeSummary.reasonCounts || {};

    renderFacts(outcomeScoreFacts, [
      ['Main team points', String(toCount(scoreSummary.main))],
      ['Opponent points', String(toCount(scoreSummary.opponent))],
      ['Tagged rallies', String(toCount(outcomeSummary.annotatedPlayCount))],
      ['Pending tags', String(toCount(outcomeSummary.pendingPlayCount))],
    ]);

    renderFacts(outcomeReasonFacts, [
      ['Kills', String(toCount(reasonCounts.kill))],
      ['Aces', String(toCount(reasonCounts.ace))],
      ['Blocks', String(toCount(reasonCounts.block))],
      ['Errors', String(toCount(reasonCounts.error))],
      ['Violations', String(toCount(reasonCounts.violation))],
      ['Other', String(toCount(reasonCounts.other))],
    ]);
  }

  function renderPlayActions(playDescriptions, playerManifest) {
    if (!playActions) {
      return;
    }

    const plays = Array.isArray(playDescriptions?.plays) ? playDescriptions.plays : [];
    if (!plays.length) {
      playActions.innerHTML = '<p class="detail-empty">Play action data is not available yet.</p>';
      return;
    }

    const playerNamesByTrackId = new Map(
      (Array.isArray(playerManifest?.players) ? playerManifest.players : []).map((player) => {
        const preferredName = typeof player.displayName === 'string' && player.displayName.trim()
          ? player.displayName.trim()
          : `Track ${player.trackId}`;
        return [player.trackId, preferredName];
      })
    );

    playActions.innerHTML = plays.map((play) => {
      const contacts = Array.isArray(play.contacts) ? play.contacts : [];
      const contactedPlayers = Array.isArray(play.contactedPlayers) ? play.contactedPlayers : [];
      const contactedSummary = contactedPlayers.length
        ? contactedPlayers.map((player) => {
            const name = playerNamesByTrackId.get(player.trackId) || `Track ${player.trackId}`;
            return `${name} (${player.contactCount})`;
          }).join(', ')
        : 'No confirmed contacts';
      const outcome = play?.outcome && typeof play.outcome === 'object' ? play.outcome : undefined;
      const runningScore = play?.runningScore && typeof play.runningScore === 'object'
        ? play.runningScore
        : { main: 0, opponent: 0 };
      const selectedReason = PLAY_OUTCOME_REASON_OPTIONS.some((option) => option.value === outcome?.reason)
        ? outcome.reason
        : 'other';
      const isSaving = state.savingPlayIndex === play.playIndex;
      const saveMessage = state.playSaveMessage?.playIndex === play.playIndex ? state.playSaveMessage : undefined;
      const reasonOptionsHtml = PLAY_OUTCOME_REASON_OPTIONS.map((option) => {
        return `<option value="${escapeAttribute(option.value)}"${option.value === selectedReason ? ' selected' : ''}>${escapeHtml(option.label)}</option>`;
      }).join('');

      const contactsHtml = contacts.length
        ? `<div class="play-action-list">${contacts.map((contact, index) => {
            const playerName = playerNamesByTrackId.get(contact.playerTrackId) || `Track ${contact.playerTrackId}`;
            const actionType = contact.actionType || 'unknown';
            const reasonHtml = contact.actionReason
              ? `<div class="play-action-reason">${escapeHtml(contact.actionReason)}</div>`
              : '';
            const confidenceHtml = typeof contact.actionConfidence === 'number'
              ? `<span class="play-action-confidence">${escapeHtml(formatConfidence(contact.actionConfidence))}</span>`
              : '';

            return `<div class="play-action-item">
              <div class="play-action-header">
                <div class="play-action-title">
                  <span class="play-action-index">#${index + 1}</span>
                  <strong>${escapeHtml(playerName)}</strong>
                  <span class="play-action-team">${escapeHtml(formatTeam(contact.teamSide, contact.teamId))}</span>
                </div>
                <div class="play-action-badges">
                  <span class="play-action-badge play-action-badge-${escapeAttribute(actionType)}">${escapeHtml(formatActionType(actionType))}</span>
                  ${confidenceHtml}
                  <span class="play-action-time">${escapeHtml(formatSeconds(contact.timestamp))}</span>
                </div>
              </div>
              ${reasonHtml}
            </div>`;
          }).join('')}</div>`
        : '<p class="detail-empty">No classified contacts for this play.</p>';

      const sceneLinkHtml = play.sceneUrl
        ? `<a href="${escapeAttribute(play.sceneUrl)}" target="_blank" rel="noopener noreferrer">Open scene clip</a>`
        : '';
      const playIndex = typeof play.playIndex === 'number' ? play.playIndex : undefined;
      const rallyNumber = typeof playIndex === 'number' ? playIndex + 1 : undefined;
      const playNumber = typeof playIndex === 'number' ? String(playIndex) : '—';
      const rallyId = typeof rallyNumber === 'number' ? `rally-${rallyNumber}` : undefined;
      const outcomeBadgeClass = !outcome
        ? 'play-outcome-badge-pending'
        : outcome.winner === 'main'
          ? 'play-outcome-badge-main'
          : 'play-outcome-badge-opponent';
      const winnerButtonsHtml = ['main', 'opponent'].map((winner) => {
        const isActive = outcome?.winner === winner;
        const winnerLabel = winner === 'main' ? 'Main team point' : 'Opponent point';
        return `<button type="button" class="btn-secondary play-outcome-button${isActive ? ' play-outcome-button-active' : ''}" data-play-index="${escapeAttribute(playNumber)}" data-winner="${winner}"${isSaving ? ' disabled' : ''}>${escapeHtml(winnerLabel)}</button>`;
      }).join('');
      const helperText = isSaving
        ? 'Saving rally tag...'
        : outcome?.updatedAt
          ? `Last updated ${formatDateTime(outcome.updatedAt)}`
          : 'Choose a reason, then tag the rally winner.';
      const saveMessageHtml = saveMessage
        ? `<p class="play-outcome-message ${saveMessage.isError ? 'play-outcome-message-error' : 'play-outcome-message-success'}">${escapeHtml(saveMessage.text)}</p>`
        : '';

      return `<article${rallyId ? ` id="${escapeAttribute(rallyId)}"` : ''} class="play-card" data-play-index="${escapeAttribute(playNumber)}">
        <div class="play-card-header">
          <div>
            <h4>Rally ${escapeHtml(typeof rallyNumber === 'number' ? String(rallyNumber) : playNumber)}</h4>
            <p class="play-card-meta">
              Source ${escapeHtml(formatSeconds(play.sourceStartSeconds))} - ${escapeHtml(formatSeconds(play.sourceEndSeconds))}
              • Trimmed ${escapeHtml(formatSeconds(play.trimmedStartSeconds))} - ${escapeHtml(formatSeconds(play.trimmedEndSeconds))}
            </p>
          </div>
          <div class="play-card-badges">
            <span class="play-score-badge">Score ${escapeHtml(formatTeamScore(runningScore))}</span>
            <span class="play-outcome-badge ${outcomeBadgeClass}">${escapeHtml(outcome ? formatOutcomeLabel(outcome) : 'Pending tag')}</span>
            ${sceneLinkHtml ? `<div class="asset-actions">${sceneLinkHtml}</div>` : ''}
          </div>
        </div>
        <p class="play-card-summary"><strong>Contacts:</strong> ${escapeHtml(contactedSummary)}</p>
        <div class="play-outcome-panel">
          <div class="play-outcome-current">
            <div>
              <div class="play-outcome-current-label">Tagged outcome</div>
              <div class="play-outcome-current-value">${escapeHtml(outcome ? formatOutcomeLabel(outcome) : 'Waiting for coach review')}</div>
            </div>
            <div class="play-outcome-running-score">Running score <strong>${escapeHtml(formatTeamScore(runningScore))}</strong></div>
          </div>
          <div class="play-outcome-controls">
            <label class="form-group play-outcome-control">
              <span>Reason</span>
              <select class="text-input play-outcome-reason-select"${isSaving ? ' disabled' : ''}>
                ${reasonOptionsHtml}
              </select>
            </label>
            <label class="form-group play-outcome-control">
              <span>Notes</span>
              <input class="text-input play-outcome-notes-input" type="text" value="${escapeAttribute(outcome?.notes || '')}" placeholder="Optional coaching note"${isSaving ? ' disabled' : ''}>
            </label>
          </div>
          <div class="play-outcome-buttons">
            ${winnerButtonsHtml}
          </div>
          <p class="play-outcome-help">${escapeHtml(helperText)}</p>
          ${saveMessageHtml}
        </div>
        ${contactsHtml}
      </article>`;
    }).join('');
  }

  async function handleServeActionClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const markerButton = target.closest('.serve-marker');
    if (markerButton instanceof HTMLButtonElement) {
      const seekTime = Number(markerButton.getAttribute('data-seek-time'));
      if (Number.isFinite(seekTime)) {
        seekPreviewToTime(seekTime);
      }
      return;
    }

    const jumpButton = target.closest('.serve-jump-button');
    if (jumpButton instanceof HTMLButtonElement) {
      const seekTime = Number(jumpButton.getAttribute('data-seek-time'));
      if (Number.isFinite(seekTime)) {
        seekPreviewToTime(seekTime);
      }
      return;
    }

    const resetButton = target.closest('.serve-reset-button');
    if (resetButton instanceof HTMLButtonElement) {
      const playIndex = Number(resetButton.getAttribute('data-play-index'));
      if (Number.isInteger(playIndex) && playIndex >= 0) {
        await resetServeReview(playIndex);
      }
      return;
    }

    const saveButton = target.closest('.serve-save-button');
    if (!(saveButton instanceof HTMLButtonElement)) {
      return;
    }

    const playIndex = Number(saveButton.getAttribute('data-play-index'));
    if (!Number.isInteger(playIndex) || playIndex < 0) {
      return;
    }

    const serveCard = saveButton.closest('.serve-card');
    if (!(serveCard instanceof HTMLElement)) {
      return;
    }

    const selection = serveCard.querySelector('.serve-selection-select');
    const selectedValue = selection instanceof HTMLSelectElement ? selection.value : '';

    if (selectedValue === '__detected__') {
      const hasReviewOverride = serveCard.getAttribute('data-has-review-override') === 'true';
      if (!hasReviewOverride) {
        state.serveSaveMessage = {
          playIndex,
          text: 'Already using the detected serve.',
          isError: false,
        };
        renderServes(state.details?.serves);
        return;
      }

      await resetServeReview(playIndex, 'Serve review reset to use the detected serve.');
      return;
    }

    if (selectedValue === '__dismiss__') {
      await saveServeReview(playIndex, null);
      return;
    }

    if (!selectedValue) {
      state.serveSaveMessage = {
        playIndex,
        text: 'Pick a contact or choose no serve for this rally.',
        isError: true,
      };
      renderServes(state.details?.serves);
      return;
    }

    const selectedContactIndex = Number(selectedValue);
    if (!Number.isInteger(selectedContactIndex) || selectedContactIndex < 0) {
      state.serveSaveMessage = {
        playIndex,
        text: 'Serve selection must reference a valid rally contact.',
        isError: true,
      };
      renderServes(state.details?.serves);
      return;
    }

    await saveServeReview(playIndex, selectedContactIndex);
  }

  async function handlePlayActionClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const outcomeButton = target.closest('.play-outcome-button');
    if (!(outcomeButton instanceof HTMLButtonElement)) {
      return;
    }

    const playCard = outcomeButton.closest('.play-card');
    if (!(playCard instanceof HTMLElement)) {
      return;
    }

    const playIndex = Number(playCard.getAttribute('data-play-index'));
    if (!Number.isInteger(playIndex) || playIndex < 0) {
      return;
    }

    const winner = outcomeButton.getAttribute('data-winner');
    if (winner !== 'main' && winner !== 'opponent') {
      return;
    }

    const reasonSelect = playCard.querySelector('.play-outcome-reason-select');
    const notesInput = playCard.querySelector('.play-outcome-notes-input');
    const reason = reasonSelect instanceof HTMLSelectElement ? reasonSelect.value : 'other';
    const notes = notesInput instanceof HTMLInputElement ? notesInput.value : '';

    await savePlayOutcome(playIndex, winner, reason, notes);
  }

  async function savePlayOutcome(playIndex, winner, reason, notes) {
    if (!state.details) {
      return;
    }

    state.savingPlayIndex = playIndex;
    state.playSaveMessage = undefined;
    renderPlayActions(state.details.playDescriptions, state.details.playerManifest);

    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(recordId)}/plays/${encodeURIComponent(String(playIndex))}/outcome`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          outcome: {
            winner,
            reason,
            notes,
          },
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to save rally outcome.');
      }

      state.playSaveMessage = {
        playIndex,
        text: 'Rally outcome saved.',
        isError: false,
      };
      await loadDetails(recordId);
    } catch (error) {
      console.error('Save play outcome error:', error);
      state.savingPlayIndex = undefined;
      state.playSaveMessage = {
        playIndex,
        text: error instanceof Error ? error.message : 'Failed to save rally outcome.',
        isError: true,
      };
      renderPlayActions(state.details.playDescriptions, state.details.playerManifest);
    }
  }

  async function saveServeReview(playIndex, selectedContactIndex) {
    if (!state.details) {
      return;
    }

    state.savingServePlayIndex = playIndex;
    state.serveSaveMessage = undefined;
    renderServes(state.details.serves);

    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(recordId)}/serves/${encodeURIComponent(String(playIndex))}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selectedContactIndex,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to save serve review.');
      }

      state.serveSaveMessage = {
        playIndex,
        text: 'Serve review saved.',
        isError: false,
      };
      await loadDetails(recordId);
    } catch (error) {
      console.error('Save serve review error:', error);
      state.savingServePlayIndex = undefined;
      state.serveSaveMessage = {
        playIndex,
        text: error instanceof Error ? error.message : 'Failed to save serve review.',
        isError: true,
      };
      renderServes(state.details.serves);
    }
  }

  async function resetServeReview(playIndex, successMessage = 'Serve review reset to the detected state.') {
    if (!state.details) {
      return;
    }

    state.savingServePlayIndex = playIndex;
    state.serveSaveMessage = undefined;
    renderServes(state.details.serves);

    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(recordId)}/serves/${encodeURIComponent(String(playIndex))}`, {
        method: 'DELETE',
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to reset serve review.');
      }

      state.serveSaveMessage = {
        playIndex,
        text: successMessage,
        isError: false,
      };
      await loadDetails(recordId);
    } catch (error) {
      console.error('Reset serve review error:', error);
      state.savingServePlayIndex = undefined;
      state.serveSaveMessage = {
        playIndex,
        text: error instanceof Error ? error.message : 'Failed to reset serve review.',
        isError: true,
      };
      renderServes(state.details.serves);
    }
  }

  function seekPreviewToTime(seconds) {
    if (!(detailPreview instanceof HTMLVideoElement) || detailPreview.classList.contains('hidden')) {
      return;
    }

    const nextTime = Math.max(0, seconds);
    const applySeek = () => {
      detailPreview.currentTime = nextTime;
    };

    if (detailPreview.readyState >= 1) {
      applySeek();
    } else {
      detailPreview.addEventListener('loadedmetadata', applySeek, { once: true });
    }

    detailPreview.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    if (stageName === 'convert' && status.import && status.import.completedAt) return 'active';
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

  function formatStageState(stateValue) {
    if (stateValue === 'done') return 'Done';
    if (stateValue === 'active') return 'In progress';
    if (stateValue === 'blocked') return 'Failed';
    return 'Pending';
  }

  function formatServeStatus(status) {
    if (status === 'detected') return 'Detected';
    if (status === 'corrected') return 'Corrected';
    if (status === 'dismissed') return 'Dismissed';
    return 'Missing';
  }

  function formatRallyLabel(playIndex) {
    return `Rally ${Number.isInteger(playIndex) ? playIndex + 1 : '—'}`;
  }

  function formatActionType(actionType) {
    return (actionType || 'unknown')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function formatServeOptionLabel(option) {
    const actionLabel = option?.detectedActionType ? formatActionType(option.detectedActionType) : 'Contact';
    return `${actionLabel} • ${option?.displayName || 'Unknown player'} • ${formatSeconds(option?.trimmedTimestamp)}`;
  }

  function formatServeSummary(serve, fallback) {
    if (!serve) {
      return fallback;
    }

    return `${serve.displayName || `Track ${serve.playerTrackId}`} • ${formatSeconds(serve.trimmedTimestamp)} trimmed • ${formatSeconds(serve.sourceTimestamp)} source`;
  }

  function formatOutcomeLabel(outcome) {
    const winnerLabel = outcome?.winner === 'main' ? 'Main team point' : 'Opponent point';
    return `${winnerLabel} • ${formatOutcomeReason(outcome?.reason)}`;
  }

  function formatOutcomeReason(reason) {
    return (reason || 'other')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function formatTeam(teamSide, teamId) {
    if (teamSide === 'main') return `Main team • Team ${teamId}`;
    if (teamSide === 'opponent') return `Opponent team • Team ${teamId}`;
    return `Team ${teamId ?? '—'}`;
  }

  function formatSeconds(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return '—';
    }

    return `${value.toFixed(2)}s`;
  }

  function formatConfidence(value) {
    return `${Math.round(value * 100)}%`;
  }

  function formatTeamScore(score) {
    return `${toCount(score?.main)} - ${toCount(score?.opponent)}`;
  }

  function formatFactValue(value) {
    return value === undefined || value === null || value === '' ? '—' : String(value);
  }

  function toCount(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.round(value))
      : 0;
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
