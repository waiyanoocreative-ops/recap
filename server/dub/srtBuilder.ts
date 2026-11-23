import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  DubSegment,
  DubValidationReport,
  ExportVisualConfig,
  Project,
  TargetLang,
} from '../../shared/projectTypes.ts';
import {
  borderPresetColor,
  borderThicknessPxForHeight,
  filterPresetToFfmpegChain,
  subtitleFontPxForHeight,
  subtitleMarginVForHeight,
  subtitleOutlineWidthForHeight,
  subtitleShadowDepthForHeight,
  type ExportBorderPreset,
} from '../../shared/projectTypes.ts';
import {
  formatSrtTimestamp,
  splitSrtDocument,
  splitSubtitleCue,
  splitSubtitleCues,
  type SplitSubtitleOptions,
  type SubtitleCue,
} from '../../shared/subtitleSplit.ts';
import { emitProjectEvent } from '../events/sseBus.ts';
import { requireFfmpeg, spawnCommand } from '../media/binaries.ts';
import { fileExists } from '../media/ingest.ts';
import { getProject, getProjectPaths, updateProject } from '../storage/projectStore.ts';
import {
  probeMediaDurationsMs,
  probeVideoFps,
  spawnFfmpegVideoEncodeWithHwFallback,
} from './audioDsp.ts';
import { saveExportLogoPng } from './dubPipeline.ts';

export { splitSrtDocument, splitSubtitleCue, splitSubtitleCues };
export type { SplitSubtitleOptions, SubtitleCue };

export function resolveSingleTargetLang(
  targetLangs: readonly TargetLang[] | undefined | null,
): TargetLang {
  if (!targetLangs || targetLangs.length === 0) return 'my-MM';
  if (targetLangs.includes('my-MM')) return 'my-MM';
  return targetLangs[0] === 'en-US' ? 'en-US' : 'my-MM';
}

export function resolveSubtitleModeForLang(
  lang: TargetLang,
  requestedMode?: ExportVisualConfig['subtitle']['mode'],
): ExportVisualConfig['subtitle']['mode'] {
  if (requestedMode === 'none') return 'none';
  return lang === 'my-MM' ? 'mm' : 'en';
}

export async function writeSplitSynchronizedSrtFile(params: {
  outSrtPath: string;
  dubSegments: DubSegment[];
  rangeStartMs: number;
  lang?: TargetLang;
}): Promise<string> {
  const { outSrtPath, dubSegments, rangeStartMs, lang } = params;
  await fs.mkdir(path.dirname(outSrtPath), { recursive: true });

  const splitCues: SubtitleCue[] = [];
  for (const s of dubSegments) {
    const text = s.tgt_text.trim();
    if (!text) continue;
    const startRel = Math.max(0, (s.effective_start_ms ?? s.start_ms) - rangeStartMs);
    const endRel = Math.max(
      startRel + 200,
      Math.max(s.effective_end_ms ?? s.end_ms, (s.effective_start_ms ?? s.start_ms) + s.tts_ms) -
        rangeStartMs,
    );
    splitCues.push(
      ...splitSubtitleCue(
        { startMs: startRel, endMs: endRel, text },
        { lang: lang ?? s.lang },
      ),
    );
  }

  const srtContent = splitCues
    .map(
      (cue, idx) =>
        `${idx + 1}\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\n${cue.text}\n`,
    )
    .join('\n');

  await fs.writeFile(outSrtPath, srtContent, 'utf-8');
  return outSrtPath;
}

