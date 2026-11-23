import { z } from 'zod';

export const TargetLangSchema = z.enum(['my-MM', 'en-US']);
export type TargetLang = z.infer<typeof TargetLangSchema>;

export const ProjectModeSchema = z.enum(['dubbing', 'recap']);
export type ProjectMode = z.infer<typeof ProjectModeSchema>;

export const TtsEngineTypeSchema = z.enum(['edge', 'gemini']);
export type TtsEngineType = z.infer<typeof TtsEngineTypeSchema>;

export const TtsProviderSchema = z.enum(['edge', 'edge-tts', 'gemini', 'f5-myanmar']);
export type TtsProvider = z.infer<typeof TtsProviderSchema>;

export const ScriptEmotionSchema = z.enum([
  'neutral',
  'happy',
  'sad',
  'excited',
  'serious',
  'angry',
  'fear',
]);
export type ScriptEmotion = z.infer<typeof ScriptEmotionSchema>;

export const SpeechStyleSchema = z.enum(['polite', 'casual']);
export type SpeechStyle = z.infer<typeof SpeechStyleSchema>;

export const BackgroundAudioModeSchema = z.enum(['mute_original', 'keep_bgm_demucs']);
export type BackgroundAudioMode = z.infer<typeof BackgroundAudioModeSchema>;

export const LanguageVoicePoolSchema = z.object({
  female: z.array(z.string()).default([]),
  male: z.array(z.string()).default([]),
});
export type LanguageVoicePool = z.infer<typeof LanguageVoicePoolSchema>;

export const EngineVoicePoolsSchema = z.object({
  'my-MM': LanguageVoicePoolSchema.default({ female: [], male: [] }),
  'en-US': LanguageVoicePoolSchema.default({ female: [], male: [] }),
});
export type EngineVoicePools = z.infer<typeof EngineVoicePoolsSchema>;

export const VoicePoolsConfigSchema = z.object({
  edge: EngineVoicePoolsSchema,
  gemini: EngineVoicePoolsSchema,
});
export type VoicePoolsConfig = z.infer<typeof VoicePoolsConfigSchema>;

export const GenderSchema = z.enum(['male', 'female', 'unknown']);
export type Gender = z.infer<typeof GenderSchema>;

export const StageStatusSchema = z.enum(['pending', 'running', 'done', 'error']);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const StageStateSchema = z.object({
  status: StageStatusSchema,
  progress_pct: z.number().min(0).max(100).default(0),
  message: z.string().optional(),
  error: z.string().optional(),
  model_used: z.string().optional(),
  updated_at: z.string().optional(),
});
export type StageState = z.infer<typeof StageStateSchema>;

