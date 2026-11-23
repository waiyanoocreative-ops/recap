import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Eraser,
  FlipHorizontal2,
  FlipVertical2,
  Image as ImageIcon,
  Layers,
  Loader2,
  Maximize2,
  RotateCcw,
  Sparkles,
  Square,
  Subtitles,
  Trash2,
  Type,
  Upload,
  Wand2,
} from 'lucide-react';
import {
  DEFAULT_EXPORT_VISUAL_CONFIG,
  borderPresetColor,
  borderThicknessPxForHeight,
  filterPresetToCssFilter,
  subtitleFontPxForStage,
  subtitleOutlineWidthForStage,
  type ExportAspectRatio,
  type ExportBlurBoxConfig,
  type ExportBorderPreset,
  type ExportFitMode,
  type ExportSubtitleMode,
  type ExportSubtitlePreset,
  type ExportVisualConfig,
  type ExportVisualFilterPreset,
  type Project,
  type TargetLang,
} from '../../../shared/projectTypes';
import { splitSubtitleCue, type SubtitleCue } from '../../../shared/subtitleSplit';
import { apiFetchJson, sanitizeUiErrorText } from '../../utils/apiClient';
import { formatTimecode } from '../../utils/format';

function releaseVideoElement(el: HTMLVideoElement | null | undefined): void {
  if (!el) return;
  try {
    el.pause();
    el.removeAttribute('src');
    el.src = '';
    el.load();
  } catch {
    // ignore media release errors
  }
}

interface Step5VisualEditorProps {
  project: Project;
  previewLang: TargetLang;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc: string | null;
  rawVideoSrc: string | null;
  currentTimeMs: number;
  durationMs: number;
  isPlaying: boolean;
  onTimeUpdateMs: (ms: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onSeekToMs: (ms: number) => void;
  onProjectUpdated: (project: Project) => void;
  onDownloadMp4?: () => void;
  renderLangSwitcher?: React.ReactNode;
}

const ASPECT_OPTIONS: Array<{ value: ExportAspectRatio; label: string; hint: string }> = [
  { value: '16:9', label: '16:9', hint: 'Landscape' },
  { value: '9:16', label: '9:16', hint: 'Reels / Shorts' },
  { value: '1:1', label: '1:1', hint: 'Square' },
  { value: '4:5', label: '4:5', hint: 'Portrait Feed' },
];

const SUBTITLE_PRESETS: Array<{ value: ExportSubtitlePreset; label: string }> = [
  { value: 'classic', label: 'Classic' },
  { value: 'boxed', label: 'Boxed' },
  { value: 'neon', label: 'Neon' },
  { value: 'minimal', label: 'Minimal' },
];

const FONT_OPTIONS = [
  { label: 'Padauk', value: 'Padauk, Noto Sans Myanmar, sans-serif' },
  { label: 'Noto Sans Myanmar', value: 'Noto Sans Myanmar, Myanmar Sangam MN, sans-serif' },
  { label: 'Pyidaungsu', value: 'Pyidaungsu, Noto Sans Myanmar, sans-serif' },
  { label: 'Myanmar Sangam MN', value: 'Myanmar Sangam MN, Noto Sans Myanmar, sans-serif' },
  { label: 'Sans (System)', value: 'sans-serif' },
];

type EditorTab = 'blur' | 'subtitle' | 'fontfx' | 'filter' | 'border' | 'frame' | 'logo';

const FILTER_PRESETS: Array<{
  value: ExportVisualFilterPreset;
  label: string;
  hint: string;
  css: string;
}> = (
  ['none', '4k', '8k', 'clear2', 'clearsky', 'hdcam2', 'vivid'] as ExportVisualFilterPreset[]
).map((value) => ({
  value,
  label:
    value === 'none'
      ? 'None'
      : value === '4k'
        ? '4K'
        : value === '8k'
          ? '8K'
          : value === 'clear2'
            ? 'Clear II'
            : value === 'clearsky'
              ? 'Clear Sky'
              : value === 'hdcam2'
                ? 'HD Cam 2'
                : 'Vivid',
  hint:
    value === 'none'
      ? 'Original look'
      : value === '4k'
        ? 'Crisp + punchy'
        : value === '8k'
          ? 'Max sharpness'
          : value === 'clear2'
            ? 'Clean clarity'
            : value === 'clearsky'
              ? 'Cool + clear'
              : value === 'hdcam2'
                ? 'Warm filmic'
                : 'Rich colors',
  css: filterPresetToCssFilter(value),
}));

const BORDER_PRESETS: Array<{ value: ExportBorderPreset; label: string; swatch: string }> = [
  { value: 'none', label: 'None', swatch: 'transparent' },
  { value: 'gold', label: 'Gold', swatch: '#FFD700' },
  { value: 'neonCyan', label: 'Neon Cyan', swatch: '#00E5FF' },
  { value: 'fireRed', label: 'Fire Red', swatch: '#FF3B30' },
  { value: 'pink', label: 'Pink', swatch: '#FF69B4' },
  { value: 'royalPurple', label: 'Royal Purple', swatch: '#7C3AED' },
  { value: 'rainbow', label: 'Rainbow', swatch: 'linear-gradient(90deg,#FF3B30,#FFD700,#00E5FF,#FF69B4)' },
];

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `rgba(0, 0, 0, ${alpha})`;
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

async function processLogoImageClient(
  sourceDataUrl: string,
  opts: { removeBg: boolean; circleCrop: boolean },
): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Failed to decode uploaded logo image.'));
    el.src = sourceDataUrl;
  });

  const maxDim = 512;
  const srcW = Math.max(1, img.naturalWidth || img.width);
  const srcH = Math.max(1, img.naturalHeight || img.height);
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const w = Math.max(16, Math.round(srcW * scale));
  const h = Math.max(16, Math.round(srcH * scale));

  const workCanvas = document.createElement('canvas');
  workCanvas.width = w;
  workCanvas.height = h;
  const wctx = workCanvas.getContext('2d', { willReadFrequently: true });
  if (!wctx) return sourceDataUrl;

  wctx.drawImage(img, 0, 0, w, h);

  if (opts.removeBg) {
    const imgData = wctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    // Sample corner clusters to infer backdrop RGB
    const cornerCoords = [
      [1, 1],
      [w - 2, 1],
      [1, h - 2],
      [w - 2, h - 2],
      [Math.min(w - 1, 4), Math.min(h - 1, 4)],
      [Math.max(0, w - 5), Math.min(h - 1, 4)],
    ];
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let samples = 0;
    for (const [cx, cy] of cornerCoords) {
      const idx = (Math.max(0, cy) * w + Math.max(0, cx)) * 4;
      if (data[idx + 3] > 20) {
        sumR += data[idx];
        sumG += data[idx + 1];
        sumB += data[idx + 2];
        samples += 1;
      }
    }

    if (samples > 0) {
      const bgR = sumR / samples;
      const bgG = sumG / samples;
      const bgB = sumB / samples;
      const hardThresh = 38;
      const softThresh = 74;

      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a === 0) continue;
        const dr = data[i] - bgR;
        const dg = data[i + 1] - bgG;
        const db = data[i + 2] - bgB;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist <= hardThresh) {
          data[i + 3] = 0;
        } else if (dist < softThresh) {
          const t = (dist - hardThresh) / (softThresh - hardThresh);
          data[i + 3] = Math.round(a * t);
        }
      }
      wctx.putImageData(imgData, 0, 0);
    }
  }

  if (!opts.circleCrop) {
    return workCanvas.toDataURL('image/png');
  }

  const size = Math.min(w, h);
  const outCanvas = document.createElement('canvas');
  outCanvas.width = size;
  outCanvas.height = size;
  const octx = outCanvas.getContext('2d');
  if (!octx) return workCanvas.toDataURL('image/png');

  octx.save();
  octx.beginPath();
  octx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  octx.closePath();
  octx.clip();

  const sx = Math.max(0, Math.floor((w - size) / 2));
  const sy = Math.max(0, Math.floor((h - size) / 2));
  octx.drawImage(workCanvas, sx, sy, size, size, 0, 0, size, size);
  octx.restore();

  return outCanvas.toDataURL('image/png');
}

