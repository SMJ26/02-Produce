import pg from 'pg'
import type {Brief} from './providers.ts'

const globalDb = globalThis as typeof globalThis & {cutlineDb?: pg.Pool}
export const db = globalDb.cutlineDb ??= new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://cutline:cutline-local@127.0.0.1:55432/cutline',
  connectionTimeoutMillis: 4000,
})

export interface Job extends Brief {
  id: string
  project_id: string
  script: string
  status: 'queued' | 'running' | 'ready' | 'failed'
  stage: string
  progress: number
  error: string | null
  attempt: number
  epoch: number
  export_key: string | null
  paid_started: boolean
  voice_key: string | null
}

export const lease = async (): Promise<Job | undefined> => {
  const {rows} = await db.query<Job>(`
    WITH next AS (
      SELECT id FROM jobs
      WHERE status = 'queued' OR (status = 'running' AND lease_until <= now())
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs j SET status = 'running', lease_until = now() + interval '12 seconds',
      epoch = epoch + 1, attempt = attempt + 1, stage = 'Starting', progress = 2
    FROM next WHERE j.id = next.id RETURNING j.*
  `)
  return rows[0]
}

export function owned(job: Job, changes: string, params: unknown[] = []) {
  return db.query(`UPDATE jobs SET ${changes}
    WHERE id = $1 AND epoch = $2 AND status = 'running' AND lease_until > now()`,
  [job.id, job.epoch, ...params])
}

export function publicJob(job: Job) {
  return {id: job.id, projectId: job.project_id, topic: job.topic, minutes: job.minutes,
    mode: job.mode, script: job.script, status: job.status, stage: job.stage, progress: job.progress,
    error: job.error, attempt: job.attempt, ready: job.status === 'ready' && Boolean(job.export_key)}
}