export const SpeechSegmentSchema = z.object({
  id: z.number().int().positive(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  speaker: z.string().min(1),
  src_lang: z.string().default('und'),
  text: z.string(),
  emotion: ScriptEmotionSchema.optional(),
  window_index: z.number().int().nonnegative().optional(),
});
export type SpeechSegment = z.infer<typeof SpeechSegmentSchema>;

export const VoiceAssignmentSchema = z.object({
  engine: TtsEngineTypeSchema,
  name: z.string(),
});

export const SpeakerInfoSchema = z.object({
  gender: GenderSchema,
  confidence: z.number().min(0).max(1).optional(),
  gender_overridden: z.boolean().optional(),
  sample_file: z.string().optional(),
  merged_from: z.array(z.string()).optional(),
  voice: VoiceAssignmentSchema.optional(),
  voice_overridden: z.boolean().optional(),
});
export type SpeakerInfo = z.infer<typeof SpeakerInfoSchema>;

export const DubStatusSchema = z.enum([
  'ok',
  'compressed',
  'retranslated',
  'overflow',
  'needs_review',
]);

export const DubSegmentSchema = z.object({
  id: z.number().int().positive(),
  lang: TargetLangSchema.default('my-MM'),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  speaker: z.string(),
  src_lang: z.string().default('und'),
  src_text: z.string(),
  tgt_text: z.string(),
  slot_ms: z.number().int().nonnegative(),
  tts_ms: z.number().int().nonnegative(),
  tts_file: z.string(),
  rate: z.number().positive(),
  video_rate: z.number().positive().optional(),
  borrowed_end_ms: z.number().int().nonnegative().optional(),
  effective_start_ms: z.number().int().nonnegative().optional(),
  effective_end_ms: z.number().int().nonnegative().optional(),
  status: DubStatusSchema,
  review_reason: z.string().optional(),
  merged_ids: z.array(z.number().int().positive()).optional(),
  voice_name: z.string().optional(),
  model_used: z.string().optional(),
  tts_model_used: z.string().optional(),
  tts_engine: TtsEngineTypeSchema.optional(),
  syllables: z.number().nonnegative().optional(),
  emotion: ScriptEmotionSchema.optional(),
  error: z.string().optional(),
});
export type DubSegment = z.infer<typeof DubSegmentSchema>;

export const DubSelectionSchema = z.object({
  mode: z.enum(['first_n', 'range', 'all']).default('first_n'),
  count: z.number().int().positive().default(8),
  start_idx: z.number().int().positive().default(1),
  end_idx: z.number().int().positive().default(8),
});
export type DubSelection = z.infer<typeof DubSelectionSchema>;

export const DubValidationReportSchema = z.object({
  lang: TargetLangSchema,
  video_duration_ms: z.number().nonnegative(),
  audio_duration_ms: z.number().nonnegative(),
  av_diff_ms: z.number().nonnegative(),
  passed_40ms: z.boolean(),
  range_start_ms: z.number().nonnegative(),
  range_end_ms: z.number().nonnegative(),
  is_full_video: z.boolean(),
  total_segments: z.number().int().nonnegative(),
  ok_count: z.number().int().nonnegative(),
  compressed_count: z.number().int().nonnegative(),
  retranslated_count: z.number().int().nonnegative(),
  overflow_count: z.number().int().nonnegative(),
  needs_review_count: z.number().int().nonnegative(),
  flagged_segments: z
    .array(
      z.object({
        id: z.number().int(),
        status: DubStatusSchema,
        slot_ms: z.number().nonnegative(),
        tts_ms: z.number().nonnegative(),
        speaker: z.string(),
        tgt_text: z.string(),
      }),
    )
    .default([]),
  mp4_file: z.string().optional(),
  wav_file: z.string().optional(),
  srt_file: z.string().optional(),
  generated_at: z.string(),
});
export type DubValidationReport = z.infer<typeof DubValidationReportSchema>;

export const VideoMetaSchema = z.object({
  filename: z.string().default(''),
  size_bytes: z.number().nonnegative().default(0),
  fps: z.number().nonnegative().default(0),
  width: z.number().int().nonnegative().default(0),
  height: z.number().int().nonnegative().default(0),
  is_vfr: z.boolean().default(false),
  duration_ms: z.number().int().nonnegative().default(0),
  v_start_ms: z.number().int().default(0),
  a_start_ms: z.number().int().default(0),
  stream_offset_ms: z.number().int().default(0),
  has_audio: z.boolean().default(true),
  proxy_480p_file: z.string().optional(),
});
export type VideoMeta = z.infer<typeof VideoMetaSchema>;

export const UploadStateSchema = z.object({
  total_chunks: z.number().int().nonnegative().default(0),
  received_chunks: z.array(z.number().int().nonnegative()).default([]),
  chunk_size_bytes: z.number().int().positive().default(8388608),
  expected_size_bytes: z.number().nonnegative().default(0),
  completed: z.boolean().default(false),
});
export type UploadState = z.infer<typeof UploadStateSchema>;

export const ChunkStatusSchema = z.enum(['pending', 'running', 'done', 'error']);
export type ChunkStatus = z.infer<typeof ChunkStatusSchema>;

export const VideoChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  status: ChunkStatusSchema.default('pending'),
  analyze_done: z.boolean().default(false),
  dub_done_langs: z.array(TargetLangSchema).default([]),
  speech_count: z.number().int().nonnegative().default(0),
  rendered_mp4_files: z.record(z.string(), z.string()).default({}),
  rendered_wav_files: z.record(z.string(), z.string()).default({}),
  rendered_srt_files: z.record(z.string(), z.string()).default({}),
  error: z.string().optional(),
  updated_at: z.string().optional(),
});
export type VideoChunk = z.infer<typeof VideoChunkSchema>;

export const ChunkProgressSchema = z.object({
  active: z.boolean().default(false),
  current_index: z.number().int().nonnegative().default(0),
  total_chunks: z.number().int().nonnegative().default(0),
  start_ms: z.number().int().nonnegative().default(0),
  end_ms: z.number().int().nonnegative().default(0),
  phase: z
    .enum(['planning', 'analyze', 'translate', 'tts', 'render', 'merging', 'done', 'error'])
    .default('planning'),
  message: z.string().optional(),
});
export type ChunkProgress = z.infer<typeof ChunkProgressSchema>;

export const RecapSourceModeSchema = z.enum(['raw_movie', 'existing_vo']);
export type RecapSourceMode = z.infer<typeof RecapSourceModeSchema>;

