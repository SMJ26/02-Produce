import {readFile, writeFile} from 'node:fs/promises'
import {platform} from 'node:os'
import {join} from 'node:path'
import {ffmpeg, run} from './media.ts'
import {SAMPLE_RATE, type Phrase} from './timeline.ts'

export type Mode = 'demo' | 'hosted'
export interface Brief { topic: string; minutes: number; mode: Mode }
export interface ScriptProvider { draft(brief: Brief): Promise<string> }
export interface Narration { pcm: Buffer; phrases: Phrase[] }
export interface SpeechProvider {
  synthesize(script: string, minutes: number, dir: string, signal: AbortSignal): Promise<Narration>
}

const demoSections = [
  'Start with something you can observe. Find a familiar example, then look for one detail you usually miss. A simple example gives you a place to start when the bigger subject feels hard to picture.',
  'Now consider what changes over time. Notice what happens first, what follows, and what stays steady. A short sequence is easier to explain when you can point to something that marks each change.',
  'Scale can change the story. A pattern you see up close might disappear when you step back. Try a second example at a different scale and describe what you can see from each point of view.',
  'Look for an exception. Ask when your first explanation might fail, and imagine what you would observe if it did. An exception can show you where a simple explanation needs another detail.',
  'Test your understanding by explaining the idea aloud. Choose ordinary words and connect each point to an example. If you get stuck at a transition, take it as a cue to examine the link between two ideas.',
  'Put your observations together in a short summary. Start with the question, give one example, and say what the example helped you understand. End with one thing you would still like to find out.',
  'Write down two different explanations for what you observed. Think about what each explanation predicts in a new example. A prediction gives you a concrete reason to compare the explanations.',
  'A diagram can make a connection easier to see. Put the main idea in one place and draw a line to each example. Label the lines so someone else can follow the reasoning without you in the room.',
  'Look at a system from the point of view of one part. Ask what it receives and what it passes on. Then follow that exchange until you can describe what happens across the whole system.',
  'Try keeping a brief record of each step. A few notes can preserve details you might forget when you return to the subject. Date your notes and mark the parts you still need to check.',
  'Talk through the idea with someone who is new to it. Invite them to point out the moment the explanation gets confusing. Their questions can help you find assumptions you made along the way.',
  'Make the same observation in a different setting. Keep track of anything that changed alongside the thing you meant to study. A comparison is easier to interpret when you know which details stayed the same.',
  'Imagine what you would see at the beginning, halfway through, and at the end. Draw the three moments as separate pictures. Then look for clues that tell you how one picture became the next.',
  'Choose two examples and give each a short label. Look for the feature they share and a feature that sets them apart. This exercise helps separate the main idea from details that belong to one case.',
  'Pick a detail that you could count or measure. Before measuring it, write down what you expect and why. Afterward, compare the result with your expectation and use the difference to sharpen your explanation.',
  'Some effects are easy to see right away, while others accumulate slowly. Think of a case where a small change gets repeated. Consider what evidence would distinguish a gradual change from a sudden one.',
  'Check whether your example depends on a particular starting condition. Change that condition in your mind and trace the likely consequences. If your explanation still works, say which part of it stayed the same.',
  'Make a short list of terms that someone new to the subject might ask about. Define each term using an example from the video. Keep the definition close to the first place the term matters.',
  'Set aside one claim you feel confident about and one you are unsure of. Decide what observation would make each claim stronger. This gives you a way to keep learning when the first explanation runs out.',
  'Return to the original question with what you know now. Notice which parts are easier to explain and where you would like more evidence. Use that difference to choose your next question.',
]

const demoScript: ScriptProvider = {
  async draft({topic, minutes}) {
    return [
      `Today we're using ${topic} as the starting point for a short explainer. Let's walk through a few ways to turn a broad subject into a question you can investigate.`,
      ...demoSections.slice(0, minutes === 2 ? 5 : Math.round(minutes * 4.6) - 2),
      'Take a moment to choose one question to carry forward. If you can say what you want to observe next, you have a practical place to start.',
    ].join('\n\n')
  },
}

