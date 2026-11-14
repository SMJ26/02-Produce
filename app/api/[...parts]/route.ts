import {randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {stat} from 'node:fs/promises'
import {Readable} from 'node:stream'
import {db, publicJob, type Job} from '../../../src/db.ts'
import {checkScript, requireHosted, scripts, type Brief} from '../../../src/providers.ts'
import {media} from '../../../src/storage.ts'

export const runtime = 'nodejs'
type Context = {params: Promise<{parts: string[]}>}
type Project = Brief & {id: string; draft: string}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const json = (data: unknown, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store'}})
const problem = (error: string, status = 400) => json({error}, status)
const unavailable = (error: unknown) => {
  console.error(error)
  return problem('Studio could not access local storage or Postgres. Check the setup and server logs.', 503)
}

export async function POST(request: Request, {params}: Context) {
  const origin = request.headers.get('origin')
  if (origin && new URL(origin).host !== request.headers.get('host'))
    return problem('Open Studio on its local address.', 403)
  const parts = await params.then(p => p.parts)
  const source = await request.text()
  if (source.length > 32_000) return problem('Request is too large.', 413)
  let body
  try { body = JSON.parse(source) } catch { return problem('Invalid JSON.') }
  if (!body || typeof body !== 'object') return problem('Invalid request.')
  try {
    if (parts.join('/') === 'projects') {
      const {topic, minutes, mode} = body as Brief
      if (typeof topic !== 'string' || topic.trim().length < 3 || topic.length > 120 ||
          /\S{47}|[\x00-\x1f]/u.test(topic) || !Number.isInteger(minutes) || minutes < 2 || minutes > 5 ||
          (mode !== 'demo' && mode !== 'hosted'))
        return problem('Enter a topic of 3–120 characters and select 2–5 minutes.')
      let draft
      try { draft = await scripts[mode].draft({topic: topic.trim(), minutes, mode}) }
      catch (error) { return problem((error as Error).message, 422) }
      const result = await db.query<Project>(
        'INSERT INTO projects (id, topic, minutes, mode, draft) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [randomUUID(), topic.trim(), minutes, mode, draft])
      return json(result.rows[0], 201)
    }
    if (parts.length !== 3 || parts[0] !== 'projects' || !uuid.test(parts[1]) || parts[2] !== 'approve')
      return problem('Route not found.', 404)
    const [, id] = parts
    if (typeof body.key !== 'string' || !uuid.test(body.key)) return problem('Missing approval key.')
    let script
    try { script = checkScript(body.script) } catch (error) { return problem((error as Error).message) }
    const connection = await db.connect()
    try {
      await connection.query('BEGIN')
      const project = (await connection.query<Project>('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [id])).rows[0]
      if (!project) return problem('Project not found.', 404)
      const existing = (await connection.query<Job>(`SELECT * FROM jobs WHERE project_id = $1
        AND (approval_key = $2 OR status IN ('queued','running','ready')) ORDER BY created_at DESC LIMIT 1`,
      [id, body.key])).rows[0]
      if (existing)
        return existing.script === script ? json(publicJob(existing)) : problem('This project already has an approved script. Start a new draft for a different script.', 409)
      if (project.mode === 'hosted') {
        try { requireHosted('voice') } catch (error) { return problem((error as Error).message, 422) }
      }
      const result = await connection.query<Job>(`INSERT INTO jobs (id, project_id, approval_key, topic, minutes, mode, script)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(), id, body.key, project.topic, project.minutes, project.mode, script])
      await connection.query('COMMIT')
      return json(publicJob(result.rows[0]), 202)
    } finally {
      try { await connection.query('ROLLBACK') } finally { connection.release() }
    }
  } catch (error) { return unavailable(error) }
}

export async function GET(request: Request, {params}: Context) {
  const [collection, id, action, extra] = await params.then(p => p.parts)
  if (collection !== 'jobs' || !uuid.test(id ?? '') || extra || (action && action !== 'video'))
    return problem('Route not found.', 404)
  try {
    const job = (await db.query<Job>('SELECT * FROM jobs WHERE id = $1', [id])).rows[0]
    if (!job) return problem('Job not found.', 404)
    if (!action) return json(publicJob(job))
    if (job.status !== 'ready' || !job.export_key) return problem('Video is still processing.', 409)
    const file = media.path(job.export_key)
    const {size} = await stat(file)
    const headers = new Headers({
      'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
    })
    if (new URL(request.url).searchParams.has('download'))
      headers.set('Content-Disposition', 'attachment; filename="cutline-video.mp4"')
    const range = request.headers.get('range')
    let start = 0
    let end = size - 1
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      const invalid = () => new Response(null, {status: 416, headers: {'Content-Range': `bytes */${size}`}})
      if (!match || (!match[1] && !match[2])) return invalid()
      if (match[1]) {
        start = Number(match[1])
        if (match[2]) end = Math.min(end, Number(match[2]))
      } else {
        start = Math.max(0, size - Number(match[2]))
      }
      if (!Number.isSafeInteger(start) || start > end) return invalid()
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    }
    headers.set('Content-Length', String(end - start + 1))
    const stream = Readable.toWeb(createReadStream(file, {start, end})) as ReadableStream<Uint8Array>
    return new Response(stream, {status: range ? 206 : 200, headers})
  } catch (error) { return unavailable(error) }
}
