import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {platform} from 'node:os'
import {FPS, SPF, SAMPLE_RATE, validate, type Phrase, type Timeline} from './timeline.ts'

export function run(bin: string, args: string[], options: {
  cwd?: string; signal?: AbortSignal; stdout?: (s: string) => void
} = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {cwd: options.cwd, signal: options.signal, stdio: ['ignore', 'pipe', 'pipe']})
    let error = ''
    const output: Buffer[] = []
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000) })
    child.stdout.on('data', chunk => {
      if (options.stdout) options.stdout(chunk.toString())
      else output.push(chunk)
    })
    child.on('error', err => reject(err.message.includes('ENOENT')
      ? new Error(`Install ${bin} or set its executable path in .env.`) : err))
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(output))
      else reject(new Error(`${bin.split('/').pop()} failed (${code}): ${error.trim()}`))
    })
  })
}

export const ffmpeg = (args: string[], options?: Parameters<typeof run>[2]) =>
  run(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], options)
export async function probe(file: string) {
  const output = await run(process.env.FFPROBE_PATH || 'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])
  return JSON.parse(output.toString())
}
export async function sha(file: string) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

function wrap(text: string) {
  const lines: string[] = []
  let line = ''
  for (const word of text.trim().split(/\s+/u)) {
    if (line && line.length + word.length > 46) {
      lines.push(line)
      line = ''
    }
    line += line ? ` ${word}` : word
  }
  return [...lines, line].join('\n')
}

export async function render(t: Timeline, phrases: Phrase[], paths: Record<string, string>, dir: string,
  signal?: AbortSignal, progress?: (fraction: number) => void) {
  const audio = t.audio[0]
  const samples = (await readFile(paths[audio.assetId])).length / 2
  validate(t, samples, phrases)
  for (const [id, asset] of Object.entries(t.assets)) {
    if (!Object.hasOwn(paths, id) || await sha(paths[id]) !== asset.sha256)
      throw new Error(`Media integrity check failed for ${id}.`)
  }
  // Keep FFmpeg's filter strings under application control. User text enters through UTF-8 files.
  const defaultFont = platform() === 'darwin' ? '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
    : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
  const font = await readFile(/* turbopackIgnore: true */ process.env.CAPTION_FONT || defaultFont)
    .catch(() => { throw new Error('Set CAPTION_FONT to a readable bold TrueType font in .env.') })
  await writeFile(join(dir, 'font.ttf'), font)
  const files: string[] = []
  for (const [index, clip] of t.video.entries()) {
    signal?.throwIfAborted()
    const filters = ['scale=1920:1080', 'setsar=1', 'format=yuv420p']
    for (const [cueIndex, cue] of t.overlays.entries()) {
      const begin = Math.max(clip.start, cue.start)
      const end = Math.min(clip.end, cue.end)
      if (begin >= end) continue
      const filename = `caption-${cueIndex}.txt`
      await writeFile(join(dir, filename), wrap(cue.text))
      filters.push(`drawtext=fontfile=font.ttf:textfile=${filename}:expansion=none:fontsize=50:fontcolor=white:box=1:boxcolor=black@0.82:boxborderw=18:line_spacing=12:x=(w-tw)/2:y=h-th-104:enable='between(n,${begin - clip.start},${end - clip.start - 1})'`)
    }
    const name = `clip-${index}.mp4`
    await ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', paths[clip.assetId],
      '-vf', filters.join(','), '-filter_threads', '2', '-frames:v', String(clip.end - clip.start),
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-threads', '4', name],
    {cwd: dir, signal})
    files.push(`file '${name}'\nduration ${(clip.end - clip.start) / FPS}`)
    progress?.(clip.end / t.durationFrames)
  }
  await writeFile(join(dir, 'clips.txt'), files.join('\n') + '\n')
  const output = join(dir, 'export.mp4')
  await ffmpeg(['-f', 'concat', '-safe', '1', '-i', 'clips.txt',
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', paths[audio.assetId],
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', `apad=whole_len=${t.durationFrames * SPF}`,
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output], {cwd: dir, signal})
  const report = await probe(output)
  const video = report.streams.find((s: {codec_type: string}) => s.codec_type === 'video')
  const voice = report.streams.find((s: {codec_type: string}) => s.codec_type === 'audio')
  if (video?.codec_name !== 'h264' || video.width !== 1920 || video.height !== 1080 ||
      video.r_frame_rate !== '30/1' || Number(video.nb_frames) !== t.durationFrames ||
      voice?.codec_name !== 'aac' || Number(voice.sample_rate) !== SAMPLE_RATE ||
      Math.abs(Number(video.duration) * FPS - t.durationFrames) > 0.1 ||
      Math.abs(Number(voice.duration) * FPS - t.durationFrames) > 1 ||
      Math.abs(Number(report.format.duration) * FPS - samples / SPF) > 1.01)
    throw new Error('Export failed frame, audio, or duration verification.')
  return output
}
