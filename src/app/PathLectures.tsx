import { useEffect, useMemo, useState } from 'react'
import { useAudio, type Track } from './audio.ts'
import { LECTURE_LENGTHS, voiceLabel } from './prompts.ts'
import type { Store } from './store.ts'
import {
  lectureSections,
  type Batch,
  type BatchItem,
  type BatchOptions,
  type Extra,
  type LectureBody,
  type LectureLength,
  type Path,
  type Teacher,
  type Thoroughness,
} from './types.ts'

const LEVELS: [Thoroughness, string, string][] = [
  ['fast', 'Fast', 'Write only'],
  ['checked', 'Checked', 'Fact-check'],
  ['thorough', 'Thorough', 'Check + fix'],
]

const OPTS = 'batch-opts'
const DEFAULTS: BatchOptions & { length: LectureLength } = { level: 'checked', record: true, voice: 0, redo: false, length: 'medium' }

interface Props {
  path: Path
  store: Store
  teacher: Teacher
  /** this path's batch, if one has run this session */
  batch: Batch | null
  /** another path's batch is running (one at a time) */
  busyElsewhere: boolean
  loadChapters: (p: Path) => Promise<BatchItem[]>
  onStart: (items: BatchItem[], opts: BatchOptions) => void
  onStop: () => void
  onClose: () => void
}

/**
 * A whole path in a few taps: pick chapters, how thorough, how long; it writes, checks and
 * records them all in the background. Then play them in order or queue them.
 */
