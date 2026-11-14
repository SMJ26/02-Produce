import assert from 'node:assert/strict'
import {spawn, type ChildProcess} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {mkdtemp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'
import {db} from '../src/db.ts'
import {probe} from '../src/media.ts'

const base = process.env.STUDIO_URL || 'http://127.0.0.1:3000'
const dir = await mkdtemp(join(tmpdir(), 'cutline-workflow-'))
let worker: ChildProcess | undefined
const startWorker = () => spawn(process.execPath, ['--env-file-if-exists=.env', 'src/worker.ts'], {
  stdio: 'inherit',
})
async function stopWorker(signal: NodeJS.Signals) {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
  const exit = once(worker, 'exit')
  worker.kill(signal)
  await exit
}
async function api(path: string, body?: unknown, status = 200) {
  const response = await fetch(base + path, body ? {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  } : undefined)
  assert.equal(response.status, status, await response.clone().text())
  return response.json()
}
async function until(path: string, predicate: (job: {status: string; stage: string; attempt: number}) => boolean) {
  for (let i = 0; i < 480; i++) {
    const job = await api(path)
    if (predicate(job)) return job
    assert.notEqual(job.status, 'failed', job.error)
    await pause(750)
  }
  throw new Error('Timed out waiting for the Studio job.')
}

try {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    const missing = await api('/api/projects', {topic: 'The moon and tides', minutes: 2, mode: 'hosted'}, 422)
    assert.match(missing.error, /OPENAI_API_KEY/)
  }
  const project = await api('/api/projects', {topic: 'How the moon shapes the tides', minutes: 2, mode: 'demo'}, 201)
  assert.equal(Number((await db.query('SELECT count(*) FROM jobs WHERE project_id = $1', [project.id])).rows[0].count), 0)
  const key = randomUUID()
  const script = project.draft.replace("Today we're using", "In this edited demonstration, we're using")
  const approve = `/api/projects/${project.id}/approve`
  const approved = await api(approve, {script, key}, 202)
  assert.equal(approved.status, 'queued')
  assert.equal(approved.script, script)
  assert.equal((await api(approve, {script, key})).id, approved.id)
  await api(approve, {script: script + ' An extra sentence.', key}, 409)
  const path = `/api/jobs/${approved.id}`
  const early = await fetch(base + path + '/video')
  assert.equal(early.status, 409)
  worker = startWorker()
  await until(path, job => job.stage === 'Rendering video')
  await stopWorker('SIGKILL')
  worker = startWorker()
  const ready = await until(path, job => job.status === 'ready')
  assert.equal(ready.attempt, 2)
  const count = await db.query("SELECT count(*) FROM jobs WHERE project_id = $1 AND status = 'ready'", [project.id])
  assert.equal(Number(count.rows[0].count), 1)
  const partial = await fetch(base + path + '/video', {headers: {Range: 'bytes=0-31'}})
  assert.equal(partial.status, 206)
  assert.equal((await partial.arrayBuffer()).byteLength, 32)
  const response = await fetch(base + path + '/video?download=1')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Disposition') || '', /attachment/)
  const file = join(dir, 'download.mp4')
  await writeFile(file, Buffer.from(await response.arrayBuffer()))
  const report = await probe(file)
  assert.ok(report.streams.some((s: {width: number; height: number; nb_frames: string}) =>
    s.width === 1920 && s.height === 1080 && Number(s.nb_frames) === 3600))
  assert.ok(report.streams.some((s: {codec_name: string; sample_rate: string}) =>
    s.codec_name === 'aac' && s.sample_rate === '48000'))
  assert.equal(Number(report.format.duration), 120)
  const invalidProject = await api('/api/projects', {topic: 'Short script test', minutes: 2, mode: 'demo'}, 201)
  const invalid = await api(`/api/projects/${invalidProject.id}/approve`, {
    key: randomUUID(), script: 'This intentionally short narration cannot fit.',
  }, 202)
  const failed = await until(`/api/jobs/${invalid.id}`, job => job.status === 'failed')
  assert.match(failed.error, /script length/)
  assert.equal((await fetch(base + `/api/jobs/${invalid.id}/video`)).status, 409)
  console.log(`Verified draft editing, duplicate approval, killed render-worker recovery, playback range, failed-job handling, and 120-second download: ${file}`)
} finally {
  await stopWorker('SIGTERM')
  await db.end()
}