export const RecapScriptStatusSchema = z.enum(['idle', 'generated', 'approved', 'rendered']);
export type RecapScriptStatus = z.infer<typeof RecapScriptStatusSchema>;

export const RecapBeatSchema = z.object({
  id: z.number().int().positive(),
  lang: TargetLangSchema.default('my-MM'),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  src_text: z.string().default(''),
  scene_note: z.string().optional(),
  narration_text: z.string().default(''),
  slot_ms: z.number().int().nonnegative().default(0),
  max_syllables: z.number().int().nonnegative().optional(),
  syllables: z.number().nonnegative().optional(),
  tts_ms: z.number().int().nonnegative().default(0),
  tts_file: z.string().default(''),
  rate: z.number().positive().default(1.2),
  video_rate: z.number().positive().default(1.0),
  effective_start_ms: z.number().int().nonnegative().optional(),
  effective_end_ms: z.number().int().nonnegative().optional(),
  status: DubStatusSchema.default('ok'),
  voice_name: z.string().optional(),
  tts_engine: TtsEngineTypeSchema.optional(),
  tts_model_used: z.string().optional(),
  model_used: z.string().optional(),
  review_reason: z.string().optional(),
  emotion: ScriptEmotionSchema.optional(),
  error: z.string().optional(),
});
export type RecapBeat = z.infer<typeof RecapBeatSchema>;

export const ExportAspectRatioSchema = z.enum(['16:9', '9:16', '1:1', '4:5']);
export type ExportAspectRatio = z.infer<typeof ExportAspectRatioSchema>;

export const ExportFitModeSchema = z.enum(['crop', 'blur']);
export type ExportFitMode = z.infer<typeof ExportFitModeSchema>;

export const ExportSubtitleModeSchema = z.enum(['none', 'mm', 'en']);
export type ExportSubtitleMode = z.infer<typeof ExportSubtitleModeSchema>;

export const ExportSubtitlePresetSchema = z.enum(['classic', 'boxed', 'neon', 'minimal']);
export type ExportSubtitlePreset = z.infer<typeof ExportSubtitlePresetSchema>;

export const ExportVisualFilterPresetSchema = z.enum([
  'none',
  '4k',
  '8k',
  'clear2',
  'clearsky',
  'hdcam2',
  'vivid',
]);
export type ExportVisualFilterPreset = z.infer<typeof ExportVisualFilterPresetSchema>;

export const ExportBorderPresetSchema = z.enum([
  'none',
  'gold',
  'neonCyan',
  'fireRed',
  'pink',
  'royalPurple',
  'rainbow',
]);
export type ExportBorderPreset = z.infer<typeof ExportBorderPresetSchema>;

export const ExportBlurBoxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  x: z.number().min(0).max(1).default(0.08),
  y: z.number().min(0).max(1).default(0.7),
  w: z.number().min(0.02).max(1).default(0.84),
  h: z.number().min(0.02).max(1).default(0.14),
  strength: z.number().int().min(1).max(40).default(12),
});
export type ExportBlurBoxConfig = z.infer<typeof ExportBlurBoxConfigSchema>;

export const ExportBorderConfigSchema = z.object({
  preset: ExportBorderPresetSchema.default('none'),
  /** Border thickness as a percentage of the exported video height (WYSIWYG in Preview). */
  thicknessPct: z.number().min(0.2).max(8).default(1.5),
});
export type ExportBorderConfig = z.infer<typeof ExportBorderConfigSchema>;

export const ExportSubtitleConfigSchema = z.object({
  mode: ExportSubtitleModeSchema.default('mm'),
  fontFamily: z.string().default('Noto Sans Myanmar, Myanmar Sangam MN, sans-serif'),
  /** Legacy absolute size (px at 540p reference). Kept for old saved projects. */
  fontSize: z.number().min(10).max(96).default(24),
  /**
   * WYSIWYG subtitle size as a percentage of the video height. Preview renders
   * stageHeight * fontSizePct / 100 px; the ASS export uses PlayResY = export height and
   * Fontsize = height * fontSizePct / 100, so both render the identical relative size.
   */
  fontSizePct: z.number().min(1).max(20).default(4.4),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFFFF'),
  outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#000000'),
  /** Outline width in px at the 540p reference height (scaled proportionally on export). */
  outlineWidth: z.number().min(0).max(14).default(2.8),
  /** Shadow depth in px at the 540p reference height (0 = no shadow). */
  shadowDepth: z.number().min(0).max(10).default(1.5),
  /** Background box color used by boxed/classic presets and the ASS BackColour. */
  bgColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#000000'),
  bgOpacity: z.number().min(0).max(1).default(0.72),
  yPercent: z.number().min(5).max(95).default(82),
  stylePreset: ExportSubtitlePresetSchema.default('boxed'),
});
export type ExportSubtitleConfig = z.infer<typeof ExportSubtitleConfigSchema>;