export async function rewriteSplitSrtFile(
  srtPath: string,
  lang?: 'my-MM' | 'en-US' | 'auto',
): Promise<boolean> {
  if (!(await fileExists(srtPath))) return false;
  const raw = await fs.readFile(srtPath, 'utf-8');
  if (!raw.trim()) return true;
  const next = splitSrtDocument(raw, { lang });
  if (next !== raw) {
    const tmpPath = `${srtPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmpPath, next, 'utf-8');
    await fs.rename(tmpPath, srtPath);
  }
  return true;
}

function hexToAssBgr(hex: string, fallback = 'FFFFFF'): string {
  const clean = (hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return fallback;
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `${b}${g}${r}`.toUpperCase();
}

function opacityToAssAlpha(opacity: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 0.72));
  const alphaByte = Math.round((1 - clamped) * 255);
  return alphaByte.toString(16).padStart(2, '0').toUpperCase();
}

/** Map the UI font-family list to an ASS-safe font name libass can resolve on disk. */
function resolveAssFontName(fontFamily: string): string {
  const first = (fontFamily || '')
    .split(',')[0]
    ?.replace(/['"]/g, '')
    .trim();
  switch (first) {
    case 'Padauk':
      return 'Padauk';
    case 'Pyidaungsu':
      return 'Pyidaungsu';
    case 'Inter':
      return 'Inter';
    case 'Myanmar Sangam MN':
      return 'Myanmar Sangam MN';
    case 'Noto Sans Myanmar':
      return 'Noto Sans Myanmar';
    case 'sans-serif':
    case 'Sans':
      return 'sans-serif';
    default:
      return first || 'Noto Sans Myanmar';
  }
}

function formatAssTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3600000);
  const mins = Math.floor((clamped % 3600000) / 60000);
  const secs = Math.floor((clamped % 60000) / 1000);
  const cs = Math.floor((clamped % 1000) / 10);
  return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function escapeFfmpegFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/** FFmpeg drawbox color from a #RRGGBB hex string (0xRRGGBB[@alpha] form). */
function hexToDrawboxColor(hex: string): string {
  const clean = (hex || '').replace('#', '').trim();
  return /^[0-9a-fA-F]{6}$/.test(clean) ? `0x${clean}` : '0xFFFFFF';
}

async function probeVideoDimensions(filePath: string): Promise<{ width: number; height: number }> {
  const { ffprobe } = requireFfmpeg();
  const res = await spawnCommand(ffprobe, [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    '-select_streams',
    'v:0',
    filePath,
  ]);
  if (res.code !== 0) {
    return { width: 1280, height: 720 };
  }
  try {
    const parsed = JSON.parse(res.stdout) as {
      streams?: Array<{ width?: number; height?: number }>;
    };
    const stream = parsed.streams?.[0];
    const width = Number(stream?.width || 1280);
    const height = Number(stream?.height || 720);
    return {
      width: width > 0 ? width : 1280,
      height: height > 0 ? height : 720,
    };
  } catch {
    return { width: 1280, height: 720 };
  }
}

function toEvenDim(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function resolveTargetExportDimensions(
  aspectRatio: ExportVisualConfig['aspectRatio'],
  srcWidth: number,
  srcHeight: number,
): { width: number; height: number } {
  const safeW = Math.max(2, srcWidth);
  const safeH = Math.max(2, srcHeight);
  const srcAspect = safeW / safeH;
  const dstAspect =
    aspectRatio === '9:16'
      ? 9 / 16
      : aspectRatio === '1:1'
        ? 1
        : aspectRatio === '4:5'
          ? 4 / 5
          : 16 / 9;

  if (Math.abs(srcAspect - dstAspect) < 0.02) {
    return { width: toEvenDim(safeW), height: toEvenDim(safeH) };
  }

  const shortSide = Math.min(1080, Math.min(safeW, safeH));
  switch (aspectRatio) {
    case '9:16': {
      const w = toEvenDim(shortSide);
      return { width: w, height: toEvenDim((w * 16) / 9) };
    }
    case '1:1': {
      const s = toEvenDim(shortSide);
      return { width: s, height: s };
    }
    case '4:5': {
      const w = toEvenDim(shortSide);
      return { width: w, height: toEvenDim((w * 5) / 4) };
    }
    case '16:9':
    default: {
      const h = toEvenDim(shortSide);
      return { width: toEvenDim((h * 16) / 9), height: h };
    }
  }
}

export function buildSplitSubtitleCuesForExport(
  project: Project,
  subMode: 'mm' | 'en',
  rangeStartMs: number,
): SubtitleCue[] {
  const wantLang: TargetLang = subMode === 'mm' ? 'my-MM' : 'en-US';
  let rawCues: SubtitleCue[] = [];

  const dubForWanted = project.dub
    .filter((d) => d.lang === wantLang && d.tgt_text.trim().length > 0)
    .sort((a, b) => a.start_ms - b.start_ms);

  if (dubForWanted.length > 0) {
    rawCues = dubForWanted.map((s) => {
      const startRel = Math.max(0, (s.effective_start_ms ?? s.start_ms) - rangeStartMs);
      const endAbs = Math.max(
        s.effective_end_ms ?? s.end_ms,
        (s.effective_start_ms ?? s.start_ms) + (s.tts_ms || 0),
      );
      const endRel = Math.max(startRel + 250, endAbs - rangeStartMs);
      return { startMs: startRel, endMs: endRel, text: s.tgt_text.trim() };
    });
  } else {
    const recapForWanted = project.recap
      .filter((b) => b.lang === wantLang && b.narration_text.trim().length > 0)
      .sort((a, b) => a.start_ms - b.start_ms);

    if (recapForWanted.length > 0) {
      rawCues = recapForWanted.map((b) => {
        const startRel = Math.max(0, (b.effective_start_ms ?? b.start_ms) - rangeStartMs);
        const endAbs = Math.max(
          b.effective_end_ms ?? b.end_ms,
          (b.effective_start_ms ?? b.start_ms) + (b.tts_ms || 0),
        );
        const endRel = Math.max(startRel + 250, endAbs - rangeStartMs);
        return { startMs: startRel, endMs: endRel, text: b.narration_text.trim() };
      });
    } else if (subMode === 'en') {
      const dubFallback = project.dub
        .filter((d) => d.src_text.trim().length > 0)
        .sort((a, b) => a.start_ms - b.start_ms);
      if (dubFallback.length > 0) {
        rawCues = dubFallback.map((s) => {
          const startRel = Math.max(0, (s.effective_start_ms ?? s.start_ms) - rangeStartMs);
          const endAbs = Math.max(
            s.effective_end_ms ?? s.end_ms,
            (s.effective_start_ms ?? s.start_ms) + (s.tts_ms || 0),
          );
          const endRel = Math.max(startRel + 250, endAbs - rangeStartMs);
          return { startMs: startRel, endMs: endRel, text: s.src_text.trim() };
        });
      } else {
        rawCues = project.speech
          .filter((s) => s.text.trim().length > 0)
          .map((s) => {
            const startRel = Math.max(0, s.start_ms - rangeStartMs);
            const endRel = Math.max(startRel + 250, s.end_ms - rangeStartMs);
            return { startMs: startRel, endMs: endRel, text: s.text.trim() };
          });
      }
    }
  }

  return splitSubtitleCues(rawCues, { lang: wantLang });
}

export function buildSplitAssSubtitleDocument(params: {
  width: number;
  height: number;
  subtitle: ExportVisualConfig['subtitle'];
  cues: SubtitleCue[];
}): string {
  const { width, height, subtitle, cues } = params;
  const primaryFont = resolveAssFontName(subtitle.fontFamily);

  // WYSIWYG: PlayResX/Y equal the real export dimensions, so Fontsize (height * fontSizePct/100)
  // renders at the same relative size the Live Preview shows (stageHeight * fontSizePct/100).
  const scaledFontSize = Math.round(subtitleFontPxForHeight(subtitle, height));
  const textBgr = hexToAssBgr(subtitle.textColor, 'FFFFFF');
  const outlineBgr = hexToAssBgr(subtitle.outlineColor, '000000');
  const bgBgr = hexToAssBgr(subtitle.bgColor, outlineBgr);
  const bgAlpha = opacityToAssAlpha(subtitle.bgOpacity);
  // Outline/shadow scale proportionally with video height so relative thickness matches Preview.
  const scaledOutline = subtitleOutlineWidthForHeight(subtitle, height);
  const scaledShadow = subtitleShadowDepthForHeight(subtitle, height);

  let borderStyle = 1;
  let outlineWidth = scaledOutline;
  let shadowDepth = scaledShadow;
  let assOutlineColour = `&H00${outlineBgr}`;
  let assBackColour = `&H${bgAlpha}${bgBgr}`;
  let inlineOverride = '';

  if (subtitle.stylePreset === 'boxed') {
    // BorderStyle 3 draws an opaque box sized by Outline; keep the text outline visible too.
    borderStyle = 3;
    outlineWidth = Math.max(11, scaledOutline * 4);
    shadowDepth = 0;
    assOutlineColour = `&H${bgAlpha}${bgBgr}`;
    assBackColour = `&H${bgAlpha}${bgBgr}`;
  } else if (subtitle.stylePreset === 'neon') {
    borderStyle = 1;
    outlineWidth = Math.max(3.5, scaledOutline * 1.25);
    shadowDepth = 0;
    assOutlineColour = `&H00${outlineBgr}`;
    assBackColour = `&H00${outlineBgr}`;
    inlineOverride = '\\blur3';
  } else if (subtitle.stylePreset === 'minimal') {
    borderStyle = 1;
    outlineWidth = Math.max(1.2, scaledOutline * 0.5);
    shadowDepth = Math.max(1, scaledShadow);
    assOutlineColour = `&H66${outlineBgr}`;
    assBackColour = `&H${bgAlpha}${bgBgr}`;
  }

  const clampedYPct = Math.max(5, Math.min(95, subtitle.yPercent));
  const marginV = subtitleMarginVForHeight(subtitle, height);
  const posX = Math.round(width / 2);
  const posY = Math.round((height * clampedYPct) / 100);
  const langHint = subtitle.mode === 'mm' ? 'my-MM' : 'en-US';
  const normalizedCues = splitSubtitleCues(cues, { lang: langHint });

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${primaryFont},${scaledFontSize},&H00${textBgr},&H00${textBgr},${assOutlineColour},${assBackColour},1,0,0,0,100,100,0,0,${borderStyle},${outlineWidth.toFixed(1)},${shadowDepth.toFixed(1)},2,48,48,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = normalizedCues.map((cue) => {
    const start = formatAssTimestamp(cue.startMs);
    const end = formatAssTimestamp(cue.endMs);
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\an5\\pos(${posX},${posY})${inlineOverride}}${escapeAssText(cue.text)}`;
  });

  return [...header, ...events, ''].join('\n');
}

