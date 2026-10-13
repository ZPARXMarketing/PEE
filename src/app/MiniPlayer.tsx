import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AudioCtx, clock, type AudioApi, type Progress, type Track } from './audio.ts'
import type { Store } from './store.ts'

const SPEEDS = [0.75, 1, 1.25, 1.5, 2]
const PREF = 'listening'
const QUEUE = 'queue'

/**
 * Owns the one <audio> element for the whole app, so a lecture keeps playing when its
 * sheet closes, you change chapter, or open the Library. Remembers where you stopped
 * in every lecture and which ones you finished (synced across devices), and wires up
 * lock-screen / headphone controls.
 */
export function AudioProvider({ store, speed, children }: { store: Store | null; speed: number; children: ReactNode }) {
  const el = useRef<HTMLAudioElement | null>(null)
  const [current, setCurrent] = useState<Track | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRateState] = useState(speed)
  const [listen, setListen] = useState<Record<string, Progress>>({})
  const listenRef = useRef(listen)
  listenRef.current = listen
  const lastSave = useRef(0)
  const resumeAt = useRef(0)
  const [queue, setQueue] = useState<Track[]>([])
  const queueRef = useRef(queue)
  queueRef.current = queue
  /** the synced queue has loaded, so changes can be saved without wiping it */
  const queueLoaded = useRef(false)

  useEffect(() => setRateState(speed), [speed])

  useEffect(() => {
    if (!store) return
    void store
      .pref<Record<string, Progress>>(PREF)
      .then((p) => p && setListen((cur) => ({ ...p, ...cur })))
      .catch(() => {})
    void store
      .pref<Track[]>(QUEUE)
      .then((q) => {
        if (Array.isArray(q)) setQueue((cur) => [...cur, ...q.filter((t) => !cur.some((c) => c.id === t.id))])
      })
      .catch(() => {})
      .finally(() => (queueLoaded.current = true))
  }, [store])

  useEffect(() => {
    if (store && queueLoaded.current) void store.setPref(QUEUE, queue).catch(() => {})
  }, [store, queue])

  const persist = useCallback(
    (force = false) => {
      if (!store || (!force && Date.now() - lastSave.current < 15000)) return
      lastSave.current = Date.now()
      void store.setPref(PREF, listenRef.current).catch(() => {})
    },
    [store],
  )

  /** Record where we are in the current lecture. */
  const mark = useCallback(
    (done?: boolean) => {
      const a = el.current
      if (!a || !current || !Number.isFinite(a.duration)) return
      const finished = done || a.currentTime >= a.duration * 0.95
      setListen((m) => ({
        ...m,
        [current.id]: {
          pos: finished ? 0 : a.currentTime,
          dur: a.duration,
          done: finished || !!m[current.id]?.done,
          at: new Date().toISOString(),
        },
      }))
    },
    [current],
  )

  useEffect(() => {
    const save = () => {
      if (document.visibilityState === 'hidden') {
        mark()
        persist(true)
      }
    }
    document.addEventListener('visibilitychange', save)
    return () => document.removeEventListener('visibilitychange', save)
  }, [mark, persist])

  const play = useCallback(
    (t: Track) => {
      const a = el.current
      if (!a) return
      setQueue((q) => (q.some((x) => x.id === t.id) ? q.filter((x) => x.id !== t.id) : q))
      if (current?.id === t.id) {
        void a.play()
        return
      }
      if (current) {
        mark()
        persist(true)
      }
      const p = listenRef.current[t.id]
      resumeAt.current = p && !p.done && p.pos > 5 && p.pos < p.dur - 5 ? p.pos : 0
      setCurrent(t)
      setPosition(resumeAt.current)
      setDuration(p?.dur ?? 0)
      a.src = t.url
      a.playbackRate = rate
      void a.play().catch(() => setPlaying(false))
    },
    [current, mark, persist, rate],
  )

  const next = useCallback(() => {
    const t = queueRef.current[0]
    if (t) play(t)
  }, [play])
  const nextRef = useRef(next)
  nextRef.current = next

  // lock screen / headphones
  useEffect(() => {
    if (!('mediaSession' in navigator) || !current) return
    const ms = navigator.mediaSession
    ms.metadata = new MediaMetadata({ title: current.title, artist: current.subtitle, album: 'Expertise Engine' })
    const a = el.current
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, fn)
      } catch {
        /* action not supported on this device */
      }
    }
    set('play', () => void a?.play())
    set('pause', () => a?.pause())
    set('seekbackward', () => a && (a.currentTime = Math.max(0, a.currentTime - 15)))
    set('seekforward', () => a && (a.currentTime = Math.min(a.duration || 0, a.currentTime + 15)))
    set('seekto', (d) => a && d.seekTime !== undefined && (a.currentTime = d.seekTime))
    set('nexttrack', queue.length ? () => nextRef.current() : null)
  }, [current, queue.length])

  const api: AudioApi = useMemo(
    () => ({
      current,
      playing,
      position,
      duration,
      rate,
      play,
      toggle: () => {
        const a = el.current
        if (!a || !current) return
        if (a.paused) void a.play()
        else a.pause()
      },
      seek: (s) => {
        const a = el.current
        if (a) a.currentTime = Math.max(0, Math.min(a.duration || s, s))
      },
      skip: (d) => {
        const a = el.current
        if (a) a.currentTime = Math.max(0, Math.min(a.duration || 0, a.currentTime + d))
      },
      setRate: (r) => {
        setRateState(r)
        if (el.current) el.current.playbackRate = r
      },
      close: () => {
        mark()
        persist(true)
        el.current?.pause()
        setCurrent(null)
      },
      progress: (id) => listen[id],
      queue,
      enqueue: (tracks) =>
        setQueue((q) => [...q, ...tracks.filter((t, i) => t.id !== current?.id && !q.some((x) => x.id === t.id) && tracks.findIndex((y) => y.id === t.id) === i)]),
      playAll: (tracks) => {
        if (!tracks.length) return
        const ids = new Set(tracks.map((t) => t.id))
        setQueue((q) => [...tracks.slice(1), ...q.filter((x) => !ids.has(x.id))])
        play(tracks[0])
      },
      dequeue: (id) => setQueue((q) => q.filter((x) => x.id !== id)),
      moveQueued: (id, by) =>
        setQueue((q) => {
          const i = q.findIndex((x) => x.id === id)
          const j = i + by
          if (i < 0 || j < 0 || j >= q.length) return q
          const n = [...q]
          ;[n[i], n[j]] = [n[j], n[i]]
          return n
        }),
      clearQueue: () => setQueue([]),
      next,
    }),
    [current, playing, position, duration, rate, play, mark, persist, listen, queue, next],
  )

  return (
    <AudioCtx.Provider value={api}>
      {children}
      <audio
        ref={el}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false)
          mark()
          persist(true)
        }}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget
          setDuration(a.duration)
          a.playbackRate = rate
          if (resumeAt.current) a.currentTime = resumeAt.current
          resumeAt.current = 0
        }}
        onTimeUpdate={(e) => {
          setPosition(e.currentTarget.currentTime)
          mark()
          persist()
        }}
        onEnded={() => {
          setPlaying(false)
          mark(true)
          persist(true)
          nextRef.current()
        }}
      />
      {(current || queue.length > 0) && <Bar api={api} />}
    </AudioCtx.Provider>
  )
}

