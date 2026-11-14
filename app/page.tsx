'use client'

import {useEffect, useState, type FormEvent} from 'react'
import type {Mode} from '../src/providers.ts'

type Project = {id: string; topic: string; minutes: number; mode: Mode; draft: string}
type Job = {id: string; script: string; progress: number; status: 'queued' | 'running' | 'failed' | 'ready'; stage: string; error: string | null}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {cache: 'no-store'})
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Studio request failed.')
  return data
}

export default function Studio() {
  const [topic, setTopic] = useState('')
  const [minutes, setMinutes] = useState(2)
  const [mode, setMode] = useState<Mode>('demo')
  const [project, setProject] = useState<Project>()
  const [script, setScript] = useState('')
  const [key, setKey] = useState('')
  const [job, setJob] = useState<Job>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const step = job && job.status !== 'failed' ? 2 : project ? 1 : 0
  const words = script.trim().split(/\s+/u).filter(Boolean).length

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('cutline-project') || 'null')
      if (saved?.project) {
        setProject(saved.project)
        setScript(saved.script)
        setKey(saved.job?.status === 'failed' ? '' : saved.key || crypto.randomUUID())
        setJob(saved.job)
      }
    } catch { localStorage.removeItem('cutline-project') }
    setHydrated(true)
  }, [])
  useEffect(() => {
    if (hydrated) {
      if (project) localStorage.setItem('cutline-project', JSON.stringify({project, script, job, key}))
      else localStorage.removeItem('cutline-project')
    }
  }, [hydrated, project, script, job, key])
  useEffect(() => {
    if (!job || job.status === 'ready' || job.status === 'failed') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api<Job>(`/api/jobs/${job.id}`)
        if (!cancelled) {
          setJob(next)
          if (next.status === 'failed') setKey('')
          setError('')
          if (next.status === 'ready' || next.status === 'failed') return
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
      if (!cancelled) timer = setTimeout(poll, 1200)
    }
    timer = setTimeout(poll, 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [job?.id, job?.status])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    try {
      if (!project) {
        const draft = await api<Project>('/api/projects', {topic, minutes, mode})
        setProject(draft)
        setScript(draft.draft)
        setKey(crypto.randomUUID())
      } else {
        const approvalKey = key || crypto.randomUUID()
        setKey(approvalKey)
        const next = await api<Job>(`/api/projects/${project.id}/approve`, {key: approvalKey, script})
        setJob(next)
      }
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  return <>
    <header className="bar"><div className="bar-inner">
      <div className="brand"><span className="mark" aria-hidden="true">◩</span> Cutline<span className="brand-muted"> Studio</span></div>
      <span className="local"><span /> Local workspace</span>
    </div></header>
    <main>
      <div className="intro"><h1>Video studio</h1><p>Turn a topic into a narrated, captioned video.</p></div>
      <ol className="steps" aria-label="Workflow">
        {['Brief', 'Script', 'Export'].map((label, i) => <li key={label} className={i <= step ? 'active' : ''} aria-current={i === step ? 'step' : undefined}>
          <span>{i < step ? '✓' : i + 1}</span>{label}
        </li>)}
      </ol>
      <div className="grid">
        <section className="panel">
          {step < 2 ? <form onSubmit={submit}>
            <h2>{step === 0 ? 'What’s your video about?' : 'Review your script'}</h2>
            <p className="description">{step === 0 ? 'Choose a topic and a target length for your explainer.' : 'Edit the narration before approving it for synthesis.'}</p>
            {step === 0 ? <>
              <label htmlFor="topic">Topic</label>
              <input id="topic" placeholder="e.g. How the moon shapes the tides" required minLength={3} maxLength={120} value={topic} onChange={e => setTopic(e.target.value)} />
              <div className="fields">
                <div><label htmlFor="duration">Target duration</label><select id="duration" value={minutes} onChange={e => setMinutes(Number(e.target.value))}>
                  {[2, 3, 4, 5].map(n => <option key={n} value={n}>{n} minutes</option>)}</select></div>
                <div><label htmlFor="mode">Generation mode</label><select id="mode" value={mode} onChange={e => setMode(e.target.value as Mode)}>
                  <option value="demo">Demo · local fixtures</option><option value="hosted">Hosted providers</option></select></div>
              </div>
            </> : <>
              <label htmlFor="script">Narration script <span className="word-count">{words} words</span></label>
              <textarea id="script" required minLength={30} maxLength={7500} value={script} onChange={e => setScript(e.target.value)} />
              {job?.error && <p className="error" role="alert">{job.error}</p>}
            </>}
            <div className="actions">
              <button type="submit" disabled={busy || !hydrated}>{busy ? (project ? 'Queueing…' : 'Drafting…') : step === 0 ? 'Generate draft →' : job?.status === 'failed' ? 'Approve and retry →' : 'Approve and render →'}</button>
              {step === 1 && <button type="button" className="secondary" disabled={busy} onClick={() => { setProject(undefined); setJob(undefined); setError('') }}>Start over</button>}
            </div>
          </form> : <>
            <h2>{job?.status === 'ready' ? 'Your video is ready' : 'Creating your video'}</h2>
            <p className="description">{project?.topic}</p>
            {job?.status === 'ready' ? <>
              <video controls playsInline preload="metadata" aria-label="Generated video" src={`/api/jobs/${job.id}/video`} />
              <div className="actions"><a className="button" href={`/api/jobs/${job.id}/video?download=1`}>Download MP4 ↓</a>
                <button className="secondary" onClick={() => { setProject(undefined); setJob(undefined); setScript(''); setError('') }}>New video</button></div>
            </> : <div className="rendering" role="status">
              <div><span>{job?.stage}</span><strong>{job?.progress ?? 0}%</strong></div>
              <progress max={100} value={job?.progress ?? 0} aria-label="Render progress" />
              <p>{job?.status === 'queued' ? 'Start the worker with npm run worker if this job stays queued.' : 'You can refresh this page and return to the same job.'}</p>
            </div>}
          </>}
          {error && <p className="error" role="alert">{error}</p>}
        </section>
        <aside className="panel specs">
          <h2>Export settings</h2>
          <dl><div><dt>Format</dt><dd>MP4 · H.264</dd></div><div><dt>Resolution</dt><dd>1920 × 1080</dd></div>
            <div><dt>Narration</dt><dd>English</dd></div><div><dt>Captions</dt><dd>Burned in</dd></div></dl>
          <p>{(project?.mode ?? mode) === 'demo' ? 'Demo uses sample writing, a local synthesized voice, and original illustrated stills.' : 'Hosted drafting uses OpenAI. Approving the script starts ElevenLabs narration and may incur charges.'}</p>
        </aside>
      </div>
    </main>
  </>
}
