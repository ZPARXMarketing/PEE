import { useEffect, useMemo, useRef, useState } from 'react'
import { looksLikeKey, pcmToWav, speak, speechModels, type Settings } from './generate.ts'
import { DEFAULT_MODEL, DEFAULT_VOICE, SPEECH_MODEL, STYLES, costLabel, sortVoices, takesStyle, voiceLabel, type SpeechModel } from './prompts.ts'
import type { Bucket, Teacher, TeacherVoice } from './types.ts'
import { InstallButton } from './InstallButton.tsx'
import { TextSizeSetting } from './TextSize.tsx'

interface Props {
  settings: Settings
  mode?: 'cloud' | 'device'
  teacher: Teacher
  onTeacher: (t: Teacher) => void
  onSave: (s: Settings) => void
  onClose: () => void
  buckets: Bucket[]
  onSaveBucket: (b: Bucket) => void
  showUsage: boolean
  onShowUsage: (on: boolean) => void
}

const PALETTE = ['#ff9f43', '#c9a7ff', '#7ee081', '#ff5c7a', '#f7f06d', '#5ad1c4', '#ffffff']

/** 20 ms of silent WAV, played inside the tap to unlock audio on Safari */
const SILENCE =
  'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SAMPLE = "Hi, I'm your teacher for this course. Let's start with the one idea that makes everything else in this chapter click."

