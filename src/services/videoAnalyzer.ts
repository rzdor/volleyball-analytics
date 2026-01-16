import OpenAI, { AzureOpenAI } from 'openai';
import fs from 'fs';
import path from 'path';
import { extractFrames, cleanupFrames, FrameExtractionResult } from './frameExtractor';

// Initialize OpenAI client (supports both direct OpenAI and Azure)
function createOpenAIClient(): OpenAI {
  const useAzure = process.env.USE_AZURE === 'true';
  
  if (useAzure) {
    return new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: '2024-02-15-preview'
    });
  }
  
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

function getModelName(): string {
  const useAzure = process.env.USE_AZURE === 'true';
  if (useAzure) {
    return process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  }
  return 'gpt-4o';
}

const openai = createOpenAIClient();

export interface VolleyballAnalysis {
  playType: string;
  playerPositions: string;
  technicalFeedback: string[];
  tacticalSuggestions: string[];
  drillRecommendations: string[];
  overallAssessment: string;
  framesAnalyzed?: number;
  estimatedCost?: string;
}

export interface AnalysisOptions {
  framesPerSecond?: number;
  maxFrames?: number;
}

const DEFAULT_OPTIONS: AnalysisOptions = {
  framesPerSecond: 1,
  maxFrames: 20
};

export async function analyzeVolleyballVideo(
  videoPath: string | null,
  description: string,
  options: AnalysisOptions = {}
): Promise<VolleyballAnalysis> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  const systemPrompt = `You are an expert volleyball coach with decades of experience analyzing plays and providing actionable feedback.
Analyze the volleyball play shown in these video frames and provide detailed coaching suggestions.

Focus on:
1. Identifying the type of play (serve, spike, block, dig, set, etc.)
2. Player positioning and movement patterns across frames
3. Technical execution feedback (form, timing, contact point)
4. Tactical improvements (court coverage, anticipation, team coordination)
5. Recommended drills to improve specific weaknesses observed

Provide specific, actionable advice based on what you SEE in the frames. Reference specific frames when noting issues or good technique.`;

  if (videoPath) {
    return analyzeWithVision(videoPath, description, systemPrompt, opts);
  } else {
    return analyzeTextOnly(description, systemPrompt);
  }
}

async function analyzeWithVision(
  videoPath: string,
  description: string,
  systemPrompt: string,
  options: AnalysisOptions
): Promise<VolleyballAnalysis> {
  let frameResult: FrameExtractionResult | null = null;
  
  try {
    console.log(`Extracting frames at ${options.framesPerSecond} fps...`);
    frameResult = await extractFrames(videoPath, options.framesPerSecond!);
    
    // Limit frames to maxFrames
    let framesToAnalyze = frameResult.frames;
    if (framesToAnalyze.length > options.maxFrames!) {
      // Sample frames evenly across the video
      const step = Math.ceil(framesToAnalyze.length / options.maxFrames!);
      framesToAnalyze = framesToAnalyze.filter((_, i) => i % step === 0).slice(0, options.maxFrames!);
    }
    
    console.log(`Analyzing ${framesToAnalyze.length} frames with GPT-4 Vision...`);
    
    // Build image content array for GPT-4 Vision
    const imageContents: OpenAI.Chat.Completions.ChatCompletionContentPart[] = framesToAnalyze.map((framePath, index) => {
      const imageData = fs.readFileSync(framePath);
      const base64Image = imageData.toString('base64');
      return {
        type: 'image_url' as const,
        image_url: {
          url: `data:image/jpeg;base64,${base64Image}`,
          detail: 'low' as const // Use low detail to reduce costs
        }
      };
    });

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      {
        type: 'text' as const,
        text: `Analyze these ${framesToAnalyze.length} sequential frames from a volleyball play.
        
Video duration: ${frameResult.metadata.duration.toFixed(1)} seconds
Frame rate extracted: ${options.framesPerSecond} fps
Video resolution: ${frameResult.metadata.width}x${frameResult.metadata.height}

${description ? `Additional context from coach/player: ${description}` : ''}

Please analyze the technique, positioning, and execution visible in these frames and provide comprehensive coaching feedback.`
      },
      ...imageContents
    ];

    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });

    const content = response.choices[0]?.message?.content || '';
    const analysis = parseAnalysisResponse(content);
    
    // Add frame analysis metadata
    analysis.framesAnalyzed = framesToAnalyze.length;
    analysis.estimatedCost = estimateCost(framesToAnalyze.length);
    
    return analysis;
  } catch (error) {
    console.error('Vision analysis error:', error);
    return getMockAnalysis(description);
  } finally {
    // Cleanup extracted frames
    if (frameResult) {
      cleanupFrames(frameResult.framesDir);
    }
  }
}

