import { PlayerManifestProjection, PlayDescriptionsProjection } from './cosmosReadModelStore';

type TeamSide = 'main' | 'opponent';
type PlayActionType = 'serve' | 'pass' | 'set' | 'attack' | 'unknown';

type PlayerManifestPlayer = PlayerManifestProjection['players'][number];
type PlayRecord = PlayDescriptionsProjection['plays'][number];
type PlayContact = PlayRecord['contacts'][number];

export type ServeReviewOverride = {
  playIndex: number;
  updatedAt: string;
  dismissed?: boolean;
  serve?: {
    playerTrackId: number;
    teamId: number;
    teamSide?: TeamSide;
    frameIndex: number;
    trimmedTimestamp: number;
    sourceTimestamp: number;
  };
};

export type ServeReviewManifest = {
  recordId: string;
  updatedAt: string;
  plays: ServeReviewOverride[];
};

export type ServeReviewStatus = 'detected' | 'corrected' | 'dismissed' | 'missing';

export type ServeContactOption = {
  contactIndex: number;
  playerTrackId: number;
  teamId: number;
  teamSide?: TeamSide;
  frameIndex: number;
  trimmedTimestamp: number;
  sourceTimestamp: number;
  displayName: string;
  imageBlobName?: string;
  detectedActionType?: PlayActionType;
  actionConfidence?: number;
  actionReason?: string;
};

export type ServeEvent = {
  playIndex: number;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  trimmedStartSeconds: number;
  trimmedEndSeconds: number;
  sceneBlobName: string;
  contactIndex?: number;
  playerTrackId: number;
  teamId: number;
  teamSide?: TeamSide;
  trimmedTimestamp: number;
  sourceTimestamp: number;
  displayName: string;
  imageBlobName?: string;
  detectedActionType?: PlayActionType;
  actionConfidence?: number;
  actionReason?: string;
  reviewStatus: Exclude<ServeReviewStatus, 'dismissed' | 'missing'>;
  updatedAt?: string;
};

export type ServeReviewPlay = {
  playIndex: number;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  trimmedStartSeconds: number;
  trimmedEndSeconds: number;
  sceneBlobName: string;
  detectedContactIndex?: number;
  selectedContactIndex?: number;
  detectedServe?: ServeEvent;
  serve?: ServeEvent;
  reviewStatus: ServeReviewStatus;
  hasReviewOverride: boolean;
  updatedAt?: string;
  contactOptions: ServeContactOption[];
};

export type ServeTimelineProjection = {
  generatedAt?: string;
  trimmedDurationSeconds: number;
  summary: {
    activeServeCount: number;
    detectedServeCount: number;
    correctedServeCount: number;
    dismissedServeCount: number;
    missingServeCount: number;
    reviewedPlayCount: number;
  };
  plays: ServeReviewPlay[];
  serves: ServeEvent[];
};

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function buildPlayerMap(playerManifest?: PlayerManifestProjection): Map<number, PlayerManifestPlayer> {
  return new Map((playerManifest?.players ?? []).map(player => [player.trackId, player]));
}

function getPlayerDisplayName(playerTrackId: number, player?: PlayerManifestPlayer): string {
  const preferredName = typeof player?.displayName === 'string' ? player.displayName.trim() : '';
  return preferredName || `Track ${playerTrackId}`;
}

function buildSourceTimestamp(play: Pick<PlayRecord, 'sourceStartSeconds' | 'trimmedStartSeconds'>, trimmedTimestamp: number): number {
  return roundTime(play.sourceStartSeconds + (trimmedTimestamp - play.trimmedStartSeconds));
}

function buildContactOption(
  play: Pick<PlayRecord, 'sourceStartSeconds' | 'trimmedStartSeconds'>,
  contact: PlayContact,
  contactIndex: number,
  playersByTrackId: Map<number, PlayerManifestPlayer>,
): ServeContactOption {
  const player = playersByTrackId.get(contact.playerTrackId);
  return {
    contactIndex,
    playerTrackId: contact.playerTrackId,
    teamId: contact.teamId,
    teamSide: contact.teamSide,
    frameIndex: contact.frameIndex,
    trimmedTimestamp: roundTime(contact.timestamp),
    sourceTimestamp: buildSourceTimestamp(play, contact.timestamp),
    displayName: getPlayerDisplayName(contact.playerTrackId, player),
    imageBlobName: player?.imageBlobName,
    detectedActionType: contact.actionType,
    actionConfidence: contact.actionConfidence,
    actionReason: contact.actionReason,
  };
}