export const ExportLogoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  dataUrl: z.string().nullable().default(null),
  filePath: z.string().nullable().default(null),
  circleCrop: z.boolean().default(true),
  removeBg: z.boolean().default(false),
  xPercent: z.number().min(0).max(100).default(88),
  yPercent: z.number().min(0).max(100).default(8),
  scalePercent: z.number().min(5).max(40).default(12),
});
export type ExportLogoConfig = z.infer<typeof ExportLogoConfigSchema>;

export const ExportVisualConfigSchema = z.object({
  aspectRatio: ExportAspectRatioSchema.default('16:9'),
  fitMode: ExportFitModeSchema.default('crop'),
  flipHorizontal: z.boolean().default(false),
  flipVertical: z.boolean().default(false),
  filterPreset: ExportVisualFilterPresetSchema.default('none'),
  blurBox: ExportBlurBoxConfigSchema.default({
    enabled: false,
    x: 0.08,
    y: 0.7,
    w: 0.84,
    h: 0.14,
    strength: 12,
  }),
  border: ExportBorderConfigSchema.default({ preset: 'none', thicknessPct: 1.5 }),
  subtitle: ExportSubtitleConfigSchema.default({
    mode: 'mm',
    fontFamily: 'Noto Sans Myanmar, Myanmar Sangam MN, sans-serif',
    fontSize: 24,
    fontSizePct: 4.4,
    textColor: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 2.8,
    shadowDepth: 1.5,
    bgColor: '#000000',
    bgOpacity: 0.72,
    yPercent: 82,
    stylePreset: 'boxed',
  }),
  logo: ExportLogoConfigSchema.default({
    enabled: false,
    dataUrl: null,
    filePath: null,
    circleCrop: true,
    removeBg: false,
    xPercent: 88,
    yPercent: 8,
    scalePercent: 12,
  }),
});
export type ExportVisualConfig = z.infer<typeof ExportVisualConfigSchema>;

/* ---------------------------------------------------------------------------
 * WYSIWYG mapping helpers — the single source of truth shared by the Live
 * Preview (CSS px) and the ASS/FFmpeg export (PlayRes + Fontsize), so both
 * render subtitles at the exact same relative size/position.
 * ------------------------------------------------------------------------- */

/** ASS Fontsize for a video of `videoHeightPx` — identical formula used in Preview CSS. */
export function subtitleFontPxForHeight(subtitle: ExportVisualConfig['subtitle'], videoHeightPx: number): number {
  return Math.max(8, (videoHeightPx * subtitle.fontSizePct) / 100);
}

/** Preview stage px for the current stage height (uses the same relative size as export). */
export function subtitleFontPxForStage(subtitle: ExportVisualConfig['subtitle'], stageHeightPx: number): number {
  return Math.max(8, (stageHeightPx * subtitle.fontSizePct) / 100);
}

/** ASS MarginV from the draggable yPercent — same fraction in Preview (`top: yPercent%`). */
export function subtitleMarginVForHeight(subtitle: ExportVisualConfig['subtitle'], videoHeightPx: number): number {
  const clampedY = Math.max(5, Math.min(95, subtitle.yPercent));
  return Math.max(0, Math.round((videoHeightPx * (100 - clampedY)) / 100));
}

/** ASS Outline/Shadow widths scaled from the 540p reference to the real export height. */
export function subtitleOutlineWidthForHeight(subtitle: ExportVisualConfig['subtitle'], videoHeightPx: number): number {
  return Math.max(0, (subtitle.outlineWidth * videoHeightPx) / 540);
}

export function subtitleShadowDepthForHeight(subtitle: ExportVisualConfig['subtitle'], videoHeightPx: number): number {
  return Math.max(0, (subtitle.shadowDepth * videoHeightPx) / 540);
}

/** Preview outline/shadow px for the stage height (same relative scale as export). */
export function subtitleOutlineWidthForStage(subtitle: ExportVisualConfig['subtitle'], stageHeightPx: number): number {
  return Math.max(0, (subtitle.outlineWidth * stageHeightPx) / 540);
}

/** Border thickness in px for a given rendered height (Preview stage or export video). */
export function borderThicknessPxForHeight(border: ExportVisualConfig['border'], heightPx: number): number {
  return Math.max(1, Math.round((heightPx * border.thicknessPct) / 100));
}

