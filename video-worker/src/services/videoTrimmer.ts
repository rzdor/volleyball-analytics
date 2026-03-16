import ffmpeg from 'fluent-ffmpeg';
import { TimeRange } from './motionDetector';

/**
 * Returns true when the video file contains at least one audio stream.
 */
function hasAudioStream(videoPath: string): Promise<boolean> {
  return new Promise(resolve => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) { resolve(false); return; }
      resolve(metadata.streams.some(s => s.codec_type === 'audio'));
    });
  });
}

/**
 * Uses ffmpeg filter_complex trim + concat to cut out only the provided
 * time ranges from the source video and write them consecutively to
 * outputPath (re-encoded as H.264/AAC MP4).
 *
 * Temporary files are not needed because ffmpeg handles all slicing in a
 * single pass via the filter graph.
 */
export async function trimVideoToSegments(
  inputPath: string,
  segments: TimeRange[],
  outputPath: string
): Promise<void> {
  if (segments.length === 0) {
    throw new Error('No segments provided for trimming');
  }

  const withAudio = await hasAudioStream(inputPath);

  const vFilters: string[] = [];
  const aFilters: string[] = [];
  const concatInputs: string[] = [];

  segments.forEach((seg, i) => {
    vFilters.push(
      `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`
    );
    if (withAudio) {
      aFilters.push(
        `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`
      );
      concatInputs.push(`[v${i}][a${i}]`);
    } else {
      concatInputs.push(`[v${i}]`);
    }
  });

  const n = segments.length;
  const audioSpec = withAudio ? ':a=1' : ':a=0';
  const outputLabels = withAudio ? '[outv][outa]' : '[outv]';
  const concatFilter = `${concatInputs.join('')}concat=n=${n}:v=1${audioSpec}${outputLabels}`;

  const filterComplex = [...vFilters, ...aFilters, concatFilter].join(';');

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath)
      .outputOptions(['-filter_complex', filterComplex, '-map', '[outv]']);

    if (withAudio) {
      cmd.outputOptions(['-map', '[outa]']);
    }

    cmd
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}