function buildServeEventFromContactOption(
  play: Pick<PlayRecord, 'playIndex' | 'sourceStartSeconds' | 'sourceEndSeconds' | 'trimmedStartSeconds' | 'trimmedEndSeconds' | 'sceneBlobName'>,
  option: ServeContactOption,
  reviewStatus: Exclude<ServeReviewStatus, 'dismissed' | 'missing'>,
  updatedAt?: string,
): ServeEvent {
  return {
    playIndex: play.playIndex,
    sourceStartSeconds: play.sourceStartSeconds,
    sourceEndSeconds: play.sourceEndSeconds,
    trimmedStartSeconds: play.trimmedStartSeconds,
    trimmedEndSeconds: play.trimmedEndSeconds,
    sceneBlobName: play.sceneBlobName,
    contactIndex: option.contactIndex,
    playerTrackId: option.playerTrackId,
    teamId: option.teamId,
    teamSide: option.teamSide,
    trimmedTimestamp: option.trimmedTimestamp,
    sourceTimestamp: option.sourceTimestamp,
    displayName: option.displayName,
    imageBlobName: option.imageBlobName,
    detectedActionType: option.detectedActionType,
    actionConfidence: option.actionConfidence,
    actionReason: option.actionReason,
    reviewStatus,
    updatedAt,
  };
}

function buildServeEventFromOverride(
  play: Pick<PlayRecord, 'playIndex' | 'sourceStartSeconds' | 'sourceEndSeconds' | 'trimmedStartSeconds' | 'trimmedEndSeconds' | 'sceneBlobName'>,
  override: ServeReviewOverride,
  playersByTrackId: Map<number, PlayerManifestPlayer>,
): ServeEvent | undefined {
  if (!override.serve) {
    return undefined;
  }

  const player = playersByTrackId.get(override.serve.playerTrackId);
  return {
    playIndex: play.playIndex,
    sourceStartSeconds: play.sourceStartSeconds,
    sourceEndSeconds: play.sourceEndSeconds,
    trimmedStartSeconds: play.trimmedStartSeconds,
    trimmedEndSeconds: play.trimmedEndSeconds,
    sceneBlobName: play.sceneBlobName,
    playerTrackId: override.serve.playerTrackId,
    teamId: override.serve.teamId,
    teamSide: override.serve.teamSide,
    trimmedTimestamp: roundTime(override.serve.trimmedTimestamp),
    sourceTimestamp: roundTime(override.serve.sourceTimestamp),
    displayName: getPlayerDisplayName(override.serve.playerTrackId, player),
    imageBlobName: player?.imageBlobName,
    reviewStatus: 'corrected',
    updatedAt: override.updatedAt,
  };
}

function findOverrideContactIndex(contactOptions: ServeContactOption[], override: ServeReviewOverride): number | undefined {
  if (!override.serve) {
    return undefined;
  }

  const exactMatch = contactOptions.find(option =>
    option.playerTrackId === override.serve?.playerTrackId
    && option.frameIndex === override.serve?.frameIndex
    && Math.abs(option.trimmedTimestamp - override.serve.trimmedTimestamp) <= 0.001
  );
  if (exactMatch) {
    return exactMatch.contactIndex;
  }

  const fallbackMatch = contactOptions.find(option =>
    option.playerTrackId === override.serve?.playerTrackId
    && Math.abs(option.trimmedTimestamp - override.serve.trimmedTimestamp) <= 0.05
  );
  return fallbackMatch?.contactIndex;
}

function getDetectedContactIndex(contactOptions: ServeContactOption[]): number | undefined {
  const detected = contactOptions.find(option => option.detectedActionType === 'serve');
  return detected?.contactIndex;
}

