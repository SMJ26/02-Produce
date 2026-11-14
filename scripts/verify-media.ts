import assert from 'node:assert/strict'
import {mkdtemp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ffmpeg, render, run, sha} from '../src/media.ts'
import type {Phrase, Timeline} from '../src/timeline.ts'

const dir = await mkdtemp(join(tmpdir(), 'cutline-fixture-'))
const paths = {red: join(dir, 'red.ppm'), blue: join(dir, 'blue.ppm'), voice: join(dir, 'voice.pcm')}
for (const [key, color] of [['red', [170, 25, 20]], ['blue', [10, 50, 180]]] as const) {
  await writeFile(paths[key], Buffer.concat([Buffer.from('P6\n16 16\n255\n'),
    Buffer.from(Array.from({length: 256}, () => [...color]).flat())]))
}
const total = 157_000
const cut = 65_420
const pcm = Buffer.alloc(total * 2)
for (const onset of [16_080, cut]) {
  for (let i = 0; i < 2_400; i++)
    pcm.writeInt16LE(Math.round(16_000 * Math.sin(i * Math.PI / 24)), (onset + i) * 2)
}
await writeFile(paths.voice, pcm)
const phrases: Phrase[] = [
  {id: 'p0', text: 'First pulse', startSample: 16_080, endSample: 48_010},
  {id: 'p1', text: 'Second pulse', startSample: cut, endSample: 112_050},
]
const timeline: Timeline = {
  version: 1, presetVersion: 'studio-1', fps: 30, width: 1920, height: 1080, sampleRate: 48000,
  durationFrames: 99,
  assets: {
    red: {kind: 'image', sha256: await sha(paths.red), licenseId: 'original-fixture'},
    blue: {kind: 'image', sha256: await sha(paths.blue), licenseId: 'original-fixture'},
    voice: {kind: 'audio', sha256: await sha(paths.voice), licenseId: 'original-fixture'},
  },
  video: [
    {start: 0, end: 41, assetId: 'red', sourceIn: 0, transition: 'cut', fit: 'cover'},
    {start: 41, end: 99, assetId: 'blue', sourceIn: 0, transition: 'cut', fit: 'cover'},
  ],
  overlays: [
    {start: 10, end: 30, kind: 'caption', z: 1, text: phrases[0].text, wordIds: ['p0']},
    {start: 41, end: 70, kind: 'caption', z: 1, text: phrases[1].text, wordIds: ['p1']},
  ],
  audio: [{assetId: 'voice', role: 'narration', startSample: 0, endSample: total, inSample: 0, gainDb: 0}],
}
await writeFile(join(dir, 'timeline.json'), JSON.stringify(timeline, null, 2))
const file = await render(timeline, phrases, paths, dir)
const timestamps = JSON.parse((await run(process.env.FFPROBE_PATH || 'ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time',
  '-of', 'json', file,
])).toString()).frames
assert.equal(timestamps.length, 99)
for (const [index, timestamp] of timestamps.entries())
  assert.ok(Math.abs(Number(timestamp.best_effort_timestamp_time) * 30 - index) < 0.001)
const pixels = await ffmpeg(['-i', file, '-an', '-vf', 'scale=96:54',
  '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])
const at = (frame: number) => pixels.subarray(frame * 96 * 54 * 3, (frame + 1) * 96 * 54 * 3)
const caption = (frame: number) => at(frame).some((value, i) =>
  i > 96 * 39 * 3 && i % 3 === 0 && value < 35 && at(frame)[i + 1] < 35 && at(frame)[i + 2] < 35)
for (let i = 0; i < 99; i++) {
  assert.equal(at(i)[0] > at(i)[2], i < 41, `cut at frame ${i}`)
  assert.equal(caption(i), (i >= 10 && i < 30) || (i >= 41 && i < 70), `caption at frame ${i}`)
}
const decoded = await ffmpeg(['-i', file, '-vn', '-f', 's16le', '-'])
const bursts = []
for (let i = 0; i < decoded.length / 2; i += 400) {
  let peak = 0
  for (let j = i; j < Math.min(i + 400, decoded.length / 2); j++)
    peak = Math.max(peak, Math.abs(decoded.readInt16LE(j * 2)))
  if (peak > 800) bursts.push(i)
}
assert.ok(Math.abs(bursts[0] - 16_080) < 1600)
assert.ok(Math.abs(bursts.find(i => i > 50_000)! - cut) < 1600)
console.log(`Verified 99 gapless frames, decoded caption and cut windows, and audio pulses: ${file}`)