/** The bar pinned to the bottom of the screen while a lecture is loaded. */
function Bar({ api }: { api: AudioApi }) {
  const { current, playing, position, duration, rate, queue } = api
  const [showQueue, setShowQueue] = useState(false)
  const next = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length] ?? 1
  const queueBtn = (
    <button className={`mp-queue ${showQueue ? 'on' : ''}`} onClick={() => setShowQueue((v) => !v)} aria-expanded={showQueue} aria-label="Up next">
      ☰ {queue.length}
    </button>
  )
  const list = showQueue && <QueueList api={api} onClose={() => setShowQueue(false)} />
  if (!current)
    return (
      <div className="mini-player idle" role="region" aria-label="Lecture queue">
        {list}
        <div className="mp-info">
          <div className="mp-title">🎧 {queue.length} queued</div>
          <div className="mp-sub">Next: {queue[0]?.title}</div>
        </div>
        <div className="mp-controls">
          {queueBtn}
          <button className="mp-play" onClick={api.next} aria-label="Play the queue">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>
    )
  return (
    <div className="mini-player" role="region" aria-label="Lecture player">
      {list}
      <div className="mp-info">
        <div className="mp-title">🎧 {current.title}</div>
        <div className="mp-sub">{current.subtitle}</div>
      </div>
      <div className="mp-controls">
        <button onClick={() => api.skip(-15)} aria-label="Back 15 seconds">
          ↺15
        </button>
        <button className="mp-play" onClick={api.toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
              <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" />
            </svg>
          )}
        </button>
        <button onClick={() => api.skip(15)} aria-label="Forward 15 seconds">
          15↻
        </button>
        <button className="mp-speed" onClick={() => api.setRate(next)} aria-label={`Speed ${rate}×, tap for ${next}×`}>
          {rate}×
        </button>
        {queueBtn}
      </div>
      <div className="mp-seek">
        <span>{clock(position)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={1}
          value={Math.min(position, duration || 0)}
          onChange={(e) => api.seek(Number(e.target.value))}
          aria-label="Position"
        />
        <span>{clock(duration)}</span>
      </div>
      <button className="mp-close" onClick={api.close} aria-label="Close player">
        ×
      </button>
    </div>
  )
}

/** Up next: reorder, remove, skip to one, clear. */
function QueueList({ api, onClose }: { api: AudioApi; onClose: () => void }) {
  const { queue } = api
  return (
    <div className="mp-queue-list" role="dialog" aria-label="Up next">
      <div className="mpq-head">
        <b>Up next ({queue.length})</b>
        {queue.length > 0 && (
          <button className="reveal" onClick={() => confirm('Clear the whole queue?') && api.clearQueue()}>
            Clear
          </button>
        )}
        <button className="mpq-x" onClick={onClose} aria-label="Close queue">
          ×
        </button>
      </div>
      {!queue.length && <p className="sheet-note">Nothing queued. Tap + Queue on any lecture, or queue a whole path.</p>}
      <ol>
        {queue.map((t, i) => (
          <li key={t.id}>
            <button className="mpq-play" onClick={() => api.play(t)} title="Play now">
              <span className="mpq-title">{t.title}</span>
              <span className="mpq-sub">{t.subtitle}</span>
            </button>
            <button onClick={() => api.moveQueued(t.id, -1)} disabled={i === 0} aria-label="Move up">
              ↑
            </button>
            <button onClick={() => api.moveQueued(t.id, 1)} disabled={i === queue.length - 1} aria-label="Move down">
              ↓
            </button>
            <button onClick={() => api.dequeue(t.id)} aria-label="Remove from queue">
              ×
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