export function requireHosted(stage: 'script' | 'voice') {
  const names = stage === 'script' ? ['OPENAI_API_KEY'] : ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']
  const missing = names.filter(name => !process.env[name]?.trim())
  if (missing.length) throw new Error(`Hosted mode needs ${missing.join(' and ')} in .env. Restart Studio and the worker, or choose Demo.`)
}

async function providerJson(url: string, body: unknown, headers: Record<string, string>,
  name: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(150_000)
  const response = await fetch(url, {
    method: 'POST', headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(() => { throw new Error(`${name} could not be reached. Check connectivity and provider activity before retrying.`) })
  if (!response.ok)
    throw new Error(`${name} returned HTTP ${response.status}. Check the key, model or voice access and account limits.`)
  return response.json()
}

const hostedScript: ScriptProvider = {
  async draft({topic, minutes}) {
    requireHosted('script')
    const data = await providerJson('https://api.openai.com/v1/chat/completions', {
      model: process.env.OPENAI_SCRIPT_MODEL || 'gpt-4.1-mini',
      messages: [
        {role: 'system', content: 'Write a spoken English explainer. Output narration only, with short sentences and paragraph breaks. Avoid citations, headings, stage directions, and unsupported specific claims.'},
        {role: 'user', content: `Topic: ${topic}\nLength: approximately ${minutes * 145} spoken words.`},
      ],
    }, {Authorization: `Bearer ${process.env.OPENAI_API_KEY}`}, 'OpenAI')
    return checkScript(data.choices?.[0]?.message?.content)
  },
}

export function checkScript(value: unknown) {
  if (typeof value !== 'string' || value.trim().length < 30 || value.length > 7500 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value) || /\S{47}/u.test(value))
    throw new Error('Enter a script between 30 and 7,500 characters. Use spaces between words.')
  return value.trim()
}

const captionPattern = /\S+(?:\s+\S+){0,9}/gu
function phraseRanges(text: string) {
  const phrases: {text: string; start: number; end: number}[] = []
  const segments = new Intl.Segmenter('en', {granularity: 'sentence'}).segment(text)
  for (const sentence of segments) {
    for (const batch of sentence.segment.matchAll(captionPattern)) {
      let start = sentence.index + batch.index
      let line = ''
      for (const word of batch[0].matchAll(/\S+/gu)) {
        if (line && word.index + word[0].length + sentence.index + batch.index - start > 84) {
          phrases.push({text: line, start, end: start + line.length})
          line = ''
          start = sentence.index + batch.index + word.index
        }
        const end = sentence.index + batch.index + word.index + word[0].length
        line = text.slice(start, end)
      }
      if (line) phrases.push({text: line, start, end: start + line.length})
    }
  }
  return phrases
}

const localSpeech: SpeechProvider = {
  async synthesize(script, minutes, dir, signal) {
    const chunks: Buffer[] = []
    const ranges = phraseRanges(script)
    const input = join(dir, 'speech.txt')
    const wave = join(dir, 'speech.wav')
    const useSay = platform() === 'darwin' && !process.env.ESPEAK_PATH
    for (const phrase of ranges) {
      await writeFile(input, phrase.text)
      if (useSay) {
        await run('say', ['-v', 'Samantha', '-r', '158', '-f', input, '-o', wave,
          '--file-format=WAVE', '--data-format=LEI16@22050'], {signal})
      } else {
        await run(process.env.ESPEAK_PATH || 'espeak-ng', ['-v', 'en-us', '-s', '158', '-f', input, '-w', wave], {signal})
      }
      const spoken = await ffmpeg(['-i', wave, '-af', 'silenceremove=start_periods=1:start_duration=0.015:start_threshold=-48dB,areverse,silenceremove=start_periods=1:start_duration=0.015:start_threshold=-48dB,areverse',
        '-ar', '48000', '-ac', '1', '-f', 's16le', '-'], {signal})
      if (!spoken.length)
        throw new Error('The local voice returned silent audio. Check the Samantha voice or set ESPEAK_PATH to eSpeak NG.')
      chunks.push(spoken)
    }
    const target = minutes * 60 * SAMPLE_RATE
    const actual = chunks.reduce((sum, chunk) => sum + chunk.length / 2, 0)
    const tempo = actual / (target - ranges.length * 0.18 * SAMPLE_RATE)
    if (tempo < 0.5 || tempo > 2 || !Number.isFinite(tempo))
      throw new Error(`The script length does not fit the selected duration (about ${Math.round(actual / SAMPLE_RATE)} seconds of unadjusted speech). Adjust the script length and approve again.`)
    const adjusted: Buffer[] = []
    for (const chunk of chunks) {
      const raw = join(dir, 'phrase.pcm')
      await writeFile(raw, chunk)
      adjusted.push(await ffmpeg(['-f', 's16le', '-ar', '48000', '-ac', '1', '-i', raw,
        '-af', `atempo=${tempo}`, '-f', 's16le', '-'], {signal}))
    }
    const spoken = adjusted.reduce((sum, chunk) => sum + chunk.length / 2, 0)
    if (spoken > target || adjusted.some(chunk => chunk.length < 3200))
      throw new Error('The local voice could not fit this script. Try shorter sentences or a different duration.')
    const gap = (target - spoken) / adjusted.length
    let offset = 0
    const stitched: Buffer[] = []
    const phrases = adjusted.map((chunk, i) => {
      const endSample = offset + chunk.length / 2
      const phrase = {id: `p${i}`, text: ranges[i].text, startSample: offset, endSample}
      stitched.push(chunk, Buffer.alloc((Math.round((i + 1) * gap) - Math.round(i * gap)) * 2))
      offset = endSample + stitched.at(-1)!.length / 2
      return phrase
    })
    return {pcm: Buffer.concat(stitched), phrases}
  },
}

const hostedSpeech: SpeechProvider = {
  async synthesize(script, minutes, dir, signal) {
    requireHosted('voice')
    const data = await providerJson(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID!)}/with-timestamps?output_format=mp3_44100_128`, {
      text: script, model_id: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
    }, {'xi-api-key': process.env.ELEVENLABS_API_KEY!}, 'ElevenLabs', signal)
    const a = data.alignment
    if (typeof data.audio_base64 !== 'string' || !Array.isArray(a?.characters) ||
        !Array.isArray(a.character_start_times_seconds) || !Array.isArray(a.character_end_times_seconds) ||
        a.characters.join('') !== script)
      throw new Error('ElevenLabs returned incomplete script alignment. Check the selected voice and model before retrying.')
    const mp3 = join(dir, 'voice.mp3')
    await writeFile(mp3, Buffer.from(data.audio_base64, 'base64'))
    const pcm = await ffmpeg(['-i', mp3, '-ar', '48000', '-ac', '1', '-f', 's16le', '-'], {signal})
    const seconds = pcm.length / 2 / SAMPLE_RATE
    if (seconds < 120 || seconds > 300)
      throw new Error(`The selected voice produced ${Math.round(seconds)} seconds. Edit the script to fit 2–5 minutes and approve again.`)
    // The provider's indices are Unicode code points. Intl.Segmenter returns UTF-16 offsets.
    const index = new Map<number, number>()
    let utf16 = 0
    for (const [i, character] of a.characters.entries()) {
      index.set(utf16, i)
      utf16 += character.length
    }
    index.set(utf16, a.characters.length)
    let previous = 0
    const phrases = phraseRanges(script).map((range, i) => {
      const begin = a.character_start_times_seconds[index.get(range.start)!]
      const end = a.character_end_times_seconds[index.get(range.end)! - 1]
      if (!Number.isFinite(begin) || !Number.isFinite(end))
        throw new Error('ElevenLabs omitted caption timestamps. Check the selected voice and model.')
      const startSample = Math.max(previous, Math.round(begin * SAMPLE_RATE))
      const endSample = Math.min(pcm.length / 2, Math.round(end * SAMPLE_RATE))
      previous = endSample
      return {id: `p${i}`, text: range.text, startSample, endSample}
    })
    return {pcm, phrases}
  },
}

export const scripts: Record<Mode, ScriptProvider> = {demo: demoScript, hosted: hostedScript}
export const speech: Record<Mode, SpeechProvider> = {demo: localSpeech, hosted: hostedSpeech}