export function createServeReviewOverride(play: PlayRecord, selectedContactIndex: number, updatedAt: string): ServeReviewOverride | undefined {
  const contact = play.contacts[selectedContactIndex];
  if (!contact) {
    return undefined;
  }

  return {
    playIndex: play.playIndex,
    updatedAt,
    serve: {
      playerTrackId: contact.playerTrackId,
      teamId: contact.teamId,
      teamSide: contact.teamSide,
      frameIndex: contact.frameIndex,
      trimmedTimestamp: roundTime(contact.timestamp),
      sourceTimestamp: buildSourceTimestamp(play, contact.timestamp),
    },
  };
}

export function buildServeTimeline(params: {
  playerManifest?: PlayerManifestProjection;
  playDescriptions?: PlayDescriptionsProjection;
  reviewManifest?: ServeReviewManifest;
}): ServeTimelineProjection {
  const playersByTrackId = buildPlayerMap(params.playerManifest);
  const plays = params.playDescriptions?.plays ?? [];
  const reviewByPlayIndex = new Map((params.reviewManifest?.plays ?? []).map(review => [review.playIndex, review]));
  const summary = {
    activeServeCount: 0,
    detectedServeCount: 0,
    correctedServeCount: 0,
    dismissedServeCount: 0,
    missingServeCount: 0,
    reviewedPlayCount: 0,
  };

  const servePlays = plays.map<ServeReviewPlay>((play) => {
    const contactOptions = play.contacts.map((contact, index) => buildContactOption(play, contact, index, playersByTrackId));
    const detectedContactIndex = getDetectedContactIndex(contactOptions);
    const detectedServe = detectedContactIndex === undefined
      ? undefined
      : buildServeEventFromContactOption(play, contactOptions[detectedContactIndex], 'detected');
    const review = reviewByPlayIndex.get(play.playIndex);

    let serve = detectedServe;
    let selectedContactIndex = detectedContactIndex;
    let reviewStatus: ServeReviewStatus = detectedServe ? 'detected' : 'missing';

    if (review?.dismissed) {
      serve = undefined;
      selectedContactIndex = undefined;
      reviewStatus = 'dismissed';
      summary.dismissedServeCount += 1;
      summary.reviewedPlayCount += 1;
    } else if (review?.serve) {
      const overrideContactIndex = findOverrideContactIndex(contactOptions, review);
      selectedContactIndex = overrideContactIndex;
      serve = overrideContactIndex === undefined
        ? buildServeEventFromOverride(play, review, playersByTrackId)
        : buildServeEventFromContactOption(play, contactOptions[overrideContactIndex], 'corrected', review.updatedAt);
      reviewStatus = serve ? 'corrected' : detectedServe ? 'detected' : 'missing';

      if (reviewStatus === 'corrected') {
        summary.correctedServeCount += 1;
        summary.reviewedPlayCount += 1;
      } else if (reviewStatus === 'detected') {
        summary.detectedServeCount += 1;
      } else {
        summary.missingServeCount += 1;
      }
    } else if (detectedServe) {
      summary.detectedServeCount += 1;
    } else {
      summary.missingServeCount += 1;
    }

    if (serve) {
      summary.activeServeCount += 1;
    }

    return {
      playIndex: play.playIndex,
      sourceStartSeconds: play.sourceStartSeconds,
      sourceEndSeconds: play.sourceEndSeconds,
      trimmedStartSeconds: play.trimmedStartSeconds,
      trimmedEndSeconds: play.trimmedEndSeconds,
      sceneBlobName: play.sceneBlobName,
      detectedContactIndex,
      selectedContactIndex,
      detectedServe,
      serve,
      reviewStatus,
      hasReviewOverride: Boolean(review),
      updatedAt: review?.updatedAt,
      contactOptions,
    };
  });

  const serves = servePlays
    .flatMap(play => play.serve ? [play.serve] : [])
    .sort((left, right) => {
      if (left.trimmedTimestamp !== right.trimmedTimestamp) {
        return left.trimmedTimestamp - right.trimmedTimestamp;
      }
      return left.playIndex - right.playIndex;
    });

  return {
    generatedAt: params.playDescriptions?.generatedAt ?? params.reviewManifest?.updatedAt,
    trimmedDurationSeconds: servePlays.reduce((maxValue, play) => Math.max(maxValue, play.trimmedEndSeconds), 0),
    summary,
    plays: servePlays,
    serves,
  };
}
