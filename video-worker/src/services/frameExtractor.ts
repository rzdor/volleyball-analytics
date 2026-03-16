import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export interface FrameExtractionResult {
  frames: string[];
  metadata: VideoMetadata;
  framesDir: string;
}

export async function getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      if (!videoStream) {
        reject(new Error('No video stream found'));
        return;
      }

      const duration = metadata.format.duration || 0;
      const width = videoStream.width || 0;
      const height = videoStream.height || 0;
      
      // Parse fps from r_frame_rate (e.g., "30/1" or "29.97")
      let fps = 30;
      if (videoStream.r_frame_rate) {
        const parts = videoStream.r_frame_rate.split('/');
        if (parts.length === 2) {
          fps = parseInt(parts[0]) / parseInt(parts[1]);
        } else {
          fps = parseFloat(videoStream.r_frame_rate);
        }
      }

      resolve({ duration, width, height, fps });
    });
  });
}

export async function extractFrames(
  videoPath: string,
  framesPerSecond: number = 1
): Promise<FrameExtractionResult> {
  const metadata = await getVideoMetadata(videoPath);
  
  // Create unique frames directory for this video
  const videoId = path.basename(videoPath, path.extname(videoPath));
  const framesDir = path.join(__dirname, '../../uploads/frames', videoId);
  
  // Ensure frames directory exists
  if (!fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    
    ffmpeg(videoPath)
      .outputOptions([
        `-vf fps=${framesPerSecond}`,
        '-q:v 2' // High quality JPEG
      ])
      .output(path.join(framesDir, 'frame-%04d.jpg'))
      .on('end', () => {
        // Read all extracted frames
        const files = fs.readdirSync(framesDir)
          .filter(f => f.endsWith('.jpg'))
          .sort()
          .map(f => path.join(framesDir, f));
        
        resolve({
          frames: files,
          metadata,
          framesDir
        });
      })
      .on('error', (err) => {
        reject(err);
      })
      .run();
  });
}

export function cleanupFrames(framesDir: string): void {
  try {
    if (fs.existsSync(framesDir)) {
      const files = fs.readdirSync(framesDir);
      files.forEach(file => {
        fs.unlinkSync(path.join(framesDir, file));
      });
      fs.rmdirSync(framesDir);
    }
  } catch (error) {
    console.error('Error cleaning up frames:', error);
  }
}
