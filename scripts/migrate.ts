import {db} from '../src/db.ts'

try {
  await db.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id uuid PRIMARY KEY, topic text NOT NULL, minutes integer NOT NULL CHECK (minutes BETWEEN 2 AND 5),
      mode text NOT NULL CHECK (mode IN ('demo','hosted')), draft text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), approval_key uuid NOT NULL,
      topic text NOT NULL, minutes integer NOT NULL, mode text NOT NULL, script text NOT NULL,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed')),
      stage text NOT NULL DEFAULT 'Waiting for worker', progress integer NOT NULL DEFAULT 0,
      error text, epoch integer NOT NULL DEFAULT 0, attempt integer NOT NULL DEFAULT 0,
      lease_until timestamptz, export_key text, paid_started boolean NOT NULL DEFAULT false,
      voice_key text, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, approval_key), CHECK ((status = 'ready') = (export_key IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_project ON jobs (project_id)
      WHERE status IN ('queued','running','ready');
    CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (created_at) WHERE status IN ('queued','running');
  `)
  console.log('Cutline database initialized.')
} finally {
  await db.end()
}
