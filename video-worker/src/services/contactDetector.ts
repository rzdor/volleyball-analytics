import { BallDetection, DetectionResult, FramePlayer } from './playerDetector';
import { PlayContactEvent } from './playDescriptions';

export interface ContactDetectorOptions {
  minBallConfidence?: number;
  maxSamePlayerGapSeconds?: number;
  contactDistanceRatio?: number;
}

interface Point {
  x: number;
  y: number;
}

function getBallCenter(ball: BallDetection): Point {
  return {
    x: ball.bbox.x + ball.bbox.w / 2,
    y: ball.bbox.y + ball.bbox.h / 2,
  };
}

function distancePointToRect(point: Point, player: FramePlayer): number {
  const minX = player.bbox.x;
  const maxX = player.bbox.x + player.bbox.w;
  const minY = player.bbox.y;
  const maxY = player.bbox.y + player.bbox.h;
  const dx = Math.max(minX - point.x, 0, point.x - maxX);
  const dy = Math.max(minY - point.y, 0, point.y - maxY);
  return Math.sqrt(dx * dx + dy * dy);
}

function findClosestContact(framePlayers: FramePlayer[], ball: BallDetection, contactDistanceRatio: number) {
  const ballCenter = getBallCenter(ball);
  let bestMatch: { player: FramePlayer; distanceToBallPx: number } | undefined;

  for (const player of framePlayers) {
    if (player.trackId < 0 || player.teamId < 0) {
      continue;
    }

    const distanceToBallPx = distancePointToRect(ballCenter, player);
    const contactThreshold = Math.max(12, Math.min(player.bbox.w, player.bbox.h) * contactDistanceRatio);
    if (distanceToBallPx > contactThreshold) {
      continue;
    }

    if (!bestMatch || distanceToBallPx < bestMatch.distanceToBallPx) {
      bestMatch = { player, distanceToBallPx };
    }
  }

  return bestMatch;
}

export function inferPlayerBallContacts(
  result: DetectionResult,
  options: ContactDetectorOptions = {}
): PlayContactEvent[] {
  const {
    minBallConfidence = 0.2,
    maxSamePlayerGapSeconds = 0.45,
    contactDistanceRatio = 0.35,
  } = options;

  const contacts: PlayContactEvent[] = [];

  for (const frame of result.frames) {
    if (!Array.isArray(frame.balls) || frame.balls.length === 0 || frame.players.length === 0) {
      continue;
    }

    const ball = [...frame.balls]
      .filter(candidate => candidate.confidence >= minBallConfidence)
      .sort((left, right) => right.confidence - left.confidence)[0];

    if (!ball) {
      continue;
    }

    const bestMatch = findClosestContact(frame.players, ball, contactDistanceRatio);
    if (!bestMatch) {
      continue;
    }

    const event: PlayContactEvent = {
      playerTrackId: bestMatch.player.trackId,
      teamId: bestMatch.player.teamId,
      teamSide: bestMatch.player.teamSide,
      frameIndex: frame.frameIndex,
      timestamp: frame.timestamp,
      distanceToBallPx: Math.round(bestMatch.distanceToBallPx * 1000) / 1000,
      ballConfidence: ball.confidence,
    };

    const previous = contacts[contacts.length - 1];
    if (
      previous
      && previous.playerTrackId === event.playerTrackId
      && event.timestamp - previous.timestamp <= maxSamePlayerGapSeconds
    ) {
      continue;
    }

    contacts.push(event);
  }

  return contacts;
}
