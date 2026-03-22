import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export interface PlayerDetectorOptions {
  sampleFps?: number;
  confidence?: number;
  numTeams?: number;
  modelName?: string;
}

export interface PlayerBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TeamSide = 'main' | 'opponent';

export interface BallDetection {
  bbox: PlayerBbox;
  confidence: number;
}

export interface FramePlayer {
  trackId: number;
  teamId: number;
  teamSide?: TeamSide;
  bbox: PlayerBbox;
  confidence: number;
}

export interface FrameDetection {
  frameIndex: number;
  timestamp: number;
  players: FramePlayer[];
  balls: BallDetection[];
}

export interface TeamInfo {
  id: number;
  dominantColor: [number, number, number];
  playerCount: number;
  side?: TeamSide;
}

export interface TrackSummary {
  trackId: number;
  teamId: number;
  teamSide?: TeamSide;
  firstFrame: number;
  lastFrame: number;
  frameCount: number;
  avgConfidence: number;
}

export interface DetectionResult {
  videoName: string;
  processedAt: string;
  sampleFps: number;
  videoFps: number;
  totalVideoFrames: number;
  sampledFrames: number;
  teams: TeamInfo[];
  frames: FrameDetection[];
  tracks: TrackSummary[];
}

const PYTHON_SCRIPT = path.join(__dirname, '../../python/detect_players.py');

export function detectPlayers(
  videoPath: string,
  outputDir: string,
  options: PlayerDetectorOptions = {},
  log: (msg: string, ...args: unknown[]) => void = console.log,
): Promise<DetectionResult> {
  const {
    sampleFps = 2,
    confidence = 0.5,
    numTeams = 2,
    modelName = 'yolov8n.pt',
  } = options;

  const outputFilename = `detection-${randomUUID()}.json`;
  const outputPath = path.join(outputDir, outputFilename);

  const args = [
    PYTHON_SCRIPT,
    videoPath,
    outputPath,
    '--sample-fps', String(sampleFps),
    '--confidence', String(confidence),
    '--num-teams', String(numTeams),
    '--model', modelName,
  ];

  return new Promise((resolve, reject) => {
    log('[playerDetector] Spawning Python process', { args });

    const proc = spawn('python3', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        stderr += line + '\n';
        log('[playerDetector:py]', line);
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start Python process: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(
          `Python detection script exited with code ${code}.\nStderr: ${stderr}`
        ));
        return;
      }

      try {
        const jsonContent = fs.readFileSync(outputPath, 'utf-8');
        const result: DetectionResult = JSON.parse(jsonContent);

        log('[playerDetector] Detection complete', {
          teams: result.teams.length,
          tracks: result.tracks.length,
          frames: result.frames.length,
        });

        resolve(result);
      } catch (err) {
        reject(new Error(
          `Failed to parse detection output at ${outputPath}: ${(err as Error).message}`
        ));
      }
    });
  });
}