/** Hex color for each border preset (also used to build FFmpeg drawbox colors). */
export function borderPresetColor(preset: ExportBorderPreset): string | null {
  switch (preset) {
    case 'gold':
      return '#FFD700';
    case 'neonCyan':
      return '#00E5FF';
    case 'fireRed':
      return '#FF3B30';
    case 'pink':
      return '#FF69B4';
    case 'royalPurple':
      return '#7C3AED';
    case 'rainbow':
      return null; // rendered as 4 gradient sides in preview; boxblur-free drawbox stack in export
    case 'none':
    default:
      return null;
  }
}

/** FFmpeg `unsharp`+`eq`(+`colorbalance`) chain per CapCut-style filter preset. */
export function filterPresetToFfmpegChain(preset: ExportVisualFilterPreset): string {
  switch (preset) {
    case '4k':
      return 'unsharp=5:5:0.8:5:5:0.0,eq=contrast=1.08:saturation=1.12:brightness=0.02';
    case '8k':
      return 'unsharp=5:5:1.25:5:5:0.0,eq=contrast=1.14:saturation=1.16:brightness=0.03';
    case 'clear2':
      return 'unsharp=3:3:0.7:3:3:0.0,eq=contrast=1.06:saturation=1.08:gamma=1.03';
    case 'clearsky':
      return 'unsharp=3:3:0.6:3:3:0.0,eq=contrast=1.05:saturation=1.18:brightness=0.03,colorbalance=bs=0.05:bm=0.04';
    case 'hdcam2':
      return 'unsharp=5:5:0.9:5:5:0.0,eq=contrast=1.10:saturation=1.06,colorbalance=rs=0.03:gs=0.01:bs=-0.02';
    case 'vivid':
      return 'unsharp=3:3:0.5:3:3:0.0,eq=contrast=1.12:saturation=1.30:brightness=0.02';
    case 'none':
    default:
      return '';
  }
}

/** CSS filter approximating the same look for the Live Preview <video>. */
export function filterPresetToCssFilter(preset: ExportVisualFilterPreset): string {
  switch (preset) {
    case '4k':
      return 'contrast(1.08) saturate(1.12) brightness(1.02)';
    case '8k':
      return 'contrast(1.14) saturate(1.16) brightness(1.03)';
    case 'clear2':
      return 'contrast(1.06) saturate(1.08)';
    case 'clearsky':
      return 'contrast(1.05) saturate(1.18) brightness(1.03) hue-rotate(-4deg)';
    case 'hdcam2':
      return 'contrast(1.10) saturate(1.06) hue-rotate(6deg)';
    case 'vivid':
      return 'contrast(1.12) saturate(1.30) brightness(1.02)';
    case 'none':
    default:
      return '';
  }
}

export const DEFAULT_EXPORT_VISUAL_CONFIG: ExportVisualConfig = {
  aspectRatio: '16:9',
  fitMode: 'crop',
  flipHorizontal: false,
  flipVertical: false,
  filterPreset: 'none',
  blurBox: { enabled: false, x: 0.08, y: 0.7, w: 0.84, h: 0.14, strength: 12 },
  border: { preset: 'none', thicknessPct: 1.5 },
  subtitle: {
    mode: 'mm',
    fontFamily: 'Noto Sans Myanmar, Myanmar Sangam MN, sans-serif',
    fontSize: 24,
    fontSizePct: 4.4,
    textColor: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 2.8,
    shadowDepth: 1.5,
    bgColor: '#000000',
    bgOpacity: 0.72,
    yPercent: 82,
    stylePreset: 'boxed',
  },
  logo: {
    enabled: false,
    dataUrl: null,
    filePath: null,
    circleCrop: true,
    removeBg: false,
    xPercent: 88,
    yPercent: 8,
    scalePercent: 12,
  },
};

