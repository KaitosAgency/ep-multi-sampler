import { useMemo, useRef, useState } from 'react'
import './App.css'
import { readWavInfo } from './audio/wavInfo'
import { playWavBlob, stopPlayback } from './audio/player'
import { exportAcDryKitWavPcm16 } from './audio/exportWav'
import { breadcrumbParts, buildFileTree, getNode, type FileEntry, type TreeNode } from './utils/fileTree'
import { useI18n } from './i18n/context'
import { languageNames, type Language } from './i18n/translations'

type MidiNote = 60 | 62 | 64 | 65 | 67 | 69 | 71 | 72

const ALLOWED_NOTES: readonly MidiNote[] = [60, 62, 64, 65, 67, 69, 71, 72] as const // C4, D4, E4, F4, G4, A4, B4, C5
const NOTE_LABEL: Record<MidiNote, string> = {
  60: 'C4',
  62: 'D4',
  64: 'E4',
  65: 'F4',
  67: 'G4',
  69: 'A4',
  71: 'B4',
  72: 'C5',
}

type AssignedSample = {
  file: File
  durationSec: number
}

function App() {
  const MAX_TOTAL_SECONDS = 20
  const { t, language, setLanguage, availableLanguages } = useI18n()

  const folderInputRef = useRef<HTMLInputElement>(null)

  const [pending, setPending] = useState<{ file: File; durationSec: number } | null>(null)
  const [assigned, setAssigned] = useState<Record<MidiNote, AssignedSample | undefined>>({
    60: undefined,
    62: undefined,
    64: undefined,
    65: undefined,
    67: undefined,
    69: undefined,
    71: undefined,
    72: undefined,
  })
  const [error, setError] = useState<string | null>(null)
  const [audioStatus, setAudioStatus] = useState<string | null>(null)
  const [exportSampleRate, setExportSampleRate] = useState<number>(22050)
  const [exportChannels, setExportChannels] = useState<1 | 2>(2)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [treeRoot, setTreeRoot] = useState<TreeNode | null>(null)
  const [currentPath, setCurrentPath] = useState<string>('') // '' = root
  const [browserQuery, setBrowserQuery] = useState<string>('') // filter current folder

  const assignedCount = useMemo(
    () => Object.values(assigned).filter(Boolean).length,
    [assigned],
  )

  const totalDurationSec = useMemo(
    () => Object.values(assigned).reduce((sum, slot) => sum + (slot?.durationSec ?? 0), 0),
    [assigned],
  )
  const isOverLimit = totalDurationSec > MAX_TOTAL_SECONDS + 1e-6
  const canExport = assignedCount > 0 && !isOverLimit

  function isWavFile(file: File): boolean {
    const nameOk = file.name.toLowerCase().endsWith('.wav')
    const typeOk = file.type === '' || file.type === 'audio/wav' || file.type === 'audio/x-wav'
    return nameOk && typeOk
  }

  async function onPickFolder(files: FileList | null) {
    setError(null)
    setAudioStatus(null)
    if (!files || files.length === 0) return

    const all: FileEntry[] = Array.from(files)
      .filter((f) => isWavFile(f))
      .map((file) => ({
        file,
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      }))

    if (all.length === 0) {
      setError(t('noWavFound'))
      setTreeRoot(null)
      setCurrentPath('')
      return
    }
    setTreeRoot(buildFileTree(all))
    setCurrentPath('')
    setBrowserQuery('')
  }

  function assignTo(note: MidiNote) {
    setError(null)
    setAudioStatus(null)
    if (!pending) {
      setError(t('chooseWavFirst'))
      return
    }

    const existing = assigned[note]
    const baseTotal = totalDurationSec - (existing?.durationSec ?? 0)
    const nextTotal = baseTotal + pending.durationSec
    if (nextTotal > MAX_TOTAL_SECONDS + 1e-6) {
      const remainingIfReplace = Math.max(0, MAX_TOTAL_SECONDS - baseTotal)
      setError(t('limitExceeded', { remaining: remainingIfReplace.toFixed(2) }))
      return
    }

    setAssigned((prev) => ({ ...prev, [note]: { file: pending.file, durationSec: pending.durationSec } }))
    setPending(null)
  }

  function removeFrom(note: MidiNote) {
    setError(null)
    setAudioStatus(null)
    setAssigned((prev) => ({ ...prev, [note]: undefined }))
  }

  function resetProject() {
    setError(null)
    setAudioStatus(null)
    setExportStatus(null)
    stopPlayback()
    setPending(null)
    setAssigned({
      60: undefined,
      62: undefined,
      64: undefined,
      65: undefined,
      67: undefined,
      69: undefined,
      71: undefined,
      72: undefined,
    })
  }

  async function onPlay(blob: Blob, label: string, silent = false) {
    setError(null)
    try {
      if (!silent) {
        setAudioStatus(`${t('reading')}: ${label}`)
      }
      await playWavBlob(blob)
      if (!silent) {
        setAudioStatus(null)
      }
    } catch (e) {
      if (!silent) {
        setAudioStatus(null)
      }
      setError(e instanceof Error ? `${t('cannotReadWav')}: ${e.message}` : t('cannotReadWav'))
    }
  }

  async function onExport() {
    setError(null)
    setAudioStatus(null)
    setExportStatus(null)

    if (isOverLimit) {
      setError(t('exportImpossibleDuration'))
      return
    }
    if (assignedCount === 0) {
      setError(t('exportImpossibleNoSamples'))
      return
    }

    // Export as a "kit" WAV (AcDry-like): needs note mapping for TNGE regions.
    const items: { note: number; file: Blob }[] = []
    for (const n of ALLOWED_NOTES) {
      const slot = assigned[n]
      if (slot) items.push({ note: n, file: slot.file })
    }

    try {
      setExportStatus(t('exportInProgress'))
      const { wavBytes, durationSec } = await exportAcDryKitWavPcm16(items, {
        sampleRate: exportSampleRate,
        channels: exportChannels,
      })
      if (durationSec > MAX_TOTAL_SECONDS + 1e-6) {
        setExportStatus(null)
        setError(t('exportImpossibleFinalDuration'))
        return
      }

      // Force an ArrayBuffer (not SharedArrayBuffer) for TS/DOM Blob typings.
      const ab = new Uint8Array(wavBytes).buffer
      const blob = new Blob([ab], { type: 'audio/wav' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ridiwave_export_${exportSampleRate}hz_${exportChannels === 2 ? 'stereo' : 'mono'}.wav`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)

      setExportStatus(null)
    } catch (e) {
      setExportStatus(null)
      setError(e instanceof Error ? `${t('exportFailed')}: ${e.message}` : t('exportFailed'))
    }
  }

  async function onClickBrowserFile(entry: FileEntry) {
    // Click = play + set pending for assignment
    setError(null)
    setAudioStatus(null)
    try {
      const info = await readWavInfo(entry.file)
      setPending({ file: entry.file, durationSec: info.durationSec })
      await onPlay(entry.file, entry.path, true) // Lecture silencieuse
    } catch (e) {
      setError(e instanceof Error ? e.message : t('cannotReadWav'))
    }
  }

  const currentNode = useMemo(() => {
    if (!treeRoot) return null
    return getNode(treeRoot, currentPath)
  }, [treeRoot, currentPath])

  const folderItems = useMemo(() => {
    if (!currentNode) return { dirs: [] as TreeNode[], files: [] as FileEntry[] }
    const dirs = Array.from(currentNode.dirs.values()).sort((a, b) => a.name.localeCompare(b.name))
    let files = currentNode.files
    const q = browserQuery.trim().toLowerCase()
    if (q) {
      files = files.filter((f) => f.path.toLowerCase().includes(q) || f.file.name.toLowerCase().includes(q))
    }
    return { dirs, files }
  }, [currentNode, browserQuery])

  return (
    <div className="app">
      <header className="header">
      <div className="headerTitle">
          <div className="title">
            {t('title')}
            <select
              className="languageSelect"
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
            >
              {availableLanguages.map((lang) => (
                <option key={lang} value={lang}>
                  {languageNames[lang]}
                </option>
              ))}
            </select>
          </div>
          <div className="subtitle">
            {t('subtitle')}
          </div>
          <div className="subtitleSmall">
            {t('subtitleSmall')}
          </div>
        </div>
        <div className="headerActions">
          <button className="btnNew" onClick={resetProject} type="button">
            {t('nouveau')}
          </button>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}
      {audioStatus ? <div className="info">{audioStatus}</div> : null}
      {exportStatus ? <div className="info">{exportStatus}</div> : null}

      <main className="grid">
        <section className="panel">
          <div className="panelHeader">
            <div className="panelTitle">{t('folderTitle')}</div>
          </div>
          {!treeRoot && (
            <div className="row folderActions">
              <input
                ref={folderInputRef}
                type="file"
                // @ts-expect-error: webkitdirectory is supported by Chromium-based browsers
                webkitdirectory=""
                directory=""
                multiple
                accept=".wav,audio/wav,audio/x-wav"
                onChange={(e) => {
                  void onPickFolder(e.target.files)
                  // Permet de re-sélectionner le même dossier si besoin
                  e.currentTarget.value = ''
                }}
              />
              <button
                className="btnOrange"
                type="button"
                onClick={() => folderInputRef.current?.click()}
              >
                {t('loadFolder')}
              </button>
            </div>
          )}
          {treeRoot && currentNode ? (
            <div className="browser">
              <div className="browserHeader">
                <input
                  className="browserSearch"
                  placeholder={t('search')}
                  value={browserQuery}
                  onChange={(e) => setBrowserQuery(e.target.value)}
                />
              </div>

              <div className="browserBreadcrumb">
                <button className="crumb" type="button" onClick={() => setCurrentPath('')}>
                  {t('folder')}
                </button>
                {breadcrumbParts(currentPath).map((c) => (
                  <div key={c.path} className="crumbWrap">
                    <span className="crumbSep">›</span>
                    <button className="crumb" type="button" onClick={() => setCurrentPath(c.path)}>
                      {c.name}
                    </button>
                  </div>
                ))}
              </div>

              <div className="browserList">
                {currentPath ? (
                  <button className="browserItem browserDir" type="button" onClick={() => {
                    const parts = currentPath.split('/').filter(Boolean)
                    parts.pop()
                    setCurrentPath(parts.join('/'))
                  }}>
                    <span className="browserIcon">📁</span>
                    <span className="browserItemName">..</span>
                  </button>
                ) : null}

                {folderItems.dirs.map((d) => (
                  <button
                    key={d.path}
                    className="browserItem browserDir"
                    type="button"
                    onClick={() => setCurrentPath(d.path)}
                    title={t('openFolder')}
                  >
                    <span className="browserIcon">📁</span>
                    <span className="browserItemName">{d.name}</span>
                  </button>
                ))}

                {folderItems.files.slice(0, 500).map((f) => {
                  const isAssigned = Object.values(assigned).some(slot => slot?.file === f.file)
                  return (
                    <button
                      key={f.path}
                      className={`browserItem ${pending?.file === f.file ? 'selected' : ''} ${isAssigned ? 'assigned' : ''}`}
                      type="button"
                      onClick={() => void onClickBrowserFile(f)}
                      title={
                        isAssigned
                          ? t('alreadyAssigned')
                          : t('clickToListen')
                      }
                    >
                      <span className="browserIcon">🎵</span>
                      <span className="browserItemName">{f.file.name}</span>
                      {isAssigned && <span className="browserAssignedBadge" />}
                    </button>
                  )
                })}
              </div>

              <div className="hint browserHint">
                {t('folders')} : {folderItems.dirs.length} • {t('wav')} : {folderItems.files.length}
                {folderItems.files.length > 500 ? <> • {t('displayLimited')}</> : null}
              </div>
            </div>
          ) : null}
          {treeRoot && (
            <div className="row folderActions" style={{ marginTop: 16 }}>
              <input
                ref={folderInputRef}
                type="file"
                // @ts-expect-error: webkitdirectory is supported by Chromium-based browsers
                webkitdirectory=""
                directory=""
                multiple
                accept=".wav,audio/wav,audio/x-wav"
                onChange={(e) => {
                  void onPickFolder(e.target.files)
                  // Permet de re-sélectionner le même dossier si besoin
                  e.currentTarget.value = ''
                }}
              />
              <button
                className="btnOrange"
                type="button"
                onClick={() => folderInputRef.current?.click()}
              >
                {t('loadNew')}
              </button>
            </div>
          )}
          {!pending && (
            <div className="hint">
              {t('hintClickWav')}
      </div>
          )}
        </section>

        <div className="rightCol">
          <section className="panel">
            <div className="panelHeader">
              <div className="panelTitle">{t('assignTitle')}</div>
            </div>
            <div className="notes">
              {(
                [
                  71,
                  72,
                  null, // 3e case vide: B4 | C5 | (vide)
                  65,
                  67,
                  69, // F4 | G4 | A4
                  60,
                  62,
                  64, // C4 | D4 | E4
                ] as Array<MidiNote | null>
              ).map((note, idx) => {
                if (note === null) return <div key={`pad-spacer-${idx}`} className="noteSpacer" aria-hidden="true" />

                const slot = assigned[note]
                const isPending = pending && pending.file
                const isEmpty = !slot
                const isHighlighted = isPending && isEmpty
                return (
                  <div
                    key={note}
                    className={`noteCard ${slot ? 'assigned' : ''} ${isHighlighted ? 'highlighted' : ''}`}
                    onClick={(e) => {
                      // Si un sample est assigné, jouer au clic sur la carte
                      if (slot && !(e.target as HTMLElement).closest('.noteCardRemove')) {
                        void onPlay(slot.file, `${NOTE_LABEL[note]} — ${slot.file.name}`, true)
                      }
                      // Si un sample est en attente et le pad est vide, assigner
                      else if (isPending && isEmpty) {
                        assignTo(note)
                      }
                    }}
                    title={
                      slot
                        ? `${t('clickToPlay')}: ${slot.file.name}`
                        : isPending
                          ? `${t('clickToAssign')}: ${pending.file.name}`
                          : undefined
                    }
                  >
                    {slot && (
                      <button
                        className="noteCardRemove"
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeFrom(note)
                        }}
                        title={t('removeSample')}
                      >
                        ×
                      </button>
                    )}
                    <div className="noteName">{NOTE_LABEL[note]}</div>
                    <div className="noteFile">
                      {slot ? (
                        <>
                          <div className="noteFileName">{slot.file.name}</div>
                          <div className="noteFileDuration">{slot.durationSec.toFixed(2)}s</div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="durationProgress">
              <div className="durationProgressBar">
                <div
                  className="durationProgressFill"
                  style={{ width: `${Math.min(100, (totalDurationSec / MAX_TOTAL_SECONDS) * 100)}%` }}
                />
              </div>
              <div className="footerInfo">
                {totalDurationSec.toFixed(2)}s / {MAX_TOTAL_SECONDS}s • {t('samplesAssigned')}: <b>{assignedCount}</b> /{' '}
                {ALLOWED_NOTES.length}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div className="panelTitle">{t('exportTitle')}</div>
            </div>
            <div className="row">
              <label className="field">
                <div className="fieldLabel">{t('sampling')}</div>
                <select value={exportSampleRate} onChange={(e) => setExportSampleRate(Number(e.target.value))}>
                  <option value={22050}>22050 Hz</option>
                  <option value={46875}>46875 Hz</option>
                </select>
              </label>
              <label className="field">
                <div className="fieldLabel">{t('channels')}</div>
                <select value={exportChannels} onChange={(e) => setExportChannels(Number(e.target.value) as 1 | 2)}>
                  <option value={1}>{t('mono')}</option>
                  <option value={2}>{t('stereo')}</option>
                </select>
              </label>
            </div>
            <div className="hint exportHint">
              {t('exportHint')}
            </div>
            <button className="btnOrange" type="button" disabled={!canExport} onClick={() => void onExport()}>
              {t('exportWav')}
            </button>
          </section>
        </div>
      </main>
    </div>
  )
}

export default App
