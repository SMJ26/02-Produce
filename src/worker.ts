import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'
import {db, lease, owned, type Job} from './db.ts'
import {render} from './media.ts'
import {compile} from './planner.ts'
import {checkScript, requireHosted, speech, type Narration} from './providers.ts'
import {media} from './storage.ts'

const shutdown = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort())

async function processJob(job: Job) {
  const lost = new AbortController()
  const signal = AbortSignal.any([shutdown.signal, lost.signal])
  const scratch = `scratch/${job.id}/${job.epoch}`
  const exportKey = `exports/${job.id}/${job.epoch}/video.mp4`
  const heartbeat = setInterval(() => {
    void owned(job, "lease_until = now() + interval '12 seconds'")
      .then(result => { if (!result.rowCount) lost.abort() }).catch(() => lost.abort())
  }, 3000)
  const update = async (stage: string, progress: number) => {
    signal.throwIfAborted()
    if (!(await owned(job, 'stage = CASE WHEN progress <= $4 THEN $3 ELSE stage END, progress = GREATEST(progress, $4)', [stage, progress])).rowCount)
      lost.abort()
    signal.throwIfAborted()
  }
  try {
    console.log(`Job ${job.id}, attempt ${job.attempt}`)
    if (job.attempt > 3) throw new Error('The worker stopped repeatedly. Check available disk space and worker logs, then approve a new attempt.')
    // A crash can leave a candidate after its file rename and before the ready update.
    for (let epoch = 1; epoch < job.epoch; epoch++) {
      await media.remove(`scratch/${job.id}/${epoch}`)
      await media.remove(`exports/${job.id}/${epoch}`)
    }
    const script = checkScript(job.script)
    const dir = await media.create(scratch)
    // Once a paid request may have started, recovery uses a saved response or surfaces an error.
    let narration: Narration
    if (job.voice_key) {
      narration = {
        pcm: await readFile(media.path(`${job.voice_key}/voice.pcm`)),
        phrases: JSON.parse(await readFile(media.path(`${job.voice_key}/words.json`), 'utf8')),
      }
    } else {
      await update('Generating narration', 8)
      if (job.mode === 'hosted') {
        if (job.paid_started) throw new Error('The prior voice request may have been billed. Check ElevenLabs usage before approving another attempt.')
        requireHosted('voice')
        if (!(await owned(job, 'paid_started = true')).rowCount) lost.abort()
        signal.throwIfAborted()
      }
      narration = await speech[job.mode].synthesize(script, job.minutes, dir, signal)
    }
    await update('Selecting visuals and aligning captions', 34)
    const {timeline, paths} = await compile(narration, job.topic, dir, job.mode)
    if (job.mode === 'hosted' && !job.voice_key) {
      const key = `narration/${job.id}/${job.epoch}`
      await media.publish(paths.voice, `${key}/voice.pcm`)
      await media.publish(paths.words, `${key}/words.json`)
      paths.voice = media.path(`${key}/voice.pcm`)
      paths.words = media.path(`${key}/words.json`)
      if (!(await owned(job, 'voice_key = $3', [key])).rowCount) lost.abort()
    }
    await update('Rendering video', 42)
    let writtenProgress = 42
    const output = await render(timeline, narration.phrases, paths, dir, signal, fraction => {
      const progress = 42 + Math.floor(52 * fraction)
      if (progress <= writtenProgress) return
      writtenProgress = progress
      void update(fraction === 1 ? 'Verifying MP4' : 'Rendering video', progress).catch(() => lost.abort())
    })
    await update('Publishing verified MP4', 97)
    await media.publish(join(dir, 'timeline.json'), `exports/${job.id}/${job.epoch}/timeline.json`)
    await media.publish(output, exportKey)
    const ready = await owned(job, "status = 'ready', stage = 'Ready to download', progress = 100, export_key = $3, lease_until = NULL", [exportKey])
    if (!ready.rowCount) await media.remove(`exports/${job.id}/${job.epoch}`)
  } catch (error) {
    if (!signal.aborted) {
      const detail = error instanceof Error ? error.message : 'Render failed. Check worker logs.'
      console.error(`Job ${job.id}: ${detail}`)
      await owned(job, "status = 'failed', stage = 'Render failed', error = $3, lease_until = NULL", [detail.slice(0, 900)])
    }
  } finally {
    clearInterval(heartbeat)
    await media.remove(scratch).catch(console.error)
  }
}

try {
  console.log('Cutline worker listening for jobs.')
  while (!shutdown.signal.aborted) {
    try {
      const job = await lease()
      if (job) await processJob(job)
      else await pause(750, undefined, {signal: shutdown.signal})
    } catch (error) {
      if (!shutdown.signal.aborted) {
        console.error(error)
        await pause(2000)
      }
    }
  }
} finally {
  await db.end()
}
