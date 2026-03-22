import { StoredVideo } from './storageProvider';
import { TimeRange } from './motionDetector';
import { TeamSide } from './playerDetector';

export interface PlaySceneManifestEntry {
  playIndex: number;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  trimmedStartSeconds: number;
  trimmedEndSeconds: number;
  sceneBlobName: string;
  sceneBlobUrl: string;
}

export interface PlaySceneManifest {
  recordId: string;
  generatedAt: string;
  sourceVideoBlobName: string;
  processedBlobName: string;
  plays: PlaySceneManifestEntry[];
}

export interface PlayContactEvent {
  playerTrackId: number;
  teamId: number;
  teamSide?: TeamSide;
  frameIndex: number;
  timestamp: number;
  distanceToBallPx: number;
  ballConfidence: number;
}

export interface ContactedPlayerSummary {
  trackId: number;
  teamId: number;
  teamSide?: TeamSide;
  firstContactTimestamp: number;
  contactCount: number;
}

export interface PlayDescription {
  playIndex: number;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  trimmedStartSeconds: number;
  trimmedEndSeconds: number;
  sceneBlobName: string;
  sceneBlobUrl: string;
  contactedPlayers: ContactedPlayerSummary[];
  contacts: PlayContactEvent[];
}

export interface PlayDescriptionsManifest {
  recordId: string;
  generatedAt: string;
  sourceVideoBlobName: string;
  processedBlobName: string;
  playCount: number;
  plays: PlayDescription[];
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function buildPlaySceneManifest(params: {
  recordId: string;
  sourceVideoBlobName: string;
  processedBlobName: string;
  segments: TimeRange[];
  storedScenes: StoredVideo[];
}): PlaySceneManifest {
  let trimmedCursor = 0;

  const plays = params.segments.map((segment, index) => {
    const storedScene = params.storedScenes[index];
    const durationSeconds = Math.max(0, segment.end - segment.start);
    const play = {
      playIndex: index + 1,
      sourceStartSeconds: roundTime(segment.start),
      sourceEndSeconds: roundTime(segment.end),
      trimmedStartSeconds: roundTime(trimmedCursor),
      trimmedEndSeconds: roundTime(trimmedCursor + durationSeconds),
      sceneBlobName: `processed/${storedScene.name}`,
      sceneBlobUrl: storedScene.url,
    };

    trimmedCursor += durationSeconds;
    return play;
  });

  return {
    recordId: params.recordId,
    generatedAt: new Date().toISOString(),
    sourceVideoBlobName: params.sourceVideoBlobName,
    processedBlobName: params.processedBlobName,
    plays,
  };
}

export function buildPlayDescriptionsManifest(params: {
  recordId: string;
  sourceVideoBlobName: string;
  processedBlobName: string;
  sceneManifest: PlaySceneManifest;
  contactEvents: PlayContactEvent[];
}): PlayDescriptionsManifest {
  const plays = params.sceneManifest.plays.map((play, index) => {
    const isLastPlay = index === params.sceneManifest.plays.length - 1;
    const contacts = params.contactEvents
      .filter(event =>
        event.timestamp >= play.trimmedStartSeconds
        && (isLastPlay ? event.timestamp <= play.trimmedEndSeconds : event.timestamp < play.trimmedEndSeconds)
      )
      .sort((left, right) => left.timestamp - right.timestamp);

    const contactedPlayerMap = new Map<number, ContactedPlayerSummary>();
    for (const contact of contacts) {
      const existing = contactedPlayerMap.get(contact.playerTrackId);
      if (existing) {
        existing.contactCount += 1;
        continue;
      }

      contactedPlayerMap.set(contact.playerTrackId, {
        trackId: contact.playerTrackId,
        teamId: contact.teamId,
        teamSide: contact.teamSide,
        firstContactTimestamp: contact.timestamp,
        contactCount: 1,
      });
    }

    const contactedPlayers = [...contactedPlayerMap.values()]
      .sort((left, right) => left.firstContactTimestamp - right.firstContactTimestamp);

    return {
      playIndex: play.playIndex,
      sourceStartSeconds: play.sourceStartSeconds,
      sourceEndSeconds: play.sourceEndSeconds,
      trimmedStartSeconds: play.trimmedStartSeconds,
      trimmedEndSeconds: play.trimmedEndSeconds,
      sceneBlobName: play.sceneBlobName,
      sceneBlobUrl: play.sceneBlobUrl,
      contactedPlayers,
      contacts,
    };
  });

  return {
    recordId: params.recordId,
    generatedAt: new Date().toISOString(),
    sourceVideoBlobName: params.sourceVideoBlobName,
    processedBlobName: params.processedBlobName,
    playCount: plays.length,
    plays,
  };
}
