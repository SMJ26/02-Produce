export const FPS = 30
export const SAMPLE_RATE = 48_000
export const SPF = SAMPLE_RATE / FPS
export const frame = (sample: number) => Math.round(sample / SPF)

export interface Phrase {
  id: string
  text: string
  startSample: number
  endSample: number
}
export interface Asset {
  kind: 'image' | 'audio' | 'words'
  sha256: string
  licenseId: string
}
export interface Timeline {
  version: 1
  presetVersion: 'studio-1'
  fps: 30
  width: 1920
  height: 1080
  sampleRate: 48000
  durationFrames: number
  assets: Record<string, Asset>
  video: {start: number; end: number; assetId: string; sourceIn: 0; transition: 'cut'; fit: 'cover'}[]
  overlays: {start: number; end: number; kind: 'caption'; z: 1; text: string; wordIds: string[]}[]
  audio: {assetId: string; role: 'narration'; startSample: 0; endSample: number; inSample: 0; gainDb: 0}[]
}
export function validate(t: Timeline, samples: number, phrases: Phrase[]) {
  const fail = (detail: string) => { throw new Error(`Invalid timeline: ${detail}`) }
  const index = (n: number) => Number.isSafeInteger(n) && n >= 0
  if (t.version !== 1 || t.presetVersion !== 'studio-1' || t.fps !== FPS ||
      t.width !== 1920 || t.height !== 1080 || t.sampleRate !== SAMPLE_RATE ||
      !index(samples) || samples < 1 || samples > 310 * SAMPLE_RATE ||
      t.durationFrames !== Math.ceil(samples / SPF)) fail('output settings or duration')
  if (Object.keys(t.assets).length > 32 || t.overlays.length > 400 || t.video.length > 400)
    fail('complexity limit')
  for (const asset of Object.values(t.assets)) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !asset.licenseId ||
        !['image', 'words', 'audio'].includes(asset.kind)) fail('asset provenance')
  }
  let cursor = 0
  for (const clip of t.video) {
    if (clip.start !== cursor || !index(clip.end) || clip.end <= cursor ||
        clip.end > t.durationFrames || !Object.hasOwn(t.assets, clip.assetId) ||
        t.assets[clip.assetId].kind !== 'image' || clip.transition !== 'cut' ||
        clip.fit !== 'cover' || clip.sourceIn !== 0) fail('visual coverage or unsupported clip')
    cursor = clip.end
  }
  if (cursor !== t.durationFrames) fail('visual coverage')
  const audio = t.audio[0]
  if (t.audio.length !== 1 || t.assets[audio.assetId]?.kind !== 'audio' ||
      audio.role !== 'narration' || audio.startSample !== 0 || audio.inSample !== 0 ||
      audio.gainDb !== 0 || audio.endSample !== samples) fail('narration bounds')
  const refs = new Map<string, Phrase>()
  cursor = 0
  for (const phrase of phrases) {
    if (!index(phrase.startSample) || !index(phrase.endSample) || phrase.startSample < cursor ||
        phrase.endSample <= phrase.startSample || phrase.endSample > samples ||
        refs.has(phrase.id) || !phrase.text.trim() || phrase.text.length > 240) fail('phrase bounds')
    refs.set(phrase.id, phrase)
    cursor = phrase.endSample
  }
  const captioned = new Set<string>()
  cursor = 0
  for (const overlay of t.overlays) {
    const phrase = refs.get(overlay.wordIds[0])
    if (!phrase || overlay.wordIds.length !== 1 || overlay.kind !== 'caption' || overlay.z !== 1 ||
        overlay.start < cursor || overlay.end > t.durationFrames || overlay.start >= overlay.end ||
        overlay.start !== frame(phrase.startSample) || overlay.end !== frame(phrase.endSample) ||
        overlay.text !== phrase.text) fail('caption bounds or anchor')
    captioned.add(overlay.wordIds[0])
    cursor = overlay.end
  }
  if (phrases.some(phrase => frame(phrase.startSample) < frame(phrase.endSample) && !captioned.has(phrase.id)))
    fail('missing caption coverage')
}