function getAspectNumeric(ratio: ExportAspectRatio): number {
  switch (ratio) {
    case '9:16':
      return 9 / 16;
    case '1:1':
      return 1;
    case '4:5':
      return 4 / 5;
    case '16:9':
    default:
      return 16 / 9;
  }
}

function resolveProjectSingleLang(project: Project, fallbackLang: TargetLang): TargetLang {
  if (project.target_langs.includes('my-MM')) return 'my-MM';
  if (project.target_langs.includes('en-US')) return 'en-US';
  return fallbackLang === 'en-US' ? 'en-US' : 'my-MM';
}

function inferDefaultAspectRatio(project: Project): ExportAspectRatio {
  const w = project.video?.width || 0;
  const h = project.video?.height || 0;
  if (w > 0 && h > 0) {
    const ar = w / h;
    if (ar < 0.72) return '9:16';
    if (ar < 0.9) return '4:5';
    if (ar < 1.15) return '1:1';
    return '16:9';
  }
  return DEFAULT_EXPORT_VISUAL_CONFIG.aspectRatio;
}

function normalizeVisualConfigForLang(
  raw: ExportVisualConfig | undefined,
  project: Project,
  allowedSubMode: 'mm' | 'en',
): ExportVisualConfig {
  const base = raw ?? {
    ...DEFAULT_EXPORT_VISUAL_CONFIG,
    aspectRatio: inferDefaultAspectRatio(project),
  };
  return {
    ...base,
    subtitle: {
      ...base.subtitle,
      mode: base.subtitle.mode === 'none' ? 'none' : allowedSubMode,
    },
  };
}