export const ProjectSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  mode: ProjectModeSchema.default('dubbing'),
  target_langs: z.array(TargetLangSchema).min(1).default(['my-MM']),
  created_at: z.string(),
  updated_at: z.string(),
  last_saved_at: z.string().optional(),
  no_dialogue: z.boolean().default(false),
  recap_mute_original: z.boolean().default(true),
  background_audio_mode: BackgroundAudioModeSchema.optional(),
  useManualAiBridge: z.boolean().default(false),
  video: VideoMetaSchema,
  upload: UploadStateSchema,
  stages: z.object({
    ingest: StageStateSchema,
    maps: StageStateSchema,
    speech: StageStateSchema,
    speakers: StageStateSchema,
    dub: StageStateSchema.default({ status: 'pending', progress_pct: 0 }),
  }),
  stage_hashes: z
    .object({
      s0: z.string().optional(),
      s1: z.string().optional(),
      s2: z.string().optional(),
      s3: z.string().optional(),
      dub: z.string().optional(),
    })
    .default({}),
  speech: z.array(SpeechSegmentSchema).default([]),
  speakers: z.record(z.string(), SpeakerInfoSchema).default({}),
  silence_ms: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])).default([]),
  scene_cuts_ms: z.array(z.number().int().nonnegative()).default([]),
  dub_selection: DubSelectionSchema.default({
    mode: 'first_n',
    count: 8,
    start_idx: 1,
    end_idx: 8,
  }),
  dub_glossary: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  calibrated_sps: z.record(z.string(), z.number().positive()).default({}),
  dub: z.array(DubSegmentSchema).default([]),
  dub_reports: z.array(DubValidationReportSchema).default([]),
  dub_combined_mp4: z.string().optional(),
  chunks: z.array(VideoChunkSchema).default([]),
  chunk_progress: ChunkProgressSchema.optional(),
  recap_source_mode: RecapSourceModeSchema.optional(),
  recap_narrator_voice: z.string().optional(),
  recap_script_status: RecapScriptStatusSchema.default('idle'),
  recap: z.array(RecapBeatSchema).default([]),
  export_visual_config: ExportVisualConfigSchema.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export interface EdgeVoiceInfo {
  name: string;
  friendlyName: string;
  gender: 'female' | 'male';
  locale: string;
  localeName?: string;
}

export interface GeminiVoiceInfo {
  name: string;
  gender: 'female' | 'male';
  style: string;
}

export interface VoicesCatalogResponse {
  edge: {
    voices: EdgeVoiceInfo[];
    error: string | null;
  };
  gemini: {
    voices: GeminiVoiceInfo[];
  };
}

export type KeyPoolState = 'ok' | 'cooldown' | 'exhausted' | 'invalid';

export interface KeyModelUsage {
  model: string;
  requests_today: number;
  last_429?: string;
  cooldown_until?: string;
  exhausted_until?: string;
  state: 'ok' | 'cooldown' | 'exhausted';
}

export interface ApiKeySummary {
  id: string;
  index: number;
  source: string;
  masked: string;
  state: KeyPoolState;
  invalid: boolean;
  invalid_reason?: string;
  models: Record<string, KeyModelUsage>;
  total_requests_today: number;
}

export type ResilientJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'waiting';