export async function exportProjectWithVisualConfig(params: {
  projectId: string;
  lang?: TargetLang;
  visualConfig: ExportVisualConfig;
}): Promise<Project> {
  const { projectId, visualConfig } = params;
  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project "${projectId}" not found.`);
  }

  const paths = getProjectPaths(projectId);
  await fs.mkdir(paths.dubDir, { recursive: true });
  await fs.mkdir(paths.outDir, { recursive: true });

  const preferredLang = resolveSingleTargetLang(
    params.lang
      ? [params.lang]
      : project.dub_reports[0]?.lang
        ? [project.dub_reports[0].lang]
        : project.target_langs,
  );
  const normalizedSubtitleMode = resolveSubtitleModeForLang(
    preferredLang,
    visualConfig.subtitle.mode,
  );
  const effectiveSubtitleConfig: ExportVisualConfig['subtitle'] = {
    ...visualConfig.subtitle,
    mode: normalizedSubtitleMode,
  };
  const effectiveVisualConfig: ExportVisualConfig = {
    ...visualConfig,
    subtitle: effectiveSubtitleConfig,
  };

  const outMp4Path = path.join(paths.outDir, `dub_${preferredLang}.mp4`);
  const cleanBaseMp4Path = path.join(paths.dubDir, `base_${preferredLang}.mp4`);

  if (!(await fileExists(cleanBaseMp4Path))) {
    if (!(await fileExists(outMp4Path))) {
      throw new Error(`Rendered output for ${preferredLang} not found. Render the video first.`);
    }
    await fs.copyFile(outMp4Path, cleanBaseMp4Path);
  }

  const prevStage = project.stages.dub;
  const emitProgress = async (pct: number, message: string) => {
    const updated = await updateProject(projectId, (cur) => ({
      ...cur,
      stages: {
        ...cur.stages,
        dub: {
          ...cur.stages.dub,
          status: 'running',
          progress_pct: pct,
          message,
          error: undefined,
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: 'stage',
      stage: 'dub',
      progress_pct: pct,
      message,
      project: updated,
    });
  };

  await emitProgress(15, `Preparing FFmpeg visual export (${visualConfig.aspectRatio}, ${visualConfig.fitMode})...`);

  try {
    const srcDims = await probeVideoDimensions(cleanBaseMp4Path);
    const srcFps = await probeVideoFps(cleanBaseMp4Path);
    const { width: targetW, height: targetH } = resolveTargetExportDimensions(
      effectiveVisualConfig.aspectRatio,
      srcDims.width,
      srcDims.height,
    );

    const existingReport = project.dub_reports.find((r) => r.lang === preferredLang);
    const rangeStartMs = existingReport?.range_start_ms ?? 0;

    let logoPngPath: string | null = null;
    let savedLogoFilePath = effectiveVisualConfig.logo.filePath;
    if (effectiveVisualConfig.logo.enabled) {
      if (effectiveVisualConfig.logo.dataUrl) {
        savedLogoFilePath = await saveExportLogoPng({
          projectId,
          dataUrl: effectiveVisualConfig.logo.dataUrl,
        });
        logoPngPath = path.join(paths.root, savedLogoFilePath);
      } else if (effectiveVisualConfig.logo.filePath) {
        const candidate = path.resolve(paths.root, effectiveVisualConfig.logo.filePath);
        if (candidate.startsWith(paths.root) && (await fileExists(candidate))) {
          logoPngPath = candidate;
        }
      }
    }

    let assPath: string | null = null;
    if (effectiveSubtitleConfig.mode !== 'none') {
      const cues = buildSplitSubtitleCuesForExport(project, effectiveSubtitleConfig.mode, rangeStartMs);
      if (cues.length > 0) {
        const assContent = buildSplitAssSubtitleDocument({
          width: targetW,
          height: targetH,
          subtitle: effectiveSubtitleConfig,
          cues,
        });
        assPath = path.join(paths.dubDir, `export_subs_${preferredLang}.ass`);
        await fs.writeFile(assPath, assContent, 'utf-8');
      }
    }

    const srcAspect = srcDims.width / Math.max(1, srcDims.height);
    const dstAspect = targetW / Math.max(1, targetH);
    const isIdentityVisual =
      Math.abs(srcAspect - dstAspect) < 0.02 &&
      !effectiveVisualConfig.flipHorizontal &&
      !effectiveVisualConfig.flipVertical &&
      !effectiveVisualConfig.blurBox.enabled &&
      effectiveVisualConfig.filterPreset === 'none' &&
      effectiveVisualConfig.border.preset === 'none' &&
      !assPath &&
      !logoPngPath;

    const tmpOutMp4 = path.join(paths.dubDir, `export_${preferredLang}.${process.pid}.${Date.now()}.mp4`);
    const { ffmpeg } = requireFfmpeg();

    if (isIdentityVisual) {
      await emitProgress(75, 'Restoring stream-copied video with compact AAC 128k audio...');
      const remuxRes = await spawnCommand(ffmpeg, [
        '-y',
        '-i',
        cleanBaseMp4Path,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-ar',
        '44100',
        '-movflags',
        '+faststart',
        tmpOutMp4,
      ]);
      if (remuxRes.code !== 0) {
        await fs.unlink(tmpOutMp4).catch(() => {});
        throw new Error(`FFmpeg identity remux failed: ${remuxRes.stderr.slice(-4000)}`);
      }
      await fs.rename(tmpOutMp4, outMp4Path);
    } else {
      await emitProgress(
        45,
        `Encoding ${targetW}x${targetH} visual export (${effectiveVisualConfig.fitMode}${assPath ? ` + subs:${effectiveSubtitleConfig.mode}` : ''}${logoPngPath ? ' + logo' : ''})...`,
      );

      const flipOps: string[] = [];
      if (effectiveVisualConfig.flipHorizontal) flipOps.push('hflip');
      if (effectiveVisualConfig.flipVertical) flipOps.push('vflip');
      const flipPrefix = flipOps.length > 0 ? `${flipOps.join(',')},` : '';

      const filterStages: string[] = [];
      let currentLabel = 'vmain';

      if (effectiveVisualConfig.fitMode === 'blur') {
        filterStages.push(`[0:v]${flipPrefix}fps=${srcFps},split=2[vbg_src][vfg_src]`);
        filterStages.push(
          `[vbg_src]scale=270:-2,boxblur=10:2,scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},setsar=1[vbg]`,
        );
        filterStages.push(
          `[vfg_src]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,setsar=1[vfg]`,
        );
        filterStages.push(`[vbg][vfg]overlay=(W-w)/2:(H-h)/2[vmain]`);
      } else {
        filterStages.push(
          `[0:v]${flipPrefix}fps=${srcFps},scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},setsar=1[vmain]`,
        );
      }

      // CapCut-style clarity preset: edge sharpening + micro-contrast + color tone (no upscale).
      const filterChain = filterPresetToFfmpegChain(effectiveVisualConfig.filterPreset);
      if (filterChain) {
        const nextLabel = 'vfiltered';
        filterStages.push(`[${currentLabel}]${filterChain},setsar=1[${nextLabel}]`);
        currentLabel = nextLabel;
      }

      // Blur box over hardcoded original subtitles — exact normalized rect from the editor.
      if (effectiveVisualConfig.blurBox.enabled) {
        const bb = effectiveVisualConfig.blurBox;
        const bx = Math.max(0, Math.min(targetW - 4, Math.round(bb.x * targetW)));
        const by = Math.max(0, Math.min(targetH - 4, Math.round(bb.y * targetH)));
        const bw = Math.max(4, Math.min(targetW - bx, Math.round(bb.w * targetW)));
        const bh = Math.max(4, Math.min(targetH - by, Math.round(bb.h * targetH)));
        const strength = Math.max(1, Math.min(40, Math.round(bb.strength)));
        const nextLabel = 'vblurbox';
        filterStages.push(
          `[${currentLabel}]split=2[bbbase][bbcrop];` +
            `[bbcrop]crop=${bw}:${bh}:${bx}:${by},boxblur=${strength}:2[bbblurred];` +
            `[bbbase][bbblurred]overlay=${bx}:${by}[${nextLabel}]`,
        );
        currentLabel = nextLabel;
      }

      // Decorative frame border (drawbox stack; rainbow = 4 colored sides).
      if (effectiveVisualConfig.border.preset !== 'none') {
        const bPx = borderThicknessPxForHeight(effectiveVisualConfig.border, targetH);
        if (effectiveVisualConfig.border.preset === 'rainbow') {
          // Top, right, bottom, left sides in 4 distinct colors.
          const rainbowColors = ['#FF3B30', '#FFD700', '#00E5FF', '#FF69B4'];
          rainbowColors.forEach((hex, idx) => {
            const inLabel = idx === 0 ? currentLabel : `vborder${idx - 1}`;
            const outLabel = idx === rainbowColors.length - 1 ? 'vbordered' : `vborder${idx}`;
            const boxArgs =
              idx === 0
                ? `drawbox=x=0:y=0:w=iw:h=${bPx}:color=${hexToDrawboxColor(hex)}:t=fill`
                : idx === 1
                  ? `drawbox=x=iw-${bPx}:y=0:w=${bPx}:h=ih:color=${hexToDrawboxColor(hex)}:t=fill`
                  : idx === 2
                    ? `drawbox=x=0:y=ih-${bPx}:w=iw:h=${bPx}:color=${hexToDrawboxColor(hex)}:t=fill`
                    : `drawbox=x=0:y=0:w=${bPx}:h=ih:color=${hexToDrawboxColor(hex)}:t=fill`;
            filterStages.push(`[${inLabel}]${boxArgs}[${outLabel}]`);
          });
          currentLabel = 'vbordered';
        } else {
          const hex = borderPresetColor(effectiveVisualConfig.border.preset as ExportBorderPreset);
          if (hex) {
            const drawColor = hexToDrawboxColor(hex);
            filterStages.push(
              `[${currentLabel}]drawbox=x=0:y=0:w=iw:h=${bPx}:color=${drawColor}:t=fill,` +
                `drawbox=x=iw-${bPx}:y=0:w=${bPx}:h=ih:color=${drawColor}:t=fill,` +
                `drawbox=x=0:y=ih-${bPx}:w=iw:h=${bPx}:color=${drawColor}:t=fill,` +
                `drawbox=x=0:y=0:w=${bPx}:h=ih:color=${drawColor}:t=fill[vbordered]`,
            );
            currentLabel = 'vbordered';
          }
        }
      }

      if (assPath) {
        const nextLabel = 'vsub';
        filterStages.push(`[${currentLabel}]ass='${escapeFfmpegFilterPath(assPath)}'[${nextLabel}]`);
        currentLabel = nextLabel;
      }

      if (logoPngPath) {
        const rawLogoW = Math.max(16, Math.round((targetW * effectiveVisualConfig.logo.scalePercent) / 100));
        const logoW = rawLogoW + (rawLogoW % 2);
        const logoX = Math.round((targetW * effectiveVisualConfig.logo.xPercent) / 100);
        const logoY = Math.round((targetH * effectiveVisualConfig.logo.yPercent) / 100);
        filterStages.push(`[1:v]scale=${logoW}:-2,format=rgba[vlogo]`);
        filterStages.push(
          `[${currentLabel}][vlogo]overlay=x=max(0\\,min(W-w\\,${logoX})):y=max(0\\,min(H-h\\,${logoY})):format=auto[vout]`,
        );
        currentLabel = 'vout';
      } else {
        const lastIdx = filterStages.length - 1;
        filterStages[lastIdx] = filterStages[lastIdx].replace(
          new RegExp(`\\[${currentLabel}\\]$`),
          '[vout]',
        );
      }

      const ffRes = await spawnFfmpegVideoEncodeWithHwFallback({
        ffmpeg,
        prefixArgs: [
          '-y',
          '-i',
          cleanBaseMp4Path,
          ...(logoPngPath ? ['-i', logoPngPath] : []),
          '-filter_complex',
          filterStages.join(';'),
          '-map',
          '[vout]',
          '-map',
          '0:a:0?',
        ],
        suffixArgs: [
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ac',
          '2',
          '-ar',
          '44100',
          '-movflags',
          '+faststart',
        ],
        outputPath: tmpOutMp4,
        cpuCrf: '20',
        cpuExtraArgs: ['-threads', '4'],
      });
      if (ffRes.code !== 0) {
        await fs.unlink(tmpOutMp4).catch(() => {});
        throw new Error(`FFmpeg visual export failed: ${ffRes.stderr.slice(-4000)}`);
      }
      await fs.rename(tmpOutMp4, outMp4Path);
    }

    await emitProgress(90, 'Finalizing exported MP4 and updating validation report...');

    const probe = await probeMediaDurationsMs(outMp4Path);
    const vMs = probe.videoMs || probe.formatMs;
    const aMs = probe.audioMs || probe.formatMs;
    const avDiffMs = Math.abs(vMs - aMs);
    const generatedAt = new Date().toISOString();

    const reportPath = path.join(paths.outDir, `report_${preferredLang}.json`);
    let updatedReport: DubValidationReport;
    if (existingReport) {
      updatedReport = {
        ...existingReport,
        video_duration_ms: vMs,
        audio_duration_ms: aMs,
        av_diff_ms: avDiffMs,
        passed_40ms: avDiffMs <= 40,
        mp4_file: `out/dub_${preferredLang}.mp4`,
        generated_at: generatedAt,
      };
    } else {
      updatedReport = {
        lang: preferredLang,
        video_duration_ms: vMs,
        audio_duration_ms: aMs,
        av_diff_ms: avDiffMs,
        passed_40ms: avDiffMs <= 40,
        range_start_ms: 0,
        range_end_ms: vMs,
        is_full_video: true,
        total_segments: project.dub.length,
        ok_count: project.dub.length,
        compressed_count: 0,
        retranslated_count: 0,
        overflow_count: 0,
        needs_review_count: 0,
        flagged_segments: [],
        mp4_file: `out/dub_${preferredLang}.mp4`,
        generated_at: generatedAt,
      };
    }
    const tmpReport = `${reportPath}.tmp`;
    await fs.writeFile(tmpReport, JSON.stringify(updatedReport, null, 2), 'utf-8');
    await fs.rename(tmpReport, reportPath);

    const persistedVisualConfig: ExportVisualConfig = {
      ...effectiveVisualConfig,
      logo: {
        ...effectiveVisualConfig.logo,
        filePath: savedLogoFilePath ?? null,
      },
    };

    const doneMsg = `Visual export ready (${targetW}x${targetH} · ${effectiveVisualConfig.aspectRatio}${assPath ? ` · subs:${effectiveSubtitleConfig.mode}` : ''}${logoPngPath ? ' · logo' : ''}).`;
    const saved = await updateProject(projectId, (cur) => {
      const nextReports = [...(cur.dub_reports ?? [])];
      const idx = nextReports.findIndex((r) => r.lang === preferredLang);
      if (idx >= 0) {
        nextReports[idx] = updatedReport;
      } else {
        nextReports.push(updatedReport);
      }
      return {
        ...cur,
        dub_reports: nextReports,
        dub_combined_mp4: undefined,
        export_visual_config: persistedVisualConfig,
        stages: {
          ...cur.stages,
          dub: {
            ...cur.stages.dub,
            status: 'done',
            progress_pct: 100,
            message: doneMsg,
            error: undefined,
            updated_at: generatedAt,
          },
        },
      };
    });

    emitProjectEvent(projectId, {
      type: 'stage',
      stage: 'dub',
      progress_pct: 100,
      message: doneMsg,
      project: saved,
    });

    return saved;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const failed = await updateProject(projectId, (cur) => ({
      ...cur,
      stages: {
        ...cur.stages,
        dub: {
          ...prevStage,
          status: 'error',
          error: errMsg,
          message: errMsg,
          updated_at: new Date().toISOString(),
        },
      },
    }));
    emitProjectEvent(projectId, {
      type: 'error',
      stage: 'dub',
      message: errMsg,
      project: failed,
    });
    throw err;
  }
}
