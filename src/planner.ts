import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {sha} from './media.ts'
import {SPF, SAMPLE_RATE, frame, validate, type Phrase, type Timeline} from './timeline.ts'
import type {Narration} from './providers.ts'

const catalog = [
  {id: 'neutral', tags: '', colors: [27, 38, 48]},
  {id: 'orbit', tags: 'space planet moon orbit star sun solar earth scale', colors: [29, 47, 79]},
  {id: 'terrain', tags: 'forest mountain nature land water ocean river climate landscape', colors: [26, 69, 59]},
  {id: 'systems', tags: 'system network computer technology data diagram connection links', colors: [61, 44, 76]},
  {id: 'sequence', tags: 'time sequence change step record notes experiment observe process', colors: [79, 49, 33]},
] as const

interface BeatIntent { anchorWordId: string; query: string }
export interface VisualPlanner { plan(phrases: readonly Phrase[], topic: string): BeatIntent[] }

export const planner: VisualPlanner = {
  plan(phrases, topic) {
    const beats: BeatIntent[] = []
    let start = 0
    for (const [i, phrase] of phrases.entries()) {
      if (i > 0 && phrase.startSample - phrases[start].startSample < 7 * SAMPLE_RATE) continue
      start = i
      beats.push({anchorWordId: phrase.id, query: `${phrases.slice(i, i + 3).map(p => p.text).join(' ')} ${topic}`})
    }
    return beats
  },
}

function art(index: number) {
  const width = 640
  const height = 360
  const pixels = Buffer.alloc(width * height * 3)
  const rgb = catalog[index].colors
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - 347
      const dy = y - 153
      const r = Math.hypot(dx, dy)
      const ring = r > 72 && r < 75 || r > 103 && r < 105 || r > 128 && r < 129
      const ridge = y > 185 + 43 * Math.sin(x / 80) + 21 * Math.cos(x / 31)
      const nodes = Math.hypot(dx % 48, dy % 48) < 3 && r < 132
      const stripe = ((x + Math.abs(dy) * 2) % 45 < 2) && r < 135
      const shape = [ring && r < 108, ring || r < 60, ridge, nodes || stripe, stripe][index]
      const glow = Math.max(0, 20 - r / 9)
      const offset = (y * width + x) * 3
      for (let ch = 0; ch < 3; ch++) pixels[offset + ch] = rgb[ch] + glow + (shape ? 55 : 0)
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels])
}

function resolve(query: string) {
  const tokens = new Set(query.toLowerCase().match(/[a-z]+/g))
  let score = 0
  let id: string = 'neutral'
  for (const item of catalog.slice(1)) {
    const hits = item.tags.split(' ').filter(tag => tokens.has(tag)).length
    if (hits > score) {
      score = hits
      id = item.id
    }
  }
  return id
}

export async function compile(narration: Narration, topic: string, dir: string, mode: string) {
  const {pcm, phrases} = narration
  const samples = pcm.length / 2
  const durationFrames = Math.ceil(samples / SPF)
  const paths: Record<string, string> = {voice: join(dir, 'voice.pcm'), words: join(dir, 'words.json')}
  await writeFile(paths.voice, pcm)
  await writeFile(paths.words, JSON.stringify(phrases))
  const timeline: Timeline = {
    version: 1, presetVersion: 'studio-1', fps: 30, width: 1920, height: 1080,
    sampleRate: 48000, durationFrames, assets: {
      voice: {kind: 'audio', sha256: await sha(paths.voice), licenseId: mode === 'demo' ? 'local-synthetic' : 'configured-voice'},
      words: {kind: 'words', sha256: await sha(paths.words), licenseId: 'project-narration'},
    }, video: [],
    overlays: phrases.filter(p => frame(p.startSample) < frame(p.endSample)).map(p =>
      ({start: frame(p.startSample), end: frame(p.endSample), kind: 'caption', z: 1, text: p.text, wordIds: [p.id]})),
    audio: [{assetId: 'voice', role: 'narration', startSample: 0, endSample: samples, inSample: 0, gainDb: 0}],
  }
  const lookup = new Map(phrases.map(p => [p.id, p]))
  for (const intent of planner.plan(phrases, topic)) {
    const phrase = lookup.get(intent.anchorWordId)
    if (!phrase) continue
    const start = timeline.video.length ? frame(phrase.startSample) : 0
    const previous = timeline.video.at(-1)
    if (start >= durationFrames || (previous && start <= previous.start)) continue
    const assetId = resolve(intent.query)
    if (previous?.assetId === assetId && start - previous.start < 14 * 30) continue
    if (previous) previous.end = start
    if (!Object.hasOwn(paths, assetId)) {
      paths[assetId] = join(dir, `${assetId}.ppm`)
      await writeFile(paths[assetId], art(catalog.findIndex(asset => asset.id === assetId)))
      timeline.assets[assetId] = {kind: 'image', sha256: await sha(paths[assetId]), licenseId: 'original-catalog'}
    }
    timeline.video.push({start, end: durationFrames, assetId, sourceIn: 0, transition: 'cut', fit: 'cover'})
  }
  validate(timeline, samples, phrases)
  await writeFile(join(dir, 'timeline.json'), JSON.stringify(timeline, null, 2))
  return {timeline, paths}
}