async function analyzeTextOnly(
  description: string,
  systemPrompt: string
): Promise<VolleyballAnalysis> {
  try {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze the following volleyball play description and provide coaching feedback:\n\n${description}` }
      ],
      temperature: 0.7,
      max_tokens: 1500
    });

    const content = response.choices[0]?.message?.content || '';
    return parseAnalysisResponse(content);
  } catch (error) {
    console.error('OpenAI API error:', error);
    return getMockAnalysis(description);
  }
}

function estimateCost(frameCount: number): string {
  // GPT-4o with low detail images: ~$0.002 per image + text tokens
  const imageCost = frameCount * 0.002;
  const textCost = 0.01; // Approximate for input/output text
  const total = imageCost + textCost;
  return `~$${total.toFixed(3)}`;
}

function parseAnalysisResponse(content: string): VolleyballAnalysis {
  // Parse the AI response into structured format
  const sections = content.split('\n\n');
  
  return {
    playType: extractSection(content, 'play type', 'type') || 'General volleyball play',
    playerPositions: extractSection(content, 'position', 'movement') || 'Standard rotation positions',
    technicalFeedback: extractBulletPoints(content, 'technical', 'execution'),
    tacticalSuggestions: extractBulletPoints(content, 'tactical', 'strategy'),
    drillRecommendations: extractBulletPoints(content, 'drill', 'practice'),
    overallAssessment: sections[sections.length - 1] || content.substring(0, 500)
  };
}

function extractSection(content: string, ...keywords: string[]): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    if (keywords.some(kw => lowerLine.includes(kw))) {
      return line.replace(/^[#\-*\d.]+\s*/, '').trim();
    }
  }
  return '';
}

function extractBulletPoints(content: string, ...keywords: string[]): string[] {
  const lines = content.split('\n');
  const points: string[] = [];
  let inSection = false;
  
  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    
    if (keywords.some(kw => lowerLine.includes(kw))) {
      inSection = true;
      continue;
    }
    
    if (inSection) {
      if (line.match(/^[\-*•]\s/) || line.match(/^\d+\.\s/)) {
        points.push(line.replace(/^[\-*•\d.]+\s*/, '').trim());
      } else if (line.trim() === '' || line.startsWith('#')) {
        inSection = false;
      }
    }
  }
  
  return points.length > 0 ? points : ['Focus on fundamentals', 'Practice consistently', 'Work on timing'];
}

function getMockAnalysis(description: string): VolleyballAnalysis {
  const lowerDesc = description.toLowerCase();
  
  let playType = 'General Play';
  if (lowerDesc.includes('serve')) playType = 'Serve';
  else if (lowerDesc.includes('spike') || lowerDesc.includes('attack')) playType = 'Attack/Spike';
  else if (lowerDesc.includes('block')) playType = 'Block';
  else if (lowerDesc.includes('dig')) playType = 'Dig/Defense';
  else if (lowerDesc.includes('set')) playType = 'Set';
  
  return {
    playType,
    playerPositions: 'Based on the play description, ensure proper rotation and positioning. Middle blockers should be ready to transition, and outside hitters should maintain their approach angles.',
    technicalFeedback: [
      'Focus on proper footwork during approach',
      'Maintain eye contact with the ball throughout the play',
      'Keep arms and hands in ready position',
      'Use proper body mechanics for power and control',
      'Follow through completely on each action'
    ],
    tacticalSuggestions: [
      'Communicate with teammates before and during the play',
      'Read the opposing team\'s formation and adjust accordingly',
      'Vary your attacks to keep opponents guessing',
      'Use quick sets to exploit gaps in the block',
      'Position defensive players based on opposing hitter tendencies'
    ],
    drillRecommendations: [
      'Pepper drill for ball control and passing',
      'Approach footwork ladder drills',
      'Target serving practice',
      'Block timing exercises with setter',
      'Transition footwork and attack combinations'
    ],
    overallAssessment: `This ${playType.toLowerCase()} play shows potential for improvement. Focus on the technical fundamentals while maintaining court awareness. Regular practice of the recommended drills will help develop muscle memory and improve execution under pressure. Remember that volleyball is a team sport - communication and timing with teammates is just as important as individual skill.`
  };
}