export const Step5VisualEditor: React.FC<Step5VisualEditorProps> = ({
  project,
  previewLang,
  videoRef,
  videoSrc,
  rawVideoSrc,
  currentTimeMs,
  durationMs,
  isPlaying,
  onTimeUpdateMs,
  onPlayingChange,
  onSeekToMs,
  onProjectUpdated,
  onDownloadMp4,
}) => {
  const activeLang = useMemo(
    () => resolveProjectSingleLang(project, previewLang),
    [project, previewLang],
  );
  const allowedSubMode: 'mm' | 'en' = activeLang === 'my-MM' ? 'mm' : 'en';

  const [config, setConfig] = useState<ExportVisualConfig>(() =>
    normalizeVisualConfigForLang(project.export_visual_config, project, allowedSubMode),
  );
  const [rawLogoDataUrl, setRawLogoDataUrl] = useState<string | null>(
    () => project.export_visual_config?.logo.dataUrl ?? null,
  );
  const [editorTab, setEditorTab] = useState<EditorTab>('filter');
  const [viewMode, setViewMode] = useState<'editor' | 'baked'>('editor');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccessMsg, setExportSuccessMsg] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const outerViewportRef = useRef<HTMLDivElement | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const blobUrlsRef = useRef<Set<string>>(new Set());

  const [viewportWidth, setViewportWidth] = useState(520);
  const [stageDims, setStageDims] = useState({ width: 520, height: 292 });

  const lastProjectIdRef = useRef(project.id);
  useEffect(() => {
    if (lastProjectIdRef.current !== project.id) {
      lastProjectIdRef.current = project.id;
      const normalized = normalizeVisualConfigForLang(
        project.export_visual_config,
        project,
        allowedSubMode,
      );
      setConfig(normalized);
      setRawLogoDataUrl(normalized.logo.dataUrl ?? null);
      setExportError(null);
      setExportSuccessMsg(null);
    }
  }, [project, allowedSubMode]);

  useEffect(() => {
    setConfig((prev) => {
      if (prev.subtitle.mode === 'none' || prev.subtitle.mode === allowedSubMode) {
        return prev;
      }
      return {
        ...prev,
        subtitle: { ...prev.subtitle, mode: allowedSubMode },
      };
    });
  }, [allowedSubMode]);

  // Measure outer container width so portrait 9:16 & 4:5 stages fit cleanly inside max height
  useEffect(() => {
    const outer = outerViewportRef.current;
    if (!outer) return;
    const obs = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0) {
        setViewportWidth(rect.width);
      }
    });
    obs.observe(outer);
    return () => obs.disconnect();
  }, []);

  const computedStageBox = useMemo(() => {
    const maxH = 380;
    const maxW = Math.max(220, viewportWidth);
    const ar = getAspectNumeric(config.aspectRatio);
    let w = maxW;
    let h = w / ar;
    if (h > maxH) {
      h = maxH;
      w = h * ar;
    }
    return {
      width: Math.round(w),
      height: Math.round(h),
    };
  }, [viewportWidth, config.aspectRatio]);

  useEffect(() => {
    setStageDims(computedStageBox);
  }, [computedStageBox]);

  // Process logo with HTML5 Canvas whenever raw upload, removeBg, or circleCrop changes
  useEffect(() => {
    if (!rawLogoDataUrl) return;
    let cancelled = false;
    void processLogoImageClient(rawLogoDataUrl, {
      removeBg: config.logo.removeBg,
      circleCrop: config.logo.circleCrop,
    })
      .then((processed) => {
        if (cancelled) return;
        setConfig((prev) => ({
          ...prev,
          logo: {
            ...prev.logo,
            dataUrl: processed,
          },
        }));
      })
      .catch((err) => {
        console.warn('[Logo Canvas Process]', err);
      });
    return () => {
      cancelled = true;
    };
  }, [rawLogoDataUrl, config.logo.removeBg, config.logo.circleCrop]);

  // Sync blurred background video with foreground video playback
  useEffect(() => {
    if (viewMode !== 'editor' || config.fitMode !== 'blur') return;
    const fg = videoRef.current;
    const bg = bgVideoRef.current;
    if (!fg || !bg) return;

    const syncTime = () => {
      if (Math.abs(bg.currentTime - fg.currentTime) > 0.12) {
        bg.currentTime = fg.currentTime;
      }
    };
    const onPlay = () => {
      syncTime();
      void bg.play().catch(() => {});
    };
    const onPause = () => {
      bg.pause();
      syncTime();
    };
    const onSeeked = () => {
      bg.currentTime = fg.currentTime;
    };

    fg.addEventListener('play', onPlay);
    fg.addEventListener('pause', onPause);
    fg.addEventListener('seeked', onSeeked);
    if (!fg.paused) {
      onPlay();
    }
    return () => {
      fg.removeEventListener('play', onPlay);
      fg.removeEventListener('pause', onPause);
      fg.removeEventListener('seeked', onSeeked);
      releaseVideoElement(bg);
    };
  }, [viewMode, config.fitMode, videoRef, rawVideoSrc, videoSrc]);

  // Release all media decoder buffers & blob URLs on unmount or source/mode switch
  useEffect(() => {
    const fg = videoRef.current;
    const bg = bgVideoRef.current;
    return () => {
      releaseVideoElement(fg);
      releaseVideoElement(bg);
    };
  }, [project.id, viewMode, rawVideoSrc, videoSrc, videoRef]);

  useEffect(() => {
    return () => {
      for (const url of blobUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      blobUrlsRef.current.clear();
    };
  }, []);

  // Build synchronized single-language subtitle cues
  const activeReport = useMemo(
    () =>
      project.dub_reports.find((r) => r.lang === activeLang) ??
      project.dub_reports[0] ??
      null,
    [project.dub_reports, activeLang],
  );
  const rangeStartMs = activeReport?.range_start_ms ?? 0;

  const subtitleCues = useMemo(() => {
    if (config.subtitle.mode === 'none') return [];
    const wantLang: TargetLang = activeLang;
    let rawCues: SubtitleCue[] = [];

    const dubMatched = project.dub
      .filter((d) => d.lang === wantLang && d.tgt_text.trim().length > 0)
      .sort((a, b) => a.start_ms - b.start_ms);

    if (dubMatched.length > 0) {
      rawCues = dubMatched.map((s) => {
        const startMs = Math.max(0, (s.effective_start_ms ?? s.start_ms) - rangeStartMs);
        const endAbs = Math.max(
          s.effective_end_ms ?? s.end_ms,
          (s.effective_start_ms ?? s.start_ms) + (s.tts_ms || 0),
        );
        const endMs = Math.max(startMs + 250, endAbs - rangeStartMs);
        return { startMs, endMs, text: s.tgt_text.trim() };
      });
    } else {
      const recapMatched = project.recap
        .filter((b) => b.lang === wantLang && b.narration_text.trim().length > 0)
        .sort((a, b) => a.start_ms - b.start_ms);
      if (recapMatched.length > 0) {
        rawCues = recapMatched.map((b) => {
          const startMs = Math.max(0, (b.effective_start_ms ?? b.start_ms) - rangeStartMs);
          const endAbs = Math.max(
            b.effective_end_ms ?? b.end_ms,
            (b.effective_start_ms ?? b.start_ms) + (b.tts_ms || 0),
          );
          const endMs = Math.max(startMs + 250, endAbs - rangeStartMs);
          return { startMs, endMs, text: b.narration_text.trim() };
        });
      } else if (wantLang === 'en-US') {
        const dubSrc = project.dub
          .filter((d) => d.src_text.trim().length > 0)
          .sort((a, b) => a.start_ms - b.start_ms);
        if (dubSrc.length > 0) {
          rawCues = dubSrc.map((s) => {
            const startMs = Math.max(0, (s.effective_start_ms ?? s.start_ms) - rangeStartMs);
            const endAbs = Math.max(
              s.effective_end_ms ?? s.end_ms,
              (s.effective_start_ms ?? s.start_ms) + (s.tts_ms || 0),
            );
            const endMs = Math.max(startMs + 250, endAbs - rangeStartMs);
            return { startMs, endMs, text: s.src_text.trim() };
          });
        } else {
          rawCues = project.speech
            .filter((s) => s.text.trim().length > 0)
            .map((s) => ({
              startMs: Math.max(0, s.start_ms - rangeStartMs),
              endMs: Math.max(250, s.end_ms - rangeStartMs),
              text: s.text.trim(),
            }));
        }
      }
    }

    return rawCues.flatMap((cue) => splitSubtitleCue(cue, { lang: wantLang }));
  }, [config.subtitle.mode, activeLang, project.dub, project.recap, project.speech, rangeStartMs]);

  const activeCue = useMemo(() => {
    if (subtitleCues.length === 0) return null;
    return (
      subtitleCues.find((c) => currentTimeMs >= c.startMs && currentTimeMs <= c.endMs) ?? null
    );
  }, [subtitleCues, currentTimeMs]);

  // Show a preview subtitle when Subtitle tab is active & playback is paused on a gap so user can position/style immediately
  const displaySubtitleText = useMemo(() => {
    if (config.subtitle.mode === 'none') return null;
    if (activeCue) return activeCue.text;
    if (!isPlaying && editorTab === 'subtitle') {
      return (
        subtitleCues[0]?.text ??
        (config.subtitle.mode === 'mm'
          ? 'နမူနာ စာတန်းထိုး စမ်းသပ်မှု'
          : 'Sample Subtitle Preview')
      );
    }
    return null;
  }, [config.subtitle.mode, activeCue, isPlaying, editorTab, subtitleCues]);

  // Drag Subtitle vertically (60fps)
  const startSubtitleDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      if (rect.height <= 0) return;

      const onMove = (ev: PointerEvent) => {
        const yPct = Math.max(
          5,
          Math.min(95, Math.round(((ev.clientY - rect.top) / rect.height) * 100)),
        );
        setConfig((prev) => ({
          ...prev,
          subtitle: { ...prev.subtitle, yPercent: yPct },
        }));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [],
  );

  // Drag Blur Box X/Y (60fps), stored as normalized 0..1 coordinates
  const startBlurBoxDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const initX = config.blurBox.x;
      const initY = config.blurBox.y;

      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / rect.width;
        const dy = (ev.clientY - startY) / rect.height;
        setConfig((prev) => ({
          ...prev,
          blurBox: {
            ...prev.blurBox,
            x: Math.max(0, Math.min(1 - prev.blurBox.w, initX + dx)),
            y: Math.max(0, Math.min(1 - prev.blurBox.h, initY + dy)),
          },
        }));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [config.blurBox.x, config.blurBox.y, config.blurBox.w, config.blurBox.h],
  );

  // Drag bottom-right corner handle to resize Blur Box (60fps)
  const startBlurBoxResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const initW = config.blurBox.w;
      const initH = config.blurBox.h;

      const onMove = (ev: PointerEvent) => {
        const dw = (ev.clientX - startX) / rect.width;
        const dh = (ev.clientY - startY) / rect.height;
        setConfig((prev) => ({
          ...prev,
          blurBox: {
            ...prev.blurBox,
            w: Math.max(0.02, Math.min(1 - prev.blurBox.x, initW + dw)),
            h: Math.max(0.02, Math.min(1 - prev.blurBox.y, initH + dh)),
          },
        }));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [config.blurBox.w, config.blurBox.h, config.blurBox.x, config.blurBox.y],
  );

  // Drag Logo X/Y (60fps)
  const startLogoDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const initXPct = config.logo.xPercent;
      const initYPct = config.logo.yPercent;
      const maxX = Math.max(0, 100 - config.logo.scalePercent);

      const onMove = (ev: PointerEvent) => {
        const dxPct = ((ev.clientX - startX) / rect.width) * 100;
        const dyPct = ((ev.clientY - startY) / rect.height) * 100;
        const nextX = Math.max(0, Math.min(maxX, Math.round((initXPct + dxPct) * 10) / 10));
        const nextY = Math.max(0, Math.min(92, Math.round((initYPct + dyPct) * 10) / 10));
        setConfig((prev) => ({
          ...prev,
          logo: { ...prev.logo, xPercent: nextX, yPercent: nextY },
        }));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [config.logo.xPercent, config.logo.yPercent, config.logo.scalePercent],
  );

  // Drag bottom-right corner handle to resize Logo (60fps)
  const startLogoResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0) return;

      const startX = e.clientX;
      const initScale = config.logo.scalePercent;

      const onMove = (ev: PointerEvent) => {
        const dxPct = ((ev.clientX - startX) / rect.width) * 100;
        const nextScale = Math.max(5, Math.min(40, Math.round(initScale + dxPct)));
        setConfig((prev) => ({
          ...prev,
          logo: {
            ...prev.logo,
            scalePercent: nextScale,
            xPercent: Math.min(prev.logo.xPercent, 100 - nextScale),
          },
        }));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [config.logo.scalePercent],
  );

  const handleLogoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const objUrl = URL.createObjectURL(file);
    blobUrlsRef.current.add(objUrl);
    try {
      const compactPngDataUrl = await processLogoImageClient(objUrl, {
        removeBg: false,
        circleCrop: false,
      });
      setRawLogoDataUrl(compactPngDataUrl);
      setConfig((prev) => ({
        ...prev,
        logo: {
          ...prev.logo,
          enabled: true,
          dataUrl: compactPngDataUrl,
        },
      }));
      setEditorTab('logo');
    } catch (err) {
      console.warn('[Logo Upload]', err);
    } finally {
      try {
        URL.revokeObjectURL(objUrl);
      } catch {
        // ignore
      }
      blobUrlsRef.current.delete(objUrl);
    }
  };

  const handleExportVideo = async () => {
    if (exporting) return;
    setExportError(null);
    setExportSuccessMsg(null);
    setExporting(true);

    const prevGeneratedAt = activeReport?.generated_at ?? '';

    try {
      const normalizedExportConfig = normalizeVisualConfigForLang(config, project, allowedSubMode);
      const res = await apiFetchJson<{ started?: boolean; error?: string }>(
        `/api/projects/${encodeURIComponent(project.id)}/export`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lang: activeLang,
            visualConfig: normalizedExportConfig,
          }),
        },
      );

      if (!res.ok) {
        throw new Error(res.data?.error || `Export failed (HTTP ${res.status})`);
      }

      // Poll project state until export finishes (works alongside SSE)
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const pollRes = await apiFetchJson<{ project?: Project }>(
          `/api/projects/${encodeURIComponent(project.id)}`,
        );
        if (!pollRes.ok || !pollRes.data?.project) continue;
        const latest = pollRes.data.project;
        onProjectUpdated(latest);

        const latestReport =
          latest.dub_reports.find((r) => r.lang === activeLang) ?? latest.dub_reports[0];
        if (latest.stages.dub.status === 'error') {
          throw new Error(latest.stages.dub.error || latest.stages.dub.message || 'Export failed.');
        }
        if (
          latest.stages.dub.status === 'done' &&
          latestReport &&
          (latestReport.generated_at !== prevGeneratedAt ||
            latest.stages.dub.message?.startsWith('Visual export ready'))
        ) {
          setExportSuccessMsg(latest.stages.dub.message || 'Visual export complete.');
          setViewMode('baked');
          break;
        }
      }
    } catch (err) {
      setExportError(sanitizeUiErrorText(err) || 'Visual export failed.');
    } finally {
      setExporting(false);
    }
  };

  const flipTransform = `scaleX(${config.flipHorizontal ? -1 : 1}) scaleY(${config.flipVertical ? -1 : 1})`;
  const previewVideoFilter = filterPresetToCssFilter(config.filterPreset);
  const previewBorderPx = borderThicknessPxForHeight(config.border, stageDims.height);

  const subtitleRenderedStyle = useMemo<React.CSSProperties>(() => {
    // WYSIWYG: identical relative formula to the ASS export (height * fontSizePct / 100).
    const scaledPx = subtitleFontPxForStage(config.subtitle, stageDims.height);
    const outlinePx = subtitleOutlineWidthForStage(config.subtitle, stageDims.height);
    const { textColor, outlineColor, bgColor, bgOpacity, stylePreset, fontFamily, shadowDepth } =
      config.subtitle;

    const base: React.CSSProperties = {
      fontFamily,
      fontSize: `${scaledPx.toFixed(1)}px`,
      fontWeight: 600,
      color: textColor,
      lineHeight: 1.35,
      textAlign: 'center',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxWidth: '88%',
    };

    if (stylePreset === 'boxed') {
      return {
        ...base,
        backgroundColor: hexToRgba(bgColor, bgOpacity),
        padding: '5px 12px',
        borderRadius: '10px',
        textShadow: `0 1px ${Math.max(1, outlinePx / 2)}px ${hexToRgba(outlineColor, 0.9)}`,
      };
    }
    if (stylePreset === 'neon') {
      return {
        ...base,
        textShadow: `0 0 ${outlinePx * 2}px ${outlineColor}, 0 0 ${outlinePx * 4}px ${outlineColor}, 0 0 2px ${outlineColor}`,
      };
    }
    if (stylePreset === 'minimal') {
      return {
        ...base,
        textShadow: `0 1px ${Math.max(1, shadowDepth)}px ${hexToRgba(outlineColor, 0.85)}`,
      };
    }
    // classic: crisp outline (matches ASS BorderStyle 1) + semi-transparent pill
    const o = Math.max(0.5, outlinePx);
    return {
      ...base,
      backgroundColor: hexToRgba(bgColor, Math.min(0.6, bgOpacity * 0.65)),
      padding: '3px 10px',
      borderRadius: '8px',
      textShadow: `-${o}px -${o}px 0 ${outlineColor}, ${o}px -${o}px 0 ${outlineColor}, -${o}px ${o}px 0 ${outlineColor}, ${o}px ${o}px 0 ${outlineColor}, 0 ${Math.max(1, shadowDepth)}px 4px ${hexToRgba(bgColor, bgOpacity)}`,
    };
  }, [config.subtitle, stageDims.height]);

  const editorVideoSource = rawVideoSrc || videoSrc;
  const isJobRunning = exporting || project.stages.dub.status === 'running';

  return (
    <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl p-5 space-y-4">
      {/* Top Bar: Preview Mode + Timecode + Language Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center rounded-lg bg-[#0E1422] border border-[rgba(148,163,184,0.18)] p-0.5 text-[11px] font-medium">
          <button
            type="button"
            onClick={() => setViewMode('editor')}
            className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              viewMode === 'editor'
                ? 'bg-cyan-500 text-slate-950'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Live Preview Editor
          </button>
          <button
            type="button"
            onClick={() => setViewMode('baked')}
            className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              viewMode === 'baked'
                ? 'bg-emerald-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Final Exported MP4
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs font-mono tabular-nums text-slate-300">
          <span>
            {formatTimecode(currentTimeMs)} / {formatTimecode(durationMs)}
          </span>
          <span className="px-2 py-0.5 rounded bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-[10px] text-cyan-300">
            {activeLang}
          </span>
        </div>
      </div>

      {/* Interactive 60fps Stage OR Baked Final MP4 */}
      <div
        ref={outerViewportRef}
        className="relative w-full rounded-xl bg-[#070A12] border border-white/[0.08] p-3 flex items-center justify-center min-h-[240px] overflow-hidden"
      >
        {/* Radial studio glow behind the stage */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 70% 60% at 50% 42%, rgba(6,182,212,0.10) 0%, rgba(6,182,212,0.04) 45%, transparent 75%)',
          }}
        />
        {viewMode === 'baked' ? (
          videoSrc ? (
            <video
              ref={videoRef}
              key={`baked-${activeLang}-${activeReport?.generated_at ?? 'single'}`}
              controls
              preload="metadata"
              src={videoSrc}
              onTimeUpdate={() => {
                if (videoRef.current) {
                  onTimeUpdateMs(Math.round(videoRef.current.currentTime * 1000));
                }
              }}
              onPlay={() => onPlayingChange(true)}
              onPause={() => onPlayingChange(false)}
              className="w-full max-h-[380px] rounded-lg object-contain bg-black"
            />
          ) : (
            <div className="text-xs text-slate-500 py-12">No rendered MP4 available yet.</div>
          )
        ) : editorVideoSource ? (
          <div
            style={{
              width: `${stageDims.width}px`,
              height: `${stageDims.height}px`,
              ...(previewBorderPx > 0
                ? {
                    // WYSIWYG frame border: solid presets use their hex; rainbow = 4-color sides.
                    borderStyle: 'solid',
                    borderWidth: `${previewBorderPx}px`,
                    borderImage:
                      config.border.preset === 'rainbow'
                        ? 'linear-gradient(90deg,#FF3B30,#FFD700,#00E5FF,#FF69B4) 1'
                        : undefined,
                    borderColor:
                      config.border.preset === 'rainbow'
                        ? undefined
                        : (borderPresetColor(config.border.preset) ?? undefined),
                  }
                : {}),
            }}
            ref={stageRef}
            className="relative overflow-hidden rounded-lg bg-black shadow-2xl ring-1 ring-white/15 select-none"
          >
            {/* Blurred Duplicate Background Layer */}
            {config.fitMode === 'blur' && (
              <video
                ref={bgVideoRef}
                key={`bg-${activeLang}-${activeReport?.generated_at ?? 'single'}`}
                src={editorVideoSource}
                preload="metadata"
                muted
                playsInline
                aria-hidden="true"
                style={{ transform: `scale(1.12) ${flipTransform}` }}
                className="absolute inset-0 w-full h-full object-cover blur-xl brightness-75 pointer-events-none"
              />
            )}

            {/* Main Foreground Sharp Video (CapCut-style preset applied as CSS filter) */}
            <video
              ref={videoRef}
              key={`fg-${activeLang}-${activeReport?.generated_at ?? 'single'}`}
              src={editorVideoSource}
              preload="metadata"
              playsInline
              onTimeUpdate={() => {
                if (videoRef.current) {
                  onTimeUpdateMs(Math.round(videoRef.current.currentTime * 1000));
                }
              }}
              onPlay={() => onPlayingChange(true)}
              onPause={() => onPlayingChange(false)}
              style={{ transform: flipTransform, filter: previewVideoFilter || undefined }}
              className={`relative z-[1] w-full h-full ${
                config.fitMode === 'crop' ? 'object-cover' : 'object-contain'
              }`}
            />

            {/* Blur Box overlay covering hardcoded original subtitles */}
            {config.blurBox.enabled && (
              <div
                onPointerDown={startBlurBoxDrag}
                title="Drag to move blur box · corner handle resizes"
                style={{
                  left: `${config.blurBox.x * 100}%`,
                  top: `${config.blurBox.y * 100}%`,
                  width: `${config.blurBox.w * 100}%`,
                  height: `${config.blurBox.h * 100}%`,
                  backdropFilter: `blur(${config.blurBox.strength}px)`,
                  WebkitBackdropFilter: `blur(${config.blurBox.strength}px)`,
                }}
                className="group absolute z-[2] cursor-move bg-black/10"
              >
                <span className="absolute inset-0 hidden group-hover:ring-2 group-hover:ring-cyan-400/70 rounded-sm" />
                <div
                  onPointerDown={startBlurBoxResize}
                  title="Drag to resize blur box"
                  className="absolute -right-1.5 -bottom-1.5 w-3 h-3 rounded-full bg-cyan-500 border-2 border-white shadow cursor-nwse-resize opacity-80 group-hover:opacity-100"
                />
              </div>
            )}

            {/* Draggable Live Subtitle Overlay */}
            {displaySubtitleText && (
              <div
                onPointerDown={startSubtitleDrag}
                title="Drag vertically to reposition subtitle"
                style={{
                  top: `${config.subtitle.yPercent}%`,
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                }}
                className={`absolute z-[3] w-[92%] flex justify-center cursor-ns-resize transition-opacity ${
                  !activeCue && !isPlaying ? 'opacity-75 ring-1 ring-dashed ring-cyan-400/60 rounded py-0.5' : ''
                }`}
              >
                <div style={subtitleRenderedStyle}>{displaySubtitleText}</div>
              </div>
            )}

            {/* Draggable & Resizable Logo Overlay */}
            {config.logo.enabled && config.logo.dataUrl && (
              <div
                onPointerDown={startLogoDrag}
                title="Drag to move logo · Drag corner handle to resize"
                style={{
                  left: `${config.logo.xPercent}%`,
                  top: `${config.logo.yPercent}%`,
                  width: `${config.logo.scalePercent}%`,
                }}
                className="group absolute z-[4] cursor-move hover:ring-2 hover:ring-cyan-400 rounded"
              >
                <img
                  src={config.logo.dataUrl}
                  alt="Channel logo overlay"
                  draggable={false}
                  className="w-full h-auto block pointer-events-none select-none"
                />
                <div
                  onPointerDown={startLogoResize}
                  title="Drag to resize logo"
                  className="absolute -right-1.5 -bottom-1.5 w-3.5 h-3.5 rounded-full bg-cyan-500 border-2 border-white shadow cursor-nwse-resize opacity-80 group-hover:opacity-100"
                />
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-slate-500 py-12">No rendered MP4 available yet.</div>
        )}
      </div>

      {/* Scrub Timeline Slider */}
      {durationMs > 0 && (
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={durationMs}
            step={50}
            value={Math.min(currentTimeMs, durationMs)}
            onChange={(e) => onSeekToMs(Number(e.target.value))}
            aria-label="Video timeline seek"
            className="w-full accent-cyan-500 cursor-pointer h-1.5 bg-[#0B0F19] rounded-lg"
          />
        </div>
      )}

      {/* Visual Editor Tabs — only the active tool panel is mounted at once */}
      <div className="border border-[rgba(148,163,184,0.14)] bg-[#131A2A] rounded-xl overflow-hidden">
        <div className="grid grid-cols-4 sm:grid-cols-7 border-b border-[rgba(148,163,184,0.14)] text-xs font-medium">
          {(
            [
              ['blur', 'Blur', Eraser, config.blurBox.enabled],
              ['subtitle', 'Subtitle', Subtitles, config.subtitle.mode !== 'none'],
              ['fontfx', 'Font & FX', Type, true],
              ['filter', 'Filter', Sparkles, config.filterPreset !== 'none'],
              ['border', 'Border', Square, config.border.preset !== 'none'],
              ['frame', 'Frame', Maximize2, true],
              ['logo', 'Logo', ImageIcon, config.logo.enabled],
            ] as Array<[EditorTab, string, typeof Type, boolean]>
          ).map(([tabId, label, Icon, active]) => (
            <button
              key={tabId}
              type="button"
              onClick={() => setEditorTab(tabId)}
              className={`flex items-center justify-center gap-1.5 py-2.5 px-2 transition-colors cursor-pointer whitespace-nowrap ${
                editorTab === tabId
                  ? 'bg-[#0E1422] text-white border-b-2 border-cyan-400/60'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline text-[11px]">
                {label}
                {active && tabId !== 'fontfx' && tabId !== 'frame' ? ' •' : ''}
              </span>
            </button>
          ))}
        </div>

        <div className="p-4 space-y-4 text-xs">
          {/* TAB: BLUR BOX (original hardcoded subtitles) */}
          {editorTab === 'blur' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] text-slate-400">
                  Cover hardcoded original subtitles with a blurred box (applied identically in
                  export).
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setConfig((p) => ({
                      ...p,
                      blurBox: { ...p.blurBox, enabled: !p.blurBox.enabled },
                    }))
                  }
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium cursor-pointer whitespace-nowrap ${
                    config.blurBox.enabled
                      ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                      : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-300 hover:border-white/25'
                  }`}
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{config.blurBox.enabled ? 'Blur Box On' : 'Blur Box Off'}</span>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    ['x', 'X Position', 0, 100, 1],
                    ['y', 'Y Position', 0, 100, 1],
                    ['w', 'Width', 2, 100, 1],
                    ['h', 'Height', 2, 100, 1],
                  ] as Array<[keyof Pick<ExportBlurBoxConfig, 'x' | 'y' | 'w' | 'h'>, string, number, number, number]>
                ).map(([key, label, min, max, step]) => (
                  <label key={key} className="space-y-1 block">
                    <div className="flex justify-between text-[11px] text-slate-400">
                      <span>{label}</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        {Math.round(config.blurBox[key] * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={Math.round(config.blurBox[key] * 100)}
                      onChange={(e) => {
                        const pct = Number(e.target.value) / 100;
                        setConfig((p) => ({
                          ...p,
                          blurBox: { ...p.blurBox, [key]: pct },
                        }));
                      }}
                      className="w-full accent-cyan-500 cursor-pointer"
                    />
                  </label>
                ))}
              </div>

              <label className="space-y-1 block">
                <div className="flex justify-between text-[11px] text-slate-400">
                  <span>Blur Strength</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {config.blurBox.strength}px
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={40}
                  value={config.blurBox.strength}
                  onChange={(e) =>
                    setConfig((p) => ({
                      ...p,
                      blurBox: { ...p.blurBox, strength: Number(e.target.value) },
                    }))
                  }
                  className="w-full accent-cyan-500 cursor-pointer"
                />
              </label>

              <p className="text-[11px] text-slate-400">
                Drag the box directly on the video to move it; drag its bottom-right cyan dot to
                resize.
              </p>
            </div>
          )}

          {/* TAB: FILTER PRESETS */}
          {editorTab === 'filter' && (
            <div className="space-y-3">
              <div className="text-[11px] text-slate-400">
                CapCut-style clarity presets — edge sharpening + micro-contrast (no upscaling).
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {FILTER_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => setConfig((p) => ({ ...p, filterPreset: preset.value }))}
                    className={`py-2 px-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                      config.filterPreset === preset.value
                        ? 'bg-cyan-500/15 border-cyan-400/60 text-white'
                        : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-300 hover:border-white/25'
                    }`}
                  >
                    <div className="font-semibold">{preset.label}</div>
                    <div className="text-[10px] text-slate-400 truncate">{preset.hint}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* TAB: BORDER */}
          {editorTab === 'border' && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {BORDER_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() =>
                      setConfig((p) => ({ ...p, border: { ...p.border, preset: preset.value } }))
                    }
                    className={`inline-flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-lg border font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      config.border.preset === preset.value
                        ? 'bg-cyan-500/15 border-cyan-400/60 text-white'
                        : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-300 hover:border-white/25'
                    }`}
                  >
                    <span
                      className="w-3 h-3 rounded-sm border border-white/20 shrink-0"
                      style={{ background: preset.swatch }}
                    />
                    <span className="text-[11px]">{preset.label}</span>
                  </button>
                ))}
              </div>

              <label className="space-y-1 block">
                <div className="flex justify-between text-[11px] text-slate-400">
                  <span>Thickness (% of video height)</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {config.border.thicknessPct.toFixed(1)}% · {previewBorderPx}px
                  </span>
                </div>
                <input
                  type="range"
                  min={0.2}
                  max={8}
                  step={0.1}
                  value={config.border.thicknessPct}
                  disabled={config.border.preset === 'none'}
                  onChange={(e) =>
                    setConfig((p) => ({
                      ...p,
                      border: { ...p.border, thicknessPct: Number(e.target.value) },
                    }))
                  }
                  className="w-full accent-cyan-500 cursor-pointer disabled:opacity-40"
                />
              </label>
            </div>
          )}

          {/* TAB: FONT & FX */}
          {editorTab === 'fontfx' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="space-y-1 block">
                  <span className="text-[11px] text-slate-400 block">Font Family</span>
                  <select
                    value={config.subtitle.fontFamily}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        subtitle: { ...p.subtitle, fontFamily: e.target.value },
                      }))
                    }
                    className="w-full bg-[#131A2A] border border-[rgba(148,163,184,0.14)] rounded-lg px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-400/70"
                  >
                    {FONT_OPTIONS.map((f) => (
                      <option key={f.label} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1 block">
                  <span className="text-[11px] text-slate-400 block">Style Preset</span>
                  <div className="grid grid-cols-4 gap-1.5">
                    {SUBTITLE_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() =>
                          setConfig((p) => ({
                            ...p,
                            subtitle: { ...p.subtitle, stylePreset: preset.value },
                          }))
                        }
                        className={`py-1.5 px-1 rounded-lg border font-medium transition-colors cursor-pointer whitespace-nowrap text-[11px] ${
                          config.subtitle.stylePreset === preset.value
                            ? 'bg-cyan-500/15 border-cyan-400/60 text-white'
                            : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-300 hover:border-white/25'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </label>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(
                  [
                    ['textColor', 'Text Color'],
                    ['outlineColor', 'Outline Color'],
                    ['bgColor', 'Box / BG Color'],
                  ] as Array<['textColor' | 'outlineColor' | 'bgColor', string]>
                ).map(([key, label]) => (
                  <label key={key} className="space-y-1 block">
                    <span className="text-[11px] text-slate-400 block">{label}</span>
                    <div className="flex items-center gap-2 bg-[#131A2A] border border-[rgba(148,163,184,0.14)] rounded-lg px-2 py-1">
                      <input
                        type="color"
                        value={config.subtitle[key]}
                        onChange={(e) =>
                          setConfig((p) => ({
                            ...p,
                            subtitle: { ...p.subtitle, [key]: e.target.value },
                          }))
                        }
                        className="w-6 h-5 bg-transparent border-0 cursor-pointer p-0"
                      />
                      <span className="font-mono text-[11px] text-slate-300">
                        {config.subtitle[key]}
                      </span>
                    </div>
                  </label>
                ))}

                <label className="space-y-1 block">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>BG Opacity</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {Math.round(config.subtitle.bgOpacity * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={config.subtitle.bgOpacity}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        subtitle: { ...p.subtitle, bgOpacity: Number(e.target.value) },
                      }))
                    }
                    className="w-full accent-cyan-500 cursor-pointer"
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="space-y-1 block">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Outline Width</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {config.subtitle.outlineWidth.toFixed(1)}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={14}
                    step={0.2}
                    value={config.subtitle.outlineWidth}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        subtitle: { ...p.subtitle, outlineWidth: Number(e.target.value) },
                      }))
                    }
                    className="w-full accent-cyan-500 cursor-pointer"
                  />
                </label>

                <label className="space-y-1 block">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Shadow Depth</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {config.subtitle.shadowDepth.toFixed(1)}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.2}
                    value={config.subtitle.shadowDepth}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        subtitle: { ...p.subtitle, shadowDepth: Number(e.target.value) },
                      }))
                    }
                    className="w-full accent-cyan-500 cursor-pointer"
                  />
                </label>

                <label className="space-y-1 block">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Size (% of height)</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {config.subtitle.fontSizePct.toFixed(1)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    step={0.2}
                    value={config.subtitle.fontSizePct}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        subtitle: { ...p.subtitle, fontSizePct: Number(e.target.value) },
                      }))
                    }
                    className="w-full accent-cyan-500 cursor-pointer"
                  />
                </label>
              </div>

              <p className="text-[11px] text-slate-400">
                Font size is stored as a percentage of video height, so Preview and the exported MP4
                render the exact same relative size.
              </p>
            </div>
          )}

          {/* TAB: FRAME & FLIP */}
          {editorTab === 'frame' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="text-[11px] font-medium text-slate-400">Aspect Ratio</div>
                <div className="grid grid-cols-4 gap-2">
                  {ASPECT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setConfig((p) => ({ ...p, aspectRatio: opt.value }))}
                      className={`py-2 px-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                        config.aspectRatio === opt.value
                          ? 'bg-cyan-500/15 border-cyan-400/60 text-white'
                          : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-300 hover:border-white/25'
                      }`}
                    >
                      <div className="font-mono font-semibold">{opt.label}</div>
                      <div className="text-[10px] text-slate-400 truncate">{opt.hint}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <div className="text-[11px] font-medium text-slate-400">Framing Mode</div>
                  <div className="grid grid-cols-2 gap-2">
                    {(['crop', 'blur'] as ExportFitMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setConfig((p) => ({ ...p, fitMode: mode }))}
                        className={`inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          config.fitMode === mode
                            ? 'bg-cyan-500/15 border-cyan-400/60 text-white'
                            : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-300 hover:border-white/25'
                        }`}
                      >
                        <Layers className="w-3.5 h-3.5" />
                        <span>{mode === 'crop' ? 'Crop (Fill)' : 'Blur BG'}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-[11px] font-medium text-slate-400">Mirror / Flip</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setConfig((p) => ({ ...p, flipHorizontal: !p.flipHorizontal }))
                      }
                      className={`inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        config.flipHorizontal
                          ? 'bg-cyan-500/15 border-cyan-400/60 text-white'
                          : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-300 hover:border-white/25'
                      }`}
                    >
                      <FlipHorizontal2 className="w-3.5 h-3.5" />
                      <span>Mirror H</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfig((p) => ({ ...p, flipVertical: !p.flipVertical }))}
                      className={`inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        config.flipVertical
                          ? 'bg-cyan-500/15 border-cyan-400/60 text-white'
                          : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-300 hover:border-white/25'
                      }`}
                    >
                      <FlipVertical2 className="w-3.5 h-3.5" />
                      <span>Flip V</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB: SUBTITLE (track toggle + position; styling lives in Font & FX) */}
          {editorTab === 'subtitle' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-slate-400">Subtitle Track</div>
                  <div className="inline-flex rounded-lg bg-[#131A2A] border border-[rgba(148,163,184,0.14)] p-0.5">
                    {(
                      [
                        [
                          allowedSubMode,
                          allowedSubMode === 'mm' ? 'Myanmar (MM)' : 'English (EN)',
                        ],
                        ['none', 'Off'],
                      ] as Array<[ExportSubtitleMode, string]>
                    ).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() =>
                          setConfig((p) => ({ ...p, subtitle: { ...p.subtitle, mode: m } }))
                        }
                        className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          config.subtitle.mode === m
                            ? 'bg-cyan-500 text-slate-950'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="space-y-1 block">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Vertical Position (or drag subtitle on video)</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {config.subtitle.yPercent}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={95}
                    value={config.subtitle.yPercent}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        subtitle: { ...p.subtitle, yPercent: Number(e.target.value) },
                      }))
                    }
                    className="w-full accent-cyan-500 cursor-pointer"
                  />
                </label>

                <label className="space-y-1 block">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Size (% of video height)</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {config.subtitle.fontSizePct.toFixed(1)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    step={0.2}
                    value={config.subtitle.fontSizePct}
                    onChange={(e) =>
                      setConfig((p) => ({
                        ...p,
                        subtitle: { ...p.subtitle, fontSizePct: Number(e.target.value) },
                      }))
                    }
                    className="w-full accent-cyan-500 cursor-pointer"
                  />
                </label>
              </div>

              <p className="text-[11px] text-slate-400">
                Font, colors, outline, shadow and background box are configured in{' '}
                <button
                  type="button"
                  onClick={() => setEditorTab('fontfx')}
                  className="underline text-cyan-300 cursor-pointer"
                >
                  Font &amp; FX
                </button>
                .
              </p>
            </div>
          )}

          {/* TAB 3: LOGO */}
          {editorTab === 'logo' && (
            <div className="space-y-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                onChange={handleLogoFileChange}
                className="hidden"
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-white font-medium cursor-pointer whitespace-nowrap"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>{rawLogoDataUrl ? 'Replace Logo' : 'Upload Logo'}</span>
                  </button>

                  {rawLogoDataUrl && (
                    <button
                      type="button"
                      onClick={() =>
                        setConfig((p) => ({
                          ...p,
                          logo: { ...p.logo, enabled: !p.logo.enabled },
                        }))
                      }
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium cursor-pointer whitespace-nowrap ${
                        config.logo.enabled
                          ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                          : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-300'
                      }`}
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>{config.logo.enabled ? 'Logo Visible' : 'Logo Hidden'}</span>
                    </button>
                  )}
                </div>

                {rawLogoDataUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      setRawLogoDataUrl(null);
                      setConfig((p) => ({
                        ...p,
                        logo: { ...DEFAULT_EXPORT_VISUAL_CONFIG.logo },
                      }));
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#131A2A] border border-[rgba(148,163,184,0.14)] text-slate-400 hover:text-red-300 hover:border-red-500/40 cursor-pointer whitespace-nowrap"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Remove</span>
                  </button>
                )}
              </div>

              {rawLogoDataUrl ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setConfig((p) => ({
                          ...p,
                          logo: { ...p.logo, circleCrop: !p.logo.circleCrop },
                        }))
                      }
                      className={`inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        config.logo.circleCrop
                          ? 'bg-cyan-500/15 border-cyan-400/60 text-white'
                          : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-300 hover:border-white/25'
                      }`}
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Circle Crop</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setConfig((p) => ({
                          ...p,
                          logo: { ...p.logo, removeBg: !p.logo.removeBg },
                        }))
                      }
                      className={`inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        config.logo.removeBg
                          ? 'bg-cyan-500/15 border-cyan-400/60 text-white'
                          : 'bg-[#131A2A] border-[rgba(148,163,184,0.14)] text-slate-300 hover:border-white/25'
                      }`}
                    >
                      <Wand2 className="w-3.5 h-3.5" />
                      <span>Auto Remove BG</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <label className="space-y-1 block">
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span>Size</span>
                        <span className="font-mono tabular-nums text-slate-200">
                          {config.logo.scalePercent}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={5}
                        max={40}
                        value={config.logo.scalePercent}
                        onChange={(e) => {
                          const s = Number(e.target.value);
                          setConfig((p) => ({
                            ...p,
                            logo: {
                              ...p.logo,
                              scalePercent: s,
                              xPercent: Math.min(p.logo.xPercent, 100 - s),
                            },
                          }));
                        }}
                        className="w-full accent-cyan-500 cursor-pointer"
                      />
                    </label>

                    <label className="space-y-1 block">
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span>X Pos</span>
                        <span className="font-mono tabular-nums text-slate-200">
                          {Math.round(config.logo.xPercent)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100 - config.logo.scalePercent}
                        value={Math.min(config.logo.xPercent, 100 - config.logo.scalePercent)}
                        onChange={(e) =>
                          setConfig((p) => ({
                            ...p,
                            logo: { ...p.logo, xPercent: Number(e.target.value) },
                          }))
                        }
                        className="w-full accent-cyan-500 cursor-pointer"
                      />
                    </label>

                    <label className="space-y-1 block">
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span>Y Pos</span>
                        <span className="font-mono tabular-nums text-slate-200">
                          {Math.round(config.logo.yPercent)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={92}
                        value={Math.min(config.logo.yPercent, 92)}
                        onChange={(e) =>
                          setConfig((p) => ({
                            ...p,
                            logo: { ...p.logo, yPercent: Number(e.target.value) },
                          }))
                        }
                        className="w-full accent-cyan-500 cursor-pointer"
                      />
                    </label>
                  </div>

                  <p className="text-[11px] text-slate-400">
                    Drag the logo directly on the preview to position it, or drag its bottom-right
                    cyan dot to resize.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-white/15 bg-[#131A2A]/60 p-4 text-center text-[11px] text-slate-400">
                  Upload a PNG, JPG, or WebP watermark/logo to position, circle-crop, and
                  auto-remove background in real time.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Export Action + Progress / Status */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <button
          type="button"
          disabled={isJobRunning}
          onClick={() => {
            setConfig(normalizeVisualConfigForLang(undefined, project, allowedSubMode));
            setRawLogoDataUrl(null);
            setExportError(null);
            setExportSuccessMsg(null);
          }}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0E1422] border border-[rgba(148,163,184,0.18)] text-slate-300 rounded-lg hover:text-white hover:border-white/25 disabled:opacity-50 cursor-pointer whitespace-nowrap"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Reset Visuals</span>
        </button>

        <button
          type="button"
          disabled={isJobRunning || !activeReport?.mp4_file}
          onClick={() => void handleExportVideo()}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-white rounded-lg transition-colors cursor-pointer whitespace-nowrap shadow-[0_0_20px_rgba(6,182,212,0.18)]"
        >
          {isJobRunning ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Exporting ({project.stages.dub.progress_pct}%)...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" />
              <span>Apply &amp; Export MP4 ({activeLang})</span>
            </>
          )}
        </button>
      </div>

      {isJobRunning && project.stages.dub.message && (
        <div className="text-[11px] font-mono text-cyan-300 bg-cyan-950/30 border border-cyan-400/30 rounded-lg px-3 py-2">
          {project.stages.dub.message}
        </div>
      )}

      {exportError && (
        <div className="text-[11px] text-red-300 bg-red-950/30 border border-red-500/30 rounded-lg px-3 py-2">
          {exportError}
        </div>
      )}

      {exportSuccessMsg && !isJobRunning && (
        <div className="text-[11px] text-emerald-300 bg-emerald-950/30 border border-emerald-500/30 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
          <span>{exportSuccessMsg}</span>
          <a
            href={`/api/projects/${encodeURIComponent(project.id)}/media/dub/${encodeURIComponent(activeLang)}/mp4?download=1`}
            download
            onClick={() => onDownloadMp4?.()}
            className="underline font-semibold text-emerald-200 whitespace-nowrap"
          >
            Download MP4
          </a>
        </div>
      )}
    </div>
  );
};