export function SettingsSheet({
  settings,
  mode,
  teacher,
  onTeacher,
  onSave,
  onClose,
  buckets,
  onSaveBucket,
  showUsage,
  onShowUsage,
}: Props) {
  const [draft, setDraft] = useState(settings)
  const [t, setT] = useState(teacher)
  const [previewing, setPreviewing] = useState(false)
  const [previewErr, setPreviewErr] = useState('')
  /** voice+style → sample audio, so replaying a preview costs nothing */
  const samples = useRef(new Map<string, string>())
  const audio = useRef<HTMLAudioElement | null>(null)
  /** voice models OpenRouter offers right now (falls back to the built-in list) */
  const [models, setModels] = useState<SpeechModel[]>([])
  const [defaultModel, setDefaultModel] = useState(SPEECH_MODEL)
  useEffect(() => {
    void speechModels(settings)
      .then((r) => {
        setModels(r.models)
        setDefaultModel(r.defaultModel)
      })
      .catch(() => {})
  }, [settings])
  /** which voice the pickers edit: 0 = voice 1, 1 = voice 2 (starts as a copy of voice 1) */
  const [slot, setSlot] = useState<0 | 1>(0)
  const v: TeacherVoice = slot === 1 ? (t.second ?? { voice: t.voice, style: t.style, model: t.model }) : t
  const setV = (patch: Partial<TeacherVoice>) =>
    setT((cur) =>
      slot === 1
        ? { ...cur, second: { ...(cur.second ?? { voice: cur.voice, style: cur.style, model: cur.model }), ...patch } }
        : { ...cur, ...patch },
    )
  const model = v.model || defaultModel
  const live = useMemo(() => sortVoices(models.find((m) => m.id === model)?.voices ?? []), [models, model])
  const voices = live.length ? live : [v.voice || DEFAULT_VOICE]
  const styled = takesStyle(model)
  // a saved voice the current model doesn't offer would fail; pick the first one it does
  useEffect(() => {
    if (live.length && !live.includes(v.voice)) setV({ voice: live[0] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, v.voice])

  const preview = async () => {
    const k = `${model}:${v.voice}:${v.style}`
    setPreviewErr('')
    // Safari only lets audio start inside the tap; a slow voice model outlasts it. Start one
    // element playing silence now, then hand it the sample once it arrives.
    audio.current?.pause()
    const el = (audio.current ??= new Audio())
    el.src = SILENCE
    void el.play().catch(() => {})
    try {
      let url = samples.current.get(k)
      if (!url) {
        setPreviewing(true)
        const clip = await speak({ text: SAMPLE, voice: v.voice, style: v.style, model }, draft)
        // raw PCM (Gemini) won't play on its own; wrap it as WAV
        url = URL.createObjectURL(/pcm|l16/i.test(clip.type) ? await pcmToWav([clip]) : clip)
        samples.current.set(k, url)
      }
      el.src = url
      el.playbackRate = t.speed
      await el.play()
    } catch (e) {
      // the sample is cached, so a second tap plays it straight away
      if (e instanceof DOMException && e.name === 'NotAllowedError') setPreviewErr('Voice ready. Tap Preview again to play it.')
      else setPreviewErr(e instanceof Error ? e.message : 'Preview failed.')
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          audio.current?.pause()
          onTeacher(t)
          onSave({
            openRouterKey: looksLikeKey(draft.openRouterKey) ? draft.openRouterKey.trim() : '',
            model: draft.model.trim() || DEFAULT_MODEL,
          })
        }}
      >
        <h2>Settings</h2>

        <h3 className="sheet-sub">Highlighter buckets</h3>
        <p className="sheet-note">
          Select text in a chapter to save it into one of these. Each has its own name and colour; the Library can
          filter and group by them. Synced to all your devices.
        </p>
        <div className="bucket-list">
          {buckets
            .filter((b) => !b.archived)
            .map((b) => (
              <div key={b.key} className="bucket-row" style={{ '--hl': b.color } as React.CSSProperties}>
                <input
                  type="color"
                  defaultValue={b.color}
                  key={b.color}
                  onBlur={(e) => e.target.value !== b.color && onSaveBucket({ ...b, color: e.target.value })}
                  onChange={(e) => {
                    // the native picker fires "change" when it closes; save then
                    if ((e.nativeEvent as InputEvent).type === 'change') onSaveBucket({ ...b, color: e.target.value })
                  }}
                  aria-label={`${b.name} colour`}
                />
                <input
                  className="bucket-name"
                  defaultValue={b.name}
                  key={b.name}
                  maxLength={60}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      ;(e.target as HTMLInputElement).blur()
                    }
                  }}
                  onBlur={(e) => {
                    const name = e.target.value.trim()
                    if (name && name !== b.name) onSaveBucket({ ...b, name })
                  }}
                  aria-label="Bucket name"
                />
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    if (confirm(`Hide "${b.name}" from the highlighter? Its saved highlights stay in the Library.`))
                      onSaveBucket({ ...b, archived: true })
                  }}
                >
                  Hide
                </button>
              </div>
            ))}
        </div>
        <div className="bucket-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              const used = new Set(buckets.map((b) => b.color.toLowerCase()))
              onSaveBucket({
                key: `b${Date.now().toString(36)}`,
                name: 'New bucket',
                color: PALETTE.find((c) => !used.has(c)) ?? '#ffffff',
                position: Math.max(0, ...buckets.map((b) => b.position)) + 1,
                archived: false,
              })
            }}
          >
            + Add bucket
          </button>
          {buckets.some((b) => b.archived) && (
            <select
              className="bucket-restore"
              value=""
              onChange={(e) => {
                const b = buckets.find((x) => x.key === e.target.value)
                if (b) onSaveBucket({ ...b, archived: false })
              }}
              aria-label="Show a hidden bucket again"
            >
              <option value="">Show a hidden bucket…</option>
              {buckets
                .filter((b) => b.archived)
                .map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.name}
                  </option>
                ))}
            </select>
          )}
        </div>

        <h3 className="sheet-sub">Teacher voices</h3>
        <div className="seg two" role="radiogroup" aria-label="Which voice">
          {(['Voice 1', 'Voice 2'] as const).map((label, i) => (
            <button key={label} type="button" role="radio" aria-checked={slot === i} className={slot === i ? 'on' : ''} onClick={() => setSlot(i as 0 | 1)}>
              {label}
              <small>{i === 0 ? voiceLabel(t.voice) : t.second ? voiceLabel(t.second.voice) : 'not set'}</small>
            </button>
          ))}
        </div>
        {models.length > 1 && (
          <label>
            Voice model
            <select value={model} onChange={(e) => setV({ model: e.target.value === defaultModel ? undefined : e.target.value })}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {costLabel(m) && ` · ${costLabel(m)}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="sheet-grid">
          <label>
            Voice
            <select value={v.voice} onChange={(e) => setV({ voice: e.target.value })}>
              {voices.map((v) => (
                <option key={v} value={v}>
                  {voiceLabel(v)}
                </option>
              ))}
            </select>
          </label>
          <label hidden={!styled}>
            Style
            <select value={v.style} onChange={(e) => setV({ style: e.target.value })}>
              {Object.entries(STYLES).map(([k, s]) => (
                <option key={k} value={k}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Speed
            <select value={t.speed} onChange={(e) => setT({ ...t, speed: Number(e.target.value) })}>
              {[0.75, 1, 1.25, 1.5, 2].map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="button" className="btn-ghost preview-btn" onClick={() => void preview()} disabled={previewing}>
          {previewing ? 'Loading…' : '▶ Preview voice'}
        </button>
        {slot === 1 && t.second && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setT(({ second: _, ...rest }) => rest)
              setSlot(0)
            }}
          >
            Remove voice 2
          </button>
        )}
        {previewErr && <p className="error">{previewErr}</p>}
        <p className="sheet-note">Synced to all your devices. Applies to new lectures; existing ones keep their voice.</p>

        <h3 className="sheet-sub">AI</h3>
        <label>
          OpenRouter key <small>optional: leave blank to use the site's key</small>
          {/* plain text field masked with CSS so browsers don't autofill the site password into it */}
          <span className="key-row">
            <input
              type="text"
              className="secret"
              name="openrouter-api-key"
              value={draft.openRouterKey}
              onChange={(e) => setDraft({ ...draft, openRouterKey: e.target.value })}
              placeholder="sk-or-…"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
            />
            {draft.openRouterKey && (
              <button type="button" className="btn-ghost" onClick={() => setDraft({ ...draft, openRouterKey: '' })}>
                Clear
              </button>
            )}
          </span>
        </label>
        {draft.openRouterKey && !looksLikeKey(draft.openRouterKey) && (
          <p className="error">That isn't an OpenRouter key (they start with sk-or-). It won't be saved; the site's key is used.</p>
        )}
        <label>
          Model
          <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
        </label>
        <p className="sheet-note">
          Storage: {mode === 'cloud' ? 'synced to Supabase.' : 'this device only (Supabase tables not set up yet).'}
        </p>
        <label className="check-row">
          <input type="checkbox" checked={showUsage} onChange={(e) => onShowUsage(e.target.checked)} />
          Show API spend (all time · week · day) in the top right
        </label>
        <div className="setting-row">
          <span>Text size (this device)</span>
          <TextSizeSetting />
        </div>
        <InstallButton className="btn-ghost" />
        <p className="sheet-note">
          <a className="lock-link" href="/__logout">
            Lock this device
          </a>{' '}
          (asks for the site password again)
        </p>
        <div className="sheet-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-neon">Save</button>
        </div>
      </form>
    </div>
  )
}
