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

  const state = {
    payload: undefined,
    players: [],
    teamOptions: [],
  };

  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const recordId = decodeURIComponent(pathParts.length >= 2 ? pathParts[pathParts.length - 2] : '').trim();

  if (!recordId) {
    showError('Missing record ID in the page URL.');
    return;
  }

  if (playersBackLink) {
    playersBackLink.href = `/videos/${encodeURIComponent(recordId)}`;
  }

  playerCards?.addEventListener('input', handlePlayerFieldInput);
  playerCards?.addEventListener('change', handlePlayerFieldInput);
  playerCards?.addEventListener('click', handlePlayerCardAction);

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
      const manifest = payload.playerManifest || { players: [] };

      state.payload = payload;
      state.players = (Array.isArray(manifest.players) ? manifest.players : []).map(player => ({
        ...player,
        displayName: player.displayName || '',
        notes: player.notes || '',
        removed: false,
      }));
      state.teamOptions = buildTeamOptions(state.players);

      renderPlayers();
    } catch (error) {
      console.error('Players page error:', error);
      showError(error.message || 'Failed to load player list.');
    }
  }

  function renderPlayers() {
    const payload = state.payload;
    const currentPlayers = state.players;
    const activePlayers = currentPlayers.filter(player => !player.removed);
    const removedPlayers = currentPlayers.length - activePlayers.length;

    playersLoading.classList.add('hidden');
    playersError.classList.add('hidden');
    playersContent.classList.remove('hidden');

    const manifest = payload?.playerManifest || { players: [] };
    const subtitleSuffix = removedPlayers > 0 ? ` (${removedPlayers} marked for removal)` : '';
    playersSubtitle.textContent = `${payload?.sourceBlobName || 'Video'} • ${activePlayers.length} players${subtitleSuffix}`;

    playersFacts.innerHTML = [
      ['Record ID', payload?.recordId],
      ['Detected players', String(payload?.detectedPlayerCount ?? manifest.players.length)],
      ['Listed players', String(activePlayers.length)],
      removedPlayers > 0 ? ['Marked for removal', String(removedPlayers)] : undefined,
      ['Generated', formatDateTime(manifest.generatedAt)],
      ['Current stage', formatStage(payload?.currentStage)],
    ].filter(Boolean).map(([label, value]) => {
      return `<div class="status-fact"><span class="status-fact-label">${escapeHtml(label)}</span><span class="status-fact-value">${escapeHtml(value || '—')}</span></div>`;
    }).join('');

    if (!currentPlayers.length) {
      playerCards.innerHTML = '<p class="detail-empty">No detected players are available yet.</p>';
      return;
    }

    playerCards.innerHTML = currentPlayers.map((player) => {
      const teamLabel = getTeamLabel(player);
      const imageHtml = player.imageUrl
        ? `<img class="player-card-image" src="${escapeAttribute(player.imageUrl)}" alt="Player ${player.trackId}">`
        : '<div class="player-card-image player-card-image-placeholder">No image</div>';
      const teamSelectOptions = state.teamOptions.map((option) => {
        const selected = option.teamId === player.teamId && option.teamSide === player.teamSide;
        return `<option value="${escapeAttribute(serializeTeamOption(option))}"${selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`;
      }).join('');
      const disabledAttribute = player.removed ? ' disabled' : '';

      return `<article class="player-card${player.removed ? ' player-card-removed' : ''}" data-track-id="${player.trackId}">
        ${imageHtml}
        <div class="player-card-body">
          <div class="player-card-header">
            <div>
              <h3>Track ${escapeHtml(String(player.trackId))}</h3>
              <p class="player-card-meta">${escapeHtml(teamLabel)} • ${escapeHtml(String(player.frameCount))} frames • avg ${(Number(player.avgConfidence || 0)).toFixed(2)}</p>
            </div>
            <button type="button" class="btn-secondary player-remove-button">${player.removed ? 'Restore player' : 'Remove player'}</button>
          </div>
          ${player.removed ? '<p class="player-card-removed-note">Marked for removal. Save the player list to apply this change.</p>' : ''}
          <label class="form-group">
            <span>Team</span>
            <select class="text-input player-team-select"${disabledAttribute}>
              ${teamSelectOptions}
            </select>
          </label>
          <label class="form-group">
            <span>Name</span>
            <input class="text-input player-name-input" type="text" value="${escapeAttribute(player.displayName || '')}" placeholder="Player name"${disabledAttribute}>
          </label>
          <label class="form-group">
            <span>Notes</span>
            <textarea class="player-notes-input" placeholder="Optional notes"${disabledAttribute}>${escapeHtml(player.notes || '')}</textarea>
          </label>
        </div>
      </article>`;
    }).join('');
  }

  function handlePlayerFieldInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const card = target.closest('.player-card');
    if (!(card instanceof HTMLElement)) {
      return;
    }

    const trackId = Number(card.getAttribute('data-track-id'));
    const player = state.players.find(entry => entry.trackId === trackId);
    if (!player) {
      return;
    }

    if (target.classList.contains('player-name-input')) {
      player.displayName = target.value;
      clearStatusMessage();
      return;
    }

    if (target.classList.contains('player-notes-input')) {
      player.notes = target.value;
      clearStatusMessage();
      return;
    }

    if (target.classList.contains('player-team-select')) {
      const selectedTeam = parseTeamOption(target.value);
      if (!selectedTeam) {
        return;
      }

      player.teamId = selectedTeam.teamId;
      player.teamSide = selectedTeam.teamSide;
      clearStatusMessage();
      renderPlayers();
    }
  }

  function handlePlayerCardAction(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const removeButton = target.closest('.player-remove-button');
    if (!(removeButton instanceof HTMLElement)) {
      return;
    }

    const card = removeButton.closest('.player-card');
    if (!(card instanceof HTMLElement)) {
      return;
    }

    const trackId = Number(card.getAttribute('data-track-id'));
    const player = state.players.find(entry => entry.trackId === trackId);
    if (!player) {
      return;
    }

    player.removed = !player.removed;
    clearStatusMessage();
    renderPlayers();
  }

  async function savePlayers() {
    const players = state.players
      .filter(player => !player.removed)
      .map((player) => ({
        trackId: player.trackId,
        teamId: player.teamId,
        teamSide: player.teamSide,
        displayName: player.displayName || '',
        notes: player.notes || '',
      }));

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

  function buildTeamOptions(players) {
    const seen = new Set();
    const options = [];

    for (const player of players) {
      if (!player || typeof player.teamId !== 'number') {
        continue;
      }

      const option = {
        teamId: player.teamId,
        teamSide: player.teamSide === 'main' || player.teamSide === 'opponent' ? player.teamSide : undefined,
      };
      const key = serializeTeamOption(option);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      options.push({
        ...option,
        label: getTeamLabel(option),
      });
    }

    return options.sort((left, right) => {
      if (left.teamId !== right.teamId) {
        return left.teamId - right.teamId;
      }

      return getTeamSideSortValue(left.teamSide) - getTeamSideSortValue(right.teamSide);
    });
  }

  function getTeamSideSortValue(teamSide) {
    if (teamSide === 'main') return 0;
    if (teamSide === 'opponent') return 1;
    return 2;
  }

  function serializeTeamOption(option) {
    return `${option.teamId}:${option.teamSide || ''}`;
  }

  function parseTeamOption(value) {
    const [teamIdRaw, teamSideRaw = ''] = String(value).split(':');
    const teamId = Number(teamIdRaw);
    if (!Number.isInteger(teamId)) {
      return undefined;
    }

    return {
      teamId,
      teamSide: teamSideRaw === 'main' || teamSideRaw === 'opponent' ? teamSideRaw : undefined,
    };
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

  function getTeamLabel(player) {
    if (player && player.teamSide === 'main') {
      return `Main team • Team ${player.teamId}`;
    }

    if (player && player.teamSide === 'opponent') {
      return `Opponent team • Team ${player.teamId}`;
    }

    return `Team ${player?.teamId ?? '—'}`;
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
