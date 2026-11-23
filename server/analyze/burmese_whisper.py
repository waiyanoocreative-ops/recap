#!/usr/bin/env python3
"""
Lightweight Burmese Whisper transcription helper.
Supports Hugging Face `transformers` (default: stevenlimcorn/whisper-small-my or
stevenlimcorn/whisper-medium-my) and `faster-whisper` when a CTranslate2 model path
is supplied. Outputs JSON segments [{start, end, text}] to stdout.
"""

import argparse
import json
import os
import sys
import wave


def get_wav_duration_sec(audio_path: str) -> float:
    try:
        with wave.open(audio_path, "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            if rate > 0:
                return frames / float(rate)
    except Exception:
        pass
    return 0.0


def run_faster_whisper(
    audio_path: str,
    model_path: str,
    threads: int,
    chunk_length_s: int,
    language: str,
) -> dict:
    from faster_whisper import WhisperModel

    has_cuda = False
    try:
        import torch

        has_cuda = bool(torch.cuda.is_available())
    except Exception:
        has_cuda = False

    device = "cuda" if has_cuda else "cpu"
    compute_type = "float16" if has_cuda else "int8"

    sys.stderr.write(
        f"[burmese_whisper.py] Loading faster-whisper model={model_path} device={device} compute_type={compute_type} threads={threads}\n"
    )
    model = WhisperModel(
        model_path,
        device=device,
        compute_type=compute_type,
        cpu_threads=threads,
    )
    raw_segments, _info = model.transcribe(
        audio_path,
        language=language,
        chunk_length=chunk_length_s,
        vad_filter=True,
    )

    segments = []
    for seg in raw_segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        start = max(0.0, float(seg.start))
        end = max(start + 0.05, float(seg.end))
        segments.append({"start": round(start, 3), "end": round(end, 3), "text": text})

    return {
        "backend": "faster_whisper",
        "model": model_path,
        "device": device,
        "fp16": has_cuda,
        "segments": segments,
    }


def run_transformers_whisper(
    audio_path: str,
    model_id: str,
    threads: int,
    chunk_length_s: int,
    language: str,
) -> dict:
    import torch
    from transformers import pipeline

    torch.set_num_threads(threads)
    has_cuda = bool(torch.cuda.is_available())
    device = "cuda:0" if has_cuda else "cpu"
    fp16 = has_cuda
    torch_dtype = torch.float16 if fp16 else torch.float32

    sys.stderr.write(
        f"[burmese_whisper.py] Loading transformers model={model_id} device={device} fp16={fp16} threads={threads} chunk_length_s={chunk_length_s}\n"
    )

    asr_pipe = pipeline(
        "automatic-speech-recognition",
        model=model_id,
        chunk_length_s=chunk_length_s,
        device=device,
        torch_dtype=torch_dtype,
    )

    batch_size = 8 if has_cuda else 1
    generate_kwargs = {"task": "transcribe", "language": language}

    try:
        result = asr_pipe(
            audio_path,
            chunk_length_s=chunk_length_s,
            batch_size=batch_size,
            return_timestamps=True,
            generate_kwargs=generate_kwargs,
        )
    except Exception as exc:
        # Some fine-tuned Whisper checkpoints ship with forced_decoder_ids or monolingual config
        sys.stderr.write(
            f"[burmese_whisper.py] Retrying without explicit generate_kwargs ({exc})\n"
        )
        result = asr_pipe(
            audio_path,
            chunk_length_s=chunk_length_s,
            batch_size=batch_size,
            return_timestamps=True,
        )

    audio_dur = get_wav_duration_sec(audio_path)
    chunks = result.get("chunks") or []
    segments = []
    prev_end = 0.0

    for chunk in chunks:
        text = (chunk.get("text") or "").strip()
        if not text:
            continue
        ts = chunk.get("timestamp")
        raw_start = None
        raw_end = None
        if isinstance(ts, (list, tuple)) and len(ts) >= 2:
            raw_start, raw_end = ts[0], ts[1]

        start = float(raw_start) if raw_start is not None else prev_end
        if raw_end is not None:
            end = float(raw_end)
        elif audio_dur > start:
            end = audio_dur
        else:
            end = start + 2.0

        start = max(0.0, start)
        end = max(start + 0.05, end)
        prev_end = end
        segments.append({"start": round(start, 3), "end": round(end, 3), "text": text})

    if not segments:
        full_text = (result.get("text") or "").strip()
        if full_text:
            end = audio_dur if audio_dur > 0.05 else 2.0
            segments.append({"start": 0.0, "end": round(end, 3), "text": full_text})

    return {
        "backend": "transformers",
        "model": model_id,
        "device": device,
        "fp16": fp16,
        "segments": segments,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Burmese Whisper Speech-to-Text Helper")
    parser.add_argument("--audio", required=True, help="Path to input WAV/audio file")
    parser.add_argument(
        "--model",
        default="stevenlimcorn/whisper-small-my",
        help="Hugging Face model ID or local path (default: stevenlimcorn/whisper-small-my)",
    )
    parser.add_argument(
        "--ct2-model",
        default="",
        help="Optional CTranslate2 model directory for faster-whisper",
    )
    parser.add_argument("--threads", type=int, default=4, help="CPU threads (default: 4)")
    parser.add_argument(
        "--chunk-length",
        type=int,
        default=30,
        help="Chunk length in seconds (default: 30)",
    )
    parser.add_argument(
        "--language",
        default="my",
        help="Whisper language code (default: my)",
    )
    args = parser.parse_args()

    if not os.path.isfile(args.audio):
        sys.stderr.write(f"[burmese_whisper.py] Audio file not found: {args.audio}\n")
        return 1

    ct2_path = (args.ct2_model or "").strip()
    is_ct2_dir = bool(ct2_path) or (
        os.path.isdir(args.model) and os.path.isfile(os.path.join(args.model, "model.bin"))
    )

    try:
        if is_ct2_dir:
            target_ct2 = ct2_path if ct2_path else args.model
            payload = run_faster_whisper(
                audio_path=args.audio,
                model_path=target_ct2,
                threads=max(1, args.threads),
                chunk_length_s=max(5, args.chunk_length),
                language=args.language,
            )
        else:
            payload = run_transformers_whisper(
                audio_path=args.audio,
                model_id=args.model,
                threads=max(1, args.threads),
                chunk_length_s=max(5, args.chunk_length),
                language=args.language,
            )
    except Exception as exc:
        sys.stderr.write(f"[burmese_whisper.py] Transcription error: {exc}\n")
        return 1

    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
