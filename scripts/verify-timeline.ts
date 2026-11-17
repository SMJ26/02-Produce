import assert from 'node:assert/strict'
import {test} from 'node:test'
import {frame, validate, type Phrase, type Timeline} from '../src/timeline.ts'

function fixture() {
  const phrases: Phrase[] = [
    {id: 'p0', text: 'First phrase', startSample: 0, endSample: 16_000},
    {id: 'p1', text: 'Middle phrase', startSample: 16_000, endSample: 32_000},
    {id: 'p2', text: 'Last phrase', startSample: 32_000, endSample: 48_000},
  ]
  const timeline: Timeline = {
    version: 1, presetVersion: 'studio-1', fps: 30, width: 1920, height: 1080,
    sampleRate: 48000, durationFrames: 30,
    assets: {
      image: {kind: 'image', sha256: 'a'.repeat(64), licenseId: 'original-fixture'},
      voice: {kind: 'audio', sha256: 'b'.repeat(64), licenseId: 'original-fixture'},
    },
    video: [{start: 0, end: 30, assetId: 'image', sourceIn: 0, transition: 'cut', fit: 'cover'}],
    overlays: phrases.map(phrase => ({
      start: frame(phrase.startSample), end: frame(phrase.endSample),
      kind: 'caption', z: 1, text: phrase.text, wordIds: [phrase.id],
    })),
    audio: [{assetId: 'voice', role: 'narration', startSample: 0, endSample: 48_000, inSample: 0, gainDb: 0}],
  }
  return {timeline, phrases}
}

test('accepts a caption for every renderable phrase', () => {
  const {timeline, phrases} = fixture()
  assert.doesNotThrow(() => validate(timeline, 48_000, phrases))
})

test('rejects a timeline with all captions removed', () => {
  const {timeline, phrases} = fixture()
  timeline.overlays = []
  assert.throws(() => validate(timeline, 48_000, phrases), /missing caption coverage/)
})

for (const index of [0, 1, 2]) {
  test(`rejects a timeline missing caption ${index}`, () => {
    const {timeline, phrases} = fixture()
    timeline.overlays.splice(index, 1)
    assert.throws(() => validate(timeline, 48_000, phrases), /missing caption coverage/)
  })
}

test('does not require a caption for a phrase that rounds to zero frames', () => {
  const {timeline, phrases} = fixture()
  phrases[0].startSample = 1600
  timeline.overlays[0].start = 1
  phrases.unshift({id: 'tiny', text: 'Brief', startSample: 0, endSample: 100})
  assert.doesNotThrow(() => validate(timeline, 48_000, phrases))
  timeline.overlays.splice(1, 1)
  assert.throws(() => validate(timeline, 48_000, phrases), /missing caption coverage/)
})

test('rejects duplicate captions in place of a missing caption', () => {
  const {timeline, phrases} = fixture()
  timeline.overlays[1] = structuredClone(timeline.overlays[0])
  assert.throws(() => validate(timeline, 48_000, phrases), /caption bounds or anchor/)
})