export function PathLectures({ path, store, teacher, batch, busyElsewhere, loadChapters, onStart, onStop, onClose }: Props) {
  const audio = useAudio()
  const [chapters, setChapters] = useState<BatchItem[] | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [opts, setOpts] = useState(() => {
    try {
      return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(OPTS) ?? '{}') as Partial<typeof DEFAULTS>) }
    } catch {
      return DEFAULTS
    }
  })
  const [lectures, setLectures] = useState<Extra[]>([])
  const running = !!batch?.running

  const setOpt = (patch: Partial<typeof DEFAULTS>) => {
    const next = { ...opts, ...patch }
    setOpts(next)
    try {
      localStorage.setItem(OPTS, JSON.stringify(next))
    } catch {
      /* private mode: kept for this visit */
    }
  }

  useEffect(() => {
    let live = true
    loadChapters(path)
      .then((list) => {
        if (!live) return
        // a batch from this session keeps its lengths
        const lens = new Map(batch?.items.map((i) => [i.id, i.length]))
        setChapters(list.map((c) => ({ ...c, length: lens.get(c.id) ?? opts.length })))
        setPicked(new Set(batch?.items.map((i) => i.id) ?? list.map((c) => c.id)))
      })
      .catch((e) => live && setLoadErr(e instanceof Error ? e.message : 'Could not load the chapters.'))
    return () => {
      live = false
    }
    // load once per opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path.id])

  // every lecture, refreshed as the batch records new ones
  const madeIds = batch?.items.map((i) => i.lectureId ?? '').join(',') ?? ''
  useEffect(() => {
    void store.extrasOfKind('lecture').then(setLectures).catch(() => {})
  }, [store, madeIds])

  /** newest whole-chapter lecture per chapter (the batch's own one first) */
  const lectureOf = useMemo(() => {
    const m = new Map<string, Extra>()
    for (const x of lectures) if (!lectureSections(x.body as LectureBody).length) m.set(x.node_id, x)
    for (const i of batch?.items ?? []) {
      const own = i.lectureId && lectures.find((x) => x.id === i.lectureId)
      if (own) m.set(i.id, own)
    }
    return m
  }, [lectures, batch])

  const statusOf = (id: string) => batch?.items.find((i) => i.id === id)?.status ?? ''
  const list = chapters ?? []
  const chosen = list.filter((c) => picked.has(c.id))
  const tracks: Track[] = chosen.flatMap((c) => {
    const x = lectureOf.get(c.id)
    if (!x) return []
    const b = x.body as LectureBody
    return [{ id: x.id, url: b.audioUrl, title: c.title, subtitle: c.sub || path.title, fileName: b.fileName }]
  })
  const done = batch?.items.filter((i) => i.status === '✓ Done').length ?? 0
  const failed = batch?.items.filter((i) => i.status.startsWith('failed')).length ?? 0
  const total = batch?.items.length ?? 0

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const setLength = (id: string, length: LectureLength) => setChapters((cs) => cs && cs.map((c) => (c.id === id ? { ...c, length } : c)))

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet batch-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Path lectures">
        <div className="sheet-top">
          <h2>🎧 Path lectures</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="sheet-note">{path.title}</p>

        {loadErr && <p className="error">{loadErr}</p>}
        {!chapters && !loadErr && <p className="sheet-note">Loading chapters…</p>}
        {chapters && !list.length && <p className="sheet-note">This path has no chapters yet.</p>}

        {list.length > 0 && (
          <>
            <div className="batch-head">
              <h3 className="sheet-sub">
                Chapters · {picked.size}/{list.length}
              </h3>
              <button className="reveal" onClick={() => setPicked(new Set(list.map((c) => c.id)))} disabled={running}>
                All
              </button>
              <button className="reveal" onClick={() => setPicked(new Set())} disabled={running}>
                None
              </button>
            </div>
            <div className="pick-list batch-list">
              {list.map((c) => {
                const st = statusOf(c.id)
                const has = lectureOf.get(c.id)
                const hasLen = has && (has.body as LectureBody).length
                return (
                  <div key={c.id} className={`batch-row ${picked.has(c.id) ? 'on' : ''}`}>
                    <label>
                      <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} disabled={running} />
                      <span className="batch-title">
                        {c.title}
                        <small>
                          {c.sub}
                          {has && !st ? ` · 🎧 ${hasLen ? LECTURE_LENGTHS[hasLen].label : 'recorded'}` : ''}
                        </small>
                      </span>
                    </label>
                    {st && <span className={`batch-status ${st.startsWith('failed') ? 'failed' : st === '✓ Done' ? 'ok' : ''}`}>{st}</span>}
                    {opts.record && (
                      <select value={c.length} onChange={(e) => setLength(c.id, e.target.value as LectureLength)} disabled={running} aria-label="Lecture length">
                        {(Object.keys(LECTURE_LENGTHS) as LectureLength[]).map((k) => (
                          <option key={k} value={k}>
                            {LECTURE_LENGTHS[k].label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )
              })}
            </div>

            <h3 className="sheet-sub">How thorough</h3>
            <div className="seg" role="radiogroup" aria-label="How thorough">
              {LEVELS.map(([k, label, hint]) => (
                <button key={k} role="radio" aria-checked={opts.level === k} className={opts.level === k ? 'on' : ''} onClick={() => setOpt({ level: k })} disabled={running}>
                  {label}
                  <small>{hint}</small>
                </button>
              ))}
            </div>

            <label className="batch-check">
              <input type="checkbox" checked={opts.record} onChange={(e) => setOpt({ record: e.target.checked })} disabled={running} />
              Record lectures
            </label>
            {opts.record && (
              <>
                <h3 className="sheet-sub">Length (all chapters)</h3>
                <div className="seg" role="radiogroup" aria-label="Length">
                  {(Object.keys(LECTURE_LENGTHS) as LectureLength[]).map((k) => (
                    <button
                      key={k}
                      role="radio"
                      aria-checked={opts.length === k}
                      className={opts.length === k ? 'on' : ''}
                      disabled={running}
                      onClick={() => {
                        setOpt({ length: k })
                        setChapters((cs) => cs && cs.map((c) => ({ ...c, length: k })))
                      }}
                    >
                      {LECTURE_LENGTHS[k].label}
                      <small>~{LECTURE_LENGTHS[k].minutes} min</small>
                    </button>
                  ))}
                </div>
                {teacher.second && (
                  <div className="seg two" role="radiogroup" aria-label="Voice">
                    {[teacher.voice, teacher.second.voice].map((v, i) => (
                      <button key={i} role="radio" aria-checked={opts.voice === i} className={opts.voice === i ? 'on' : ''} onClick={() => setOpt({ voice: i as 0 | 1 })} disabled={running}>
                        Voice {i + 1}
                        <small>{voiceLabel(v)}</small>
                      </button>
                    ))}
                  </div>
                )}
                <label className="batch-check">
                  <input type="checkbox" checked={opts.redo} onChange={(e) => setOpt({ redo: e.target.checked })} disabled={running} />
                  Record again where a lecture of that length already exists
                </label>
              </>
            )}

            {running ? (
              <div className="batch-run">
                <div className="lect-bar" aria-hidden="true">
                  <div style={{ width: `${total ? ((done + failed) / total) * 100 : 0}%` }} />
                </div>
                <p className="sheet-note">
                  {done}/{total} done{failed ? ` · ${failed} failed` : ''}
                  {batch?.stopping ? ' · stopping after the chapters in progress…' : ''}
                </p>
                <button className="btn-ghost" onClick={onStop} disabled={batch?.stopping}>
                  Stop
                </button>
              </div>
            ) : (
              <button
                className="btn-neon record-btn"
                disabled={!chosen.length || busyElsewhere}
                onClick={() => onStart(chosen, { level: opts.level, record: opts.record, voice: teacher.second ? opts.voice : 0, redo: opts.redo })}
              >
                {busyElsewhere ? 'Another path is running' : `Start · ${chosen.length} chapter${chosen.length === 1 ? '' : 's'}`}
              </button>
            )}
            {!running && batch && (
              <p className="sheet-note">
                Last run: {done}/{total} done{failed ? ` · ${failed} failed (Start again to retry them)` : ''}.
              </p>
            )}
            <p className="sheet-note">
              Runs in the background; close this and keep going. Keep the app open until it finishes. If it stops, press Start
              again: finished work is skipped.
            </p>

            <h3 className="sheet-sub">Listen</h3>
            {!tracks.length && <p className="sheet-note">No lectures for these chapters yet.</p>}
            {tracks.length > 0 && (
              <div className="batch-listen">
                <button className="btn-neon" onClick={() => audio.playAll(tracks)}>
                  ▶ Play all ({tracks.length})
                </button>
                <button className="btn-ghost" onClick={() => audio.enqueue(tracks)}>
                  + Queue all
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
