document.addEventListener('DOMContentLoaded', () => {
  const playersBackLink = document.getElementById('playersBackLink');
  const playersSubtitle = document.getElementById('playersSubtitle');
  const playersLoading = document.getElementById('playersLoading');
  const playersError = document.getElementById('playersError');
  const playersErrorText = document.getElementById('playersErrorText');
  const playersContent = document.getElementById('playersContent');
  const playersFacts = document.getElementById('playersFacts');
  const playerStatsDashboard = document.getElementById('playerStatsDashboard');
  const playerStatsSummary = document.getElementById('playerStatsSummary');
  const playerStatsFacts = document.getElementById('playerStatsFacts');
  const playersStatus = document.getElementById('playersStatus');
  const playerCards = document.getElementById('playerCards');
  const savePlayersButton = document.getElementById('savePlayersButton');

  const state = {
    payload: undefined,
    statsPayload: undefined,
    statsErrorMessage: '',
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
      clearStatusMessage();

      const [response, statsLoadResult] = await Promise.all([
        fetch(`/api/videos/${encodeURIComponent(recordId)}/players`),
        loadPlayerStats(),
      ]);

      if (!response.ok) {
        throw new Error(response.status === 404 ? 'Player list not found.' : 'Failed to load player list.');
      }

      const payload = await response.json();
      const manifestPlayers = Array.isArray(payload.playerManifest?.players) ? payload.playerManifest.players : [];
      const statsPlayers = Array.isArray(statsLoadResult.payload?.playerStats?.players)
        ? statsLoadResult.payload.playerStats.players
        : [];

      state.payload = payload;
      state.statsPayload = statsLoadResult.payload;
      state.statsErrorMessage = statsLoadResult.errorMessage;
      state.players = buildPlayerState(manifestPlayers, statsPlayers, Boolean(statsLoadResult.payload));
      state.teamOptions = buildTeamOptions(state.players.filter(isPlayerEditable));

      renderPlayers();
    } catch (error) {
      console.error('Players page error:', error);
      showError(error.message || 'Failed to load player list.');
    }
  }

  async function loadPlayerStats() {
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(recordId)}/stats`);
      if (!response.ok) {
        throw new Error(response.status === 404 ? 'Player stats were not found for this video.' : 'Player stats are not available right now.');
      }

      return {
        payload: await response.json(),
        errorMessage: '',
      };
    } catch (error) {
      console.warn('Player stats load warning:', error);
      return {
        payload: undefined,
        errorMessage: error.message || 'Player stats are not available right now.',
      };
    }
  }

  function buildPlayerState(manifestPlayers, statsPlayers, hasStatsPayload) {
    const safeManifestPlayers = (Array.isArray(manifestPlayers) ? manifestPlayers : [])
      .filter(player => typeof player?.trackId === 'number' && Number.isInteger(player.trackId));
    const statsByTrackId = new Map(
      (Array.isArray(statsPlayers) ? statsPlayers : [])
        .filter(player => typeof player?.trackId === 'number' && Number.isInteger(player.trackId))
        .map(player => [player.trackId, player])
    );
    const manifestTrackIds = new Set();

    const editablePlayers = safeManifestPlayers.map((player) => {
      manifestTrackIds.add(player.trackId);
      return buildPlayerEntry(player, statsByTrackId.get(player.trackId), hasStatsPayload, true);
    });

    if (!hasStatsPayload) {
      return editablePlayers;
    }

    const statsOnlyPlayers = Array.from(statsByTrackId.values())
      .filter(player => !manifestTrackIds.has(player.trackId))
      .sort((left, right) => left.trackId - right.trackId)
      .map(player => buildPlayerEntry(player, player, true, false));

    return [...editablePlayers, ...statsOnlyPlayers];
  }

  function buildPlayerEntry(player, statsPlayer, hasStatsPayload, editable) {
    return {
      trackId: player.trackId,
      teamId: player.teamId,
      teamSide: player.teamSide,
      frameCount: pickNumber(player.frameCount, statsPlayer?.frameCount),
      avgConfidence: pickNumber(player.avgConfidence, statsPlayer?.avgConfidence),
      bestConfidence: pickNumber(player.bestConfidence, statsPlayer?.bestConfidence),
      sampleTimestamp: pickNumber(player.sampleTimestamp, statsPlayer?.sampleTimestamp),
      imageBlobName: player.imageBlobName || statsPlayer?.imageBlobName,
      imageUrl: player.imageUrl || statsPlayer?.imageUrl,
      imageDownloadUrl: player.imageDownloadUrl || statsPlayer?.imageDownloadUrl,
      displayName: typeof player.displayName === 'string' ? player.displayName : '',
      notes: typeof player.notes === 'string' ? player.notes : '',
      stats: hasStatsPayload ? normalizePlayerStats(statsPlayer?.stats) : undefined,
      removed: false,
      editable,
    };
  }

  function renderPlayers() {
    const payload = state.payload;
    const manifest = payload?.playerManifest || { players: [] };
    const currentPlayers = state.players;
    const editablePlayers = currentPlayers.filter(isPlayerEditable);
    const activePlayers = editablePlayers.filter(player => !player.removed);
    const removedPlayers = editablePlayers.length - activePlayers.length;
    const statsOnlyPlayers = currentPlayers.filter(player => !isPlayerEditable(player));

    playersLoading.classList.add('hidden');
    playersError.classList.add('hidden');
    playersContent.classList.remove('hidden');

    const subtitleParts = [
      payload?.sourceBlobName || 'Video',
      `${activePlayers.length} listed player${activePlayers.length === 1 ? '' : 's'}`,
    ];
    if (removedPlayers > 0) {
      subtitleParts.push(`${removedPlayers} marked for removal`);
    }
    if (statsOnlyPlayers.length > 0) {
      subtitleParts.push(`${statsOnlyPlayers.length} stats-only`);
    }
    playersSubtitle.textContent = subtitleParts.join(' • ');

    playersFacts.innerHTML = renderFactsHtml([
      ['Record ID', payload?.recordId],
      ['Detected players', String(payload?.detectedPlayerCount ?? manifest.players.length)],
      ['Listed players', String(activePlayers.length)],
      statsOnlyPlayers.length > 0 ? ['Stats-only players', String(statsOnlyPlayers.length)] : undefined,
      removedPlayers > 0 ? ['Marked for removal', String(removedPlayers)] : undefined,
      ['Player list generated', formatDateTime(manifest.generatedAt)],
      ['Current stage', formatStage(payload?.currentStage)],
    ]);

    renderStatsDashboard(statsOnlyPlayers.length);

    if (savePlayersButton) {
      savePlayersButton.disabled = editablePlayers.length === 0;
    }

    if (!currentPlayers.length) {
      playerCards.innerHTML = '<p class="detail-empty">No detected players are available yet.</p>';
      return;
    }

    playerCards.innerHTML = currentPlayers.map((player) => {
      const teamLabel = getTeamLabel(player);
      const imageHtml = player.imageUrl
        ? `<img class="player-card-image" src="${escapeAttribute(player.imageUrl)}" alt="Player ${player.trackId}">`
        : '<div class="player-card-image player-card-image-placeholder">No image</div>';
      const teamSelectOptions = getTeamOptionsForPlayer(player).map((option) => {
        const selected = option.teamId === player.teamId && option.teamSide === player.teamSide;
        return `<option value="${escapeAttribute(serializeTeamOption(option))}"${selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`;
      }).join('');
      const disabledAttribute = !isPlayerEditable(player) || player.removed ? ' disabled' : '';
      const metaParts = [teamLabel];
      if (typeof player.frameCount === 'number') {
        metaParts.push(`${player.frameCount} frames`);
      }
      if (typeof player.avgConfidence === 'number') {
        metaParts.push(`avg ${Number(player.avgConfidence).toFixed(2)}`);
      }
      const summaryText = player.stats
        ? formatPlayerStatsSummary(player.stats)
        : 'Player stats are not available yet.';
      const statusNote = !isPlayerEditable(player)
        ? '<p class="detail-empty">This player appears in the stats feed but is not part of the current editable player manifest.</p>'
        : player.removed
          ? '<p class="player-card-removed-note">Marked for removal. Save the player list to apply this change.</p>'
          : '';
      const actionButtonHtml = isPlayerEditable(player)
        ? `<button type="button" class="btn-secondary player-remove-button">${player.removed ? 'Restore player' : 'Remove player'}</button>`
        : '';
      const statsHtml = player.stats
        ? `<div class="status-facts">${renderPlayerStatsFactsHtml(player.stats)}</div>`
        : '<p class="detail-empty">Player stats are not available yet. They will appear here once the stats API is ready for this video.</p>';

      return `<article class="player-card${player.removed ? ' player-card-removed' : ''}" data-track-id="${player.trackId}">
        ${imageHtml}
        <div class="player-card-body">
          <div class="player-card-header">
            <div>
              <h3>Track ${escapeHtml(String(player.trackId))}</h3>
              <p class="player-card-meta">${escapeHtml(metaParts.join(' • '))}</p>
              <p class="player-card-meta">${escapeHtml(summaryText)}</p>
            </div>
            ${actionButtonHtml}
          </div>
          ${statusNote}
          ${statsHtml}
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

  function renderStatsDashboard(statsOnlyPlayerCount) {
    if (!playerStatsDashboard || !playerStatsSummary || !playerStatsFacts) {
      return;
    }

    playerStatsDashboard.classList.remove('hidden');

    const statsPayload = state.statsPayload;
    if (!statsPayload?.playerStats) {
      playerStatsSummary.textContent = `${state.statsErrorMessage || 'Player stats are not available yet.'} You can still update names, teams, and notes below.`;
      playerStatsFacts.innerHTML = renderFactsHtml([
        ['Stats status', state.statsErrorMessage || 'Waiting for player stats.'],
        ['Listed players', String(state.players.filter(isPlayerEditable).length)],
        ['Player list generated', formatDateTime(state.payload?.playerManifest?.generatedAt)],
      ]);
      return;
    }

    const statsPlayers = Array.isArray(statsPayload.playerStats.players) ? statsPayload.playerStats.players : [];
    const totals = statsPlayers.reduce((accumulator, player) => {
      return addPlayerStats(accumulator, normalizePlayerStats(player.stats));
    }, createEmptyPlayerStats());
    const mainScore = toCount(statsPayload.scoreSummary?.main);
    const opponentScore = toCount(statsPayload.scoreSummary?.opponent);
    const annotatedPlayCount = toCount(statsPayload.outcomeSummary?.annotatedPlayCount);
    const pendingPlayCount = toCount(statsPayload.outcomeSummary?.pendingPlayCount);
    const statsOnlyMessage = statsOnlyPlayerCount > 0
      ? ` ${statsOnlyPlayerCount} extra stats-only track${statsOnlyPlayerCount === 1 ? '' : 's'} appear below as read-only cards.`
      : '';

    playerStatsSummary.textContent = pendingPlayCount > 0
      ? `Main ${mainScore} • Opponent ${opponentScore}. ${annotatedPlayCount} rallies have outcomes and ${pendingPlayCount} still need review.${statsOnlyMessage}`
      : `Main ${mainScore} • Opponent ${opponentScore}. ${annotatedPlayCount} rallies have recorded outcomes.${statsOnlyMessage}`;

    playerStatsFacts.innerHTML = renderFactsHtml([
      ['Players with stats', String(statsPayload.playerStats.playerCount ?? statsPlayers.length)],
      ['Stats generated', formatDateTime(statsPayload.playerStats.generatedAt)],
      ['Score', `Main ${mainScore} • Opponent ${opponentScore}`],
      ['Annotated rallies', String(annotatedPlayCount)],
      pendingPlayCount > 0 ? ['Pending rally results', String(pendingPlayCount)] : undefined,
      ['Total contacts', String(totals.totalContacts)],
      ['Serves', String(totals.serves)],
      ['Passes', String(totals.passes)],
      ['Sets', String(totals.sets)],
      ['Attacks', String(totals.attacks)],
      ['Unknown contacts', String(totals.unknownContacts)],
    ]);
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

    const player = findPlayerByTrackId(card.getAttribute('data-track-id'));
    if (!player || !isPlayerEditable(player)) {
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

    const player = findPlayerByTrackId(card.getAttribute('data-track-id'));
    if (!player || !isPlayerEditable(player)) {
      return;
    }

    player.removed = !player.removed;
    clearStatusMessage();
    renderPlayers();
  }

  async function savePlayers() {
    const players = state.players
      .filter(player => isPlayerEditable(player) && !player.removed)
      .map((player) => ({
        trackId: player.trackId,
        teamId: player.teamId,
        teamSide: player.teamSide,
        displayName: player.displayName || '',
        notes: player.notes || '',
      }));

    if (savePlayersButton) {
      savePlayersButton.disabled = true;
    }
    showStatusMessage('Saving player list...', false);

    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(recordId)}/players`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ players }),
      });

      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }

      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to save player list.');
      }

      await loadPlayers();
      showStatusMessage('Player list saved.', false);
    } catch (error) {
      console.error('Save players error:', error);
      showStatusMessage(error.message || 'Failed to save player list.', true);
    } finally {
      if (savePlayersButton) {
        savePlayersButton.disabled = state.players.filter(isPlayerEditable).length === 0;
      }
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

  function getTeamOptionsForPlayer(player) {
    const options = [...state.teamOptions];
    const currentOption = {
      teamId: player.teamId,
      teamSide: player.teamSide === 'main' || player.teamSide === 'opponent' ? player.teamSide : undefined,
      label: getTeamLabel(player),
    };

    if (!options.some(option => option.teamId === currentOption.teamId && option.teamSide === currentOption.teamSide)) {
      options.push(currentOption);
      options.sort((left, right) => {
        if (left.teamId !== right.teamId) {
          return left.teamId - right.teamId;
        }

        return getTeamSideSortValue(left.teamSide) - getTeamSideSortValue(right.teamSide);
      });
    }

    return options;
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

  function findPlayerByTrackId(trackIdAttribute) {
    const trackId = Number(trackIdAttribute);
    if (!Number.isInteger(trackId)) {
      return undefined;
    }

    return state.players.find(player => player.trackId === trackId);
  }

  function isPlayerEditable(player) {
    return player?.editable !== false;
  }

  function normalizePlayerStats(stats) {
    return {
      totalContacts: toCount(stats?.totalContacts),
      serves: toCount(stats?.serves),
      passes: toCount(stats?.passes),
      sets: toCount(stats?.sets),
      attacks: toCount(stats?.attacks),
      unknownContacts: toCount(stats?.unknownContacts),
      ralliesInvolved: toCount(stats?.ralliesInvolved),
      rallyWinsInvolved: toCount(stats?.rallyWinsInvolved),
      rallyLossesInvolved: toCount(stats?.rallyLossesInvolved),
    };
  }

  function createEmptyPlayerStats() {
    return {
      totalContacts: 0,
      serves: 0,
      passes: 0,
      sets: 0,
      attacks: 0,
      unknownContacts: 0,
      ralliesInvolved: 0,
      rallyWinsInvolved: 0,
      rallyLossesInvolved: 0,
    };
  }

  function addPlayerStats(total, stats) {
    total.totalContacts += stats.totalContacts;
    total.serves += stats.serves;
    total.passes += stats.passes;
    total.sets += stats.sets;
    total.attacks += stats.attacks;
    total.unknownContacts += stats.unknownContacts;
    total.ralliesInvolved += stats.ralliesInvolved;
    total.rallyWinsInvolved += stats.rallyWinsInvolved;
    total.rallyLossesInvolved += stats.rallyLossesInvolved;
    return total;
  }

  function renderPlayerStatsFactsHtml(stats) {
    return renderFactsHtml([
      ['Total contacts', String(stats.totalContacts)],
      ['Serves', String(stats.serves)],
      ['Passes', String(stats.passes)],
      ['Sets', String(stats.sets)],
      ['Attacks', String(stats.attacks)],
      ['Unknown contacts', String(stats.unknownContacts)],
      ['Rallies involved', String(stats.ralliesInvolved)],
      ['Rally wins involved', String(stats.rallyWinsInvolved)],
      ['Rally losses involved', String(stats.rallyLossesInvolved)],
    ]);
  }

  function renderFactsHtml(items) {
    return items
      .filter(Boolean)
      .map(([label, value]) => {
        return `<div class="status-fact"><span class="status-fact-label">${escapeHtml(label)}</span><span class="status-fact-value">${escapeHtml(formatFactValue(value))}</span></div>`;
      })
      .join('');
  }

  function formatPlayerStatsSummary(stats) {
    return `${stats.totalContacts} contacts • ${stats.ralliesInvolved} rallies • ${stats.rallyWinsInvolved} wins • ${stats.rallyLossesInvolved} losses`;
  }

  function pickNumber(primary, fallback) {
    return typeof primary === 'number' && Number.isFinite(primary)
      ? primary
      : (typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : undefined);
  }

  function toCount(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.round(value))
      : 0;
  }

  function formatFactValue(value) {
    return value === undefined || value === null || value === '' ? '—' : String(value);
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
