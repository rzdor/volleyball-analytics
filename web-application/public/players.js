document.addEventListener('DOMContentLoaded', () => {
  const playersBackLink = document.getElementById('playersBackLink');
  const playersSubtitle = document.getElementById('playersSubtitle');
  const playersLoading = document.getElementById('playersLoading');
  const playersError = document.getElementById('playersError');
  const playersErrorText = document.getElementById('playersErrorText');
  const playersContent = document.getElementById('playersContent');
  const playersFacts = document.getElementById('playersFacts');
  const playersStatus = document.getElementById('playersStatus');
  const playerCards = document.getElementById('playerCards');
  const savePlayersButton = document.getElementById('savePlayersButton');

  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const recordId = decodeURIComponent(pathParts.length >= 2 ? pathParts[pathParts.length - 2] : '').trim();

  if (!recordId) {
    showError('Missing record ID in the page URL.');
    return;
  }

  if (playersBackLink) {
    playersBackLink.href = `/videos/${encodeURIComponent(recordId)}`;
  }

  loadPlayers();

  savePlayersButton?.addEventListener('click', async () => {
    await savePlayers();
  });

  async function loadPlayers() {
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(recordId)}/players`);
      if (!response.ok) {
        throw new Error(response.status === 404 ? 'Player list not found.' : 'Failed to load player list.');
      }

      const payload = await response.json();
      renderPlayers(payload);
    } catch (error) {
      console.error('Players page error:', error);
      showError(error.message || 'Failed to load player list.');
    }
  }

  function renderPlayers(payload) {
    playersLoading.classList.add('hidden');
    playersError.classList.add('hidden');
    playersContent.classList.remove('hidden');
    clearStatusMessage();

    const manifest = payload.playerManifest || { players: [] };
    playersSubtitle.textContent = `${payload.sourceBlobName || 'Video'} • ${manifest.players.length} players`;

    playersFacts.innerHTML = [
      ['Record ID', payload.recordId],
      ['Detected players', String(payload.detectedPlayerCount ?? manifest.players.length)],
      ['Generated', formatDateTime(manifest.generatedAt)],
      ['Current stage', formatStage(payload.currentStage)],
    ].map(([label, value]) => {
      return `<div class="status-fact"><span class="status-fact-label">${escapeHtml(label)}</span><span class="status-fact-value">${escapeHtml(value || '—')}</span></div>`;
    }).join('');

    if (!manifest.players.length) {
      playerCards.innerHTML = '<p class="detail-empty">No detected players are available yet.</p>';
      return;
    }

    playerCards.innerHTML = manifest.players.map((player) => {
      const imageHtml = player.imageUrl
        ? `<img class="player-card-image" src="${escapeAttribute(player.imageUrl)}" alt="Player ${player.trackId}">`
        : '<div class="player-card-image player-card-image-placeholder">No image</div>';

      return `<article class="player-card" data-track-id="${player.trackId}">
        ${imageHtml}
        <div class="player-card-body">
          <h3>Track ${escapeHtml(String(player.trackId))}</h3>
          <p class="player-card-meta">Team ${escapeHtml(String(player.teamId))} • ${escapeHtml(String(player.frameCount))} frames • avg ${(Number(player.avgConfidence || 0)).toFixed(2)}</p>
          <label class="form-group">
            <span>Name</span>
            <input class="text-input player-name-input" type="text" value="${escapeAttribute(player.displayName || '')}" placeholder="Player name">
          </label>
          <label class="form-group">
            <span>Notes</span>
            <textarea class="player-notes-input" placeholder="Optional notes">${escapeHtml(player.notes || '')}</textarea>
          </label>
        </div>
      </article>`;
    }).join('');
  }

  async function savePlayers() {
    const cards = [...document.querySelectorAll('.player-card')];
    const players = cards.map((card) => {
      const trackId = Number(card.getAttribute('data-track-id'));
      const nameInput = card.querySelector('.player-name-input');
      const notesInput = card.querySelector('.player-notes-input');

      return {
        trackId,
        displayName: nameInput ? nameInput.value : '',
        notes: notesInput ? notesInput.value : '',
      };
    });

    savePlayersButton.disabled = true;
    showStatusMessage('Saving player list...', false);

    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(recordId)}/players`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ players }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to save player list.');
      }

      await loadPlayers();
      showStatusMessage('Player list saved.', false);
    } catch (error) {
      console.error('Save players error:', error);
      showStatusMessage(error.message || 'Failed to save player list.', true);
    } finally {
      savePlayersButton.disabled = false;
    }
  }

  function showStatusMessage(message, isError) {
    if (!playersStatus) {
      return;
    }

    playersStatus.textContent = message;
    playersStatus.classList.remove('hidden');
    playersStatus.classList.toggle('player-save-success', !isError);
  }

  function clearStatusMessage() {
    if (!playersStatus) {
      return;
    }

    playersStatus.textContent = '';
    playersStatus.classList.add('hidden');
    playersStatus.classList.remove('player-save-success');
  }

  function showError(message) {
    playersLoading.classList.add('hidden');
    playersContent.classList.add('hidden');
    playersError.classList.remove('hidden');
    playersErrorText.textContent = message;
    playersSubtitle.textContent = 'Unable to load players for this video.';
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  function formatStage(stage) {
    return (stage || 'unknown').replace(/-/g, ' ');
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