export interface ResilientJob {
  id: string;
  project_id: string;
  kind: string;
  label: string;
  hash: string;
  status: ResilientJobStatus;
  model?: string;
  key_id?: string;
  waiting_reason?: 'network' | 'quota' | 'paused';
  waiting_message?: string;
  next_retry_at?: string;
  reset_at?: string;
  attempts: number;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface ResilientQueueStatus {
  paused: boolean;
  keys: ApiKeySummary[];
  hasAnyKey: boolean;
  allKeysInvalid: boolean;
  nextResetAtPt: string;
  ptDate: string;
  textFallbackModels: string[];
  ttsFallbackModels: string[];
  jobsSummary: {
    total: number;
    done: number;
    running: number;
    waiting: number;
    pending: number;
    failed: number;
    currentJob: ResilientJob | null;
    waitingReason: 'network' | 'quota' | 'paused' | null;
    waitingMessage: string | null;
    nextRetryAt: string | null;
    etaSec: number | null;
  };
  jobs: ResilientJob[];
  updatedAt: string;
}

export interface CapabilitiesResponse {
  stageScope: 'stage1' | 'stage2' | 'stage3';
  ffmpeg: {
    ok: boolean;
    ffmpegPath: string | null;
    ffprobePath: string | null;
    ffmpegVersion: string | null;
    ffprobeVersion: string | null;
    source: 'system' | 'static' | 'missing';
    error: string | null;
  };
  demucs: {
    available: boolean;
  };
  gemini: {
    configured: boolean;
    keyValid: boolean;
    keyError: string | null;
    startupChecked: boolean;
    keyCount?: number;
    availableModelCount: number;
    availableModels: string[];
    resolutionNotes: string[];
  };
  requestCounts: {
    geminiText: number;
    geminiTranscribe: number;
    geminiTts: number;
    edgeTts: number;
  };
  config: {
    TEXT_MODEL: string;
    TRANSCRIBE_MODEL: string;
    TTS_MODEL: string;
    TEXT_FALLBACK_MODELS: string[];
    TTS_FALLBACK_MODELS: string[];
    TTS_ENGINE: TtsEngineType;
    TTS_PROVIDER?: TtsProvider;
    SPEECH_STYLE: SpeechStyle;
    TTS_VOLUME_PCT: number;
    demucsRemoteUrl?: string;
    groqApiKey?: string;
    VOICE_POOLS: VoicePoolsConfig;
    GAP_MS: number;
    RECAP_RATIO: number;
    CHUNK_SIZE_BYTES: number;
    MAX_SPEECH_WINDOW_SEC: number;
    SILENCE_NOISE_DB: number;
    SILENCE_MIN_SEC: number;
    SCENE_THRESHOLD: number;
    GEMINI_TTS_MIN_SPACING_MS: number;
    SYLLABLES_PER_SEC: {
      'my-MM': number;
      'en-US': number;
    };
    RATE_LIMITS: {
      geminiText: { concurrency: number; intervalCap: number; interval: number };
      geminiTranscribe: { concurrency: number; intervalCap: number; interval: number };
      geminiTts: { concurrency: number; intervalCap: number; interval: number };
      edgeTts: { concurrency: number; intervalCap: number; interval: number };
    };
  };
  disk: {
    dataDir: string;
    freeBytes: number;
    totalBytes: number;
  };
}

export interface ProjectEventPayload {
  type: 'stage' | 'upload' | 'log' | 'project' | 'heartbeat' | 'error' | 'resilient' | 'chunk';
  stage?: 'ingest' | 'maps' | 'speech' | 'speakers' | 'dub';
  progress_pct?: number;
  eta_sec?: number;
  message?: string;
  project?: Project;
  resilient?: ResilientQueueStatus;
  chunk_progress?: ChunkProgress;
  chunks?: VideoChunk[];
  timestamp: string;
}

// ============================================================================
// No-API-Key Manual AI Chat Bridge (Shared Batching, Parsing & Validation)
// ============================================================================

export const MANUAL_AI_SINGLE_BATCH_MAX = 220;
export const MANUAL_AI_BATCH_SIZE = 200;
export const MANUAL_AI_BATCH_REMINDER =
  'Keep all parts in the SAME AI chat conversation to preserve character names & glossary.';

export type ManualAiBridgeMode = 'dubbing' | 'recap';

export interface ManualAiSourceCue {
  id: number;
  speaker: string;
  text: string;
  start_ms?: number;
  end_ms?: number;
  slot_ms?: number;
  max_syllables?: number;
}

export interface ManualAiOutputItem {
  id: number;
  text: string;
}

export interface ManualAiBatch {
  partIndex: number;
  totalParts: number;
  startId: number;
  endId: number;
  cueCount: number;
  promptText: string;
  sourceCues: Array<{ id: number; speaker: string; text: string }>;
  expectedIds: number[];
}

export interface ManualAiPromptsResponse {
  projectId: string;
  mode: ManualAiBridgeMode;
  sourceMode?: RecapSourceMode;
  targetLang: TargetLang;
  totalCues: number;
  totalAvailableCues: number;
  threshold: number;
  batchSize: number;
  reminder: string;
  batches: ManualAiBatch[];
}

export interface ManualAiJsonValidationResult {
  ok: boolean;
  cleanedJson: string;
  items: ManualAiOutputItem[];
  matchedCount: number;
  missingIds: number[];
  extraIds: number[];
  emptyIds: number[];
  error?: string;
}

/**
 * Automatic smart batching for short clips, recap, and long movie dubbing (up to 240 mins):
 * - <= 220 cues: 1 single batch (Part 1 / 1)
 * - > 220 cues: split into batches of 200 cues (Part 1 / N: IDs 1-200, Part 2 / N: IDs 201-400, ...)
 */
export function splitManualAiCuesIntoBatches<T>(cues: readonly T[]): T[][] {
  if (cues.length === 0) return [];
  if (cues.length <= MANUAL_AI_SINGLE_BATCH_MAX) {
    return [cues.slice()];
  }
  const out: T[][] = [];
  for (let i = 0; i < cues.length; i += MANUAL_AI_BATCH_SIZE) {
    out.push(cues.slice(i, i + MANUAL_AI_BATCH_SIZE));
  }
  return out;
}

/**
 * Strips markdown code fences (```json ... ``` or ``` ... ```) and trims
 * surrounding conversational text outside the JSON array/object if present.
 */
export function stripMarkdownJsonFences(raw: string): string {
  let text = raw.trim();
  if (!text) return '';

  const fenceMatch = /```(?:json|javascript|ts)?\s*([\s\S]*?)\s*```/i.exec(text);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  } else {
    text = text
      .replace(/^```(?:json|javascript|ts)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }

  if (text.startsWith('[') || text.startsWith('{')) {
    return text;
  }

  const firstArr = text.indexOf('[');
  const lastArr = text.lastIndexOf(']');
  const firstObj = text.indexOf('{');
  const lastObj = text.lastIndexOf('}');

  if (firstArr !== -1 && lastArr > firstArr && (firstObj === -1 || firstArr < firstObj)) {
    return text.slice(firstArr, lastArr + 1).trim();
  }
  if (firstObj !== -1 && lastObj > firstObj) {
    return text.slice(firstObj, lastObj + 1).trim();
  }
  return text;
}

/**
 * Parses a pasted AI JSON reply (auto-stripping markdown code fences) and
 * validates that all expected cue IDs exist with non-empty text.
 */
export function parseManualAiJsonReply(
  rawText: string,
  expectedIds: readonly number[],
): ManualAiJsonValidationResult {
  const cleanedJson = stripMarkdownJsonFences(rawText);
  if (!cleanedJson) {
    return {
      ok: false,
      cleanedJson: '',
      items: [],
      matchedCount: 0,
      missingIds: [...expectedIds],
      extraIds: [],
      emptyIds: [],
      error: 'Paste the JSON reply from Gemini Web or ChatGPT first.',
    };
  }

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(cleanedJson);
  } catch (err) {
    return {
      ok: false,
      cleanedJson,
      items: [],
      matchedCount: 0,
      missingIds: [...expectedIds],
      extraIds: [],
      emptyIds: [],
      error: `Invalid JSON: ${err instanceof Error ? err.message : 'Syntax error'}`,
    };
  }

  let rawArray: unknown[] | null = null;
  if (Array.isArray(parsedUnknown)) {
    rawArray = parsedUnknown;
  } else if (parsedUnknown && typeof parsedUnknown === 'object') {
    const rec = parsedUnknown as Record<string, unknown>;
    if (Array.isArray(rec.items)) rawArray = rec.items;
    else if (Array.isArray(rec.cues)) rawArray = rec.cues;
    else if (Array.isArray(rec.translations)) rawArray = rec.translations;
    else if (Array.isArray(rec.beats)) rawArray = rec.beats;
  }

  if (!rawArray) {
    return {
      ok: false,
      cleanedJson,
      items: [],
      matchedCount: 0,
      missingIds: [...expectedIds],
      extraIds: [],
      emptyIds: [],
      error: 'Expected a JSON array like [{"id": 1, "text": "..."}].',
    };
  }

  const byId = new Map<number, string>();
  const extraIds: number[] = [];
  const expectedSet = new Set(expectedIds);

  for (const entry of rawArray) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const rawId = typeof obj.id === 'string' ? Number(obj.id) : obj.id;
    if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
      continue;
    }
    const candidateText =
      typeof obj.text === 'string'
        ? obj.text
        : typeof obj.translation === 'string'
          ? obj.translation
          : typeof obj.narration === 'string'
            ? obj.narration
            : typeof obj.narration_text === 'string'
              ? obj.narration_text
              : typeof obj.tgt_text === 'string'
                ? obj.tgt_text
                : '';
    const trimmed = candidateText.trim();
    byId.set(rawId, trimmed);
    if (expectedIds.length > 0 && !expectedSet.has(rawId)) {
      extraIds.push(rawId);
    }
  }

  const missingIds: number[] = [];
  const emptyIds: number[] = [];
  const orderedItems: ManualAiOutputItem[] = [];

  if (expectedIds.length > 0) {
    for (const id of expectedIds) {
      if (!byId.has(id)) {
        missingIds.push(id);
      } else {
        const txt = byId.get(id) ?? '';
        if (!txt) {
          emptyIds.push(id);
        } else {
          orderedItems.push({ id, text: txt });
        }
      }
    }
  } else {
    for (const [id, txt] of byId.entries()) {
      if (!txt) emptyIds.push(id);
      else orderedItems.push({ id, text: txt });
    }
  }

  const matchedCount = orderedItems.length;
  const ok =
    orderedItems.length > 0 &&
    missingIds.length === 0 &&
    emptyIds.length === 0 &&
    (expectedIds.length === 0 || matchedCount === expectedIds.length);

  let error: string | undefined;
  if (!ok) {
    if (missingIds.length > 0) {
      const sample = missingIds.slice(0, 8).join(', ');
      error = `Missing ${missingIds.length} cue ID(s): ${sample}${missingIds.length > 8 ? '...' : ''}`;
    } else if (emptyIds.length > 0) {
      const sample = emptyIds.slice(0, 8).join(', ');
      error = `Empty text for cue ID(s): ${sample}${emptyIds.length > 8 ? '...' : ''}`;
    } else {
      error = 'No valid {"id", "text"} entries matched this batch.';
    }
  }

  return {
    ok,
    cleanedJson,
    items: orderedItems,
    matchedCount,
    missingIds,
    extraIds,
    emptyIds,
    error,
  };
}

