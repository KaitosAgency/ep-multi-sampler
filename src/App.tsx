import { useMemo, useRef, useState } from 'react'
import './App.css'
import { readWavInfo } from './audio/wavInfo'
import { playWavBlob, stopPlayback } from './audio/player'
import { exportConcatenatedWavPcm16 } from './audio/exportWav'
import { breadcrumbParts, buildFileTree, getNode, type FileEntry, type TreeNode } from './utils/fileTree'

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
      setError('Aucun fichier .wav trouvé dans ce dossier.')
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
      setError('Choisis d’abord un fichier WAV à assigner.')
      return
    }

    const existing = assigned[note]
    const baseTotal = totalDurationSec - (existing?.durationSec ?? 0)
    const nextTotal = baseTotal + pending.durationSec
    if (nextTotal > MAX_TOTAL_SECONDS + 1e-6) {
      const remainingIfReplace = Math.max(0, MAX_TOTAL_SECONDS - baseTotal)
      setError(
        `Limite 20s dépassée. Il te reste ${remainingIfReplace.toFixed(2)}s (en comptant le remplacement sur cette note).`,
      )
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
        setAudioStatus(`Lecture: ${label}`)
      }
      await playWavBlob(blob)
      if (!silent) {
        setAudioStatus(null)
      }
    } catch (e) {
      if (!silent) {
        setAudioStatus(null)
      }
      setError(e instanceof Error ? `Impossible de lire le WAV: ${e.message}` : 'Impossible de lire le WAV')
    }
  }

  async function onExport() {
    setError(null)
    setAudioStatus(null)
    setExportStatus(null)

    if (isOverLimit) {
      setError('Export impossible: la durée totale dépasse 20 secondes.')
      return
    }
    if (assignedCount === 0) {
      setError('Export impossible: aucun sample assigné.')
      return
    }

    // Keep the note order stable (C4..C5). Export only assigned slots.
    const files: Blob[] = []
    for (const n of ALLOWED_NOTES) {
      const slot = assigned[n]
      if (slot) files.push(slot.file)
    }

    try {
      setExportStatus('Export en cours (décodage + resampling)…')
      const { wavBytes, durationSec } = await exportConcatenatedWavPcm16(files, {
        sampleRate: exportSampleRate,
        channels: exportChannels,
      })
      if (durationSec > MAX_TOTAL_SECONDS + 1e-6) {
        setExportStatus(null)
        setError('Export impossible: le WAV final dépasse 20 secondes.')
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
      setError(e instanceof Error ? `Export échoué: ${e.message}` : "Export échoué")
    }
  }

  async function onClickBrowserFile(entry: FileEntry) {
    // Click = play + set pending for assignment
    setError(null)
    setAudioStatus(null)
    try {
      const info = await readWavInfo(entry.file)
      setPending({ file: entry.file, durationSec: info.durationSec })
      await onPlay(entry.file, entry.path)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Impossible de lire le WAV')
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
      <div>
          <div className="title">Riddiwave</div>
          <div className="subtitle">
            EP MULTI-SAMPLER
          </div>
          <div className="subtitleSmall">
            Front only • aucun upload • assignation EP-40 (C4→C5) • export limité à 20s
          </div>
        </div>
        <div className="headerActions">
          <button className="btnNew" onClick={resetProject} type="button">
            Nouveau
          </button>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}
      {audioStatus ? <div className="info">{audioStatus}</div> : null}
      {exportStatus ? <div className="info">{exportStatus}</div> : null}

      <main className="grid">
        <section className="panel">
          <div className="panelHeader">
            <div className="panelTitle">Dossier de samples & navigation</div>
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
                Charger un dossier
              </button>
            </div>
          )}
          {treeRoot && currentNode ? (
            <div className="browser">
              <div className="browserHeader">
                <input
                  className="browserSearch"
                  placeholder="Rechercher"
                  value={browserQuery}
                  onChange={(e) => setBrowserQuery(e.target.value)}
                />
              </div>

              <div className="browserBreadcrumb">
                <button className="crumb" type="button" onClick={() => setCurrentPath('')}>
                  Dossier
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
                    title="Ouvrir le dossier"
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
                          ? `Déjà assigné - Cliquer pour écouter + mettre en attente d'assignation`
                          : 'Cliquer pour écouter + mettre en attente d\'assignation'
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
                Dossiers : {folderItems.dirs.length} • WAV : {folderItems.files.length}
                {folderItems.files.length > 500 ? <> • affichage limité à 500 (perf)</> : null}
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
                Charger nouveau
              </button>
            </div>
          )}
          {!pending && (
            <div className="hint">
              Clique un WAV pour l'écouter et le mettre en attente, puis clique une note pour l'assigner.
      </div>
          )}
        </section>

        <div className="rightCol">
          <section className="panel">
            <div className="panelHeader">
              <div className="panelTitle">Assigner aux notes</div>
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
                        ? `Cliquer pour jouer: ${slot.file.name}`
                        : isPending
                          ? `Cliquer pour assigner: ${pending.file.name}`
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
                        title="Retirer le sample"
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
                {totalDurationSec.toFixed(2)}s / {MAX_TOTAL_SECONDS}s • Samples assignés: <b>{assignedCount}</b> /{' '}
                {ALLOWED_NOTES.length}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panelHeader">
              <div className="panelTitle">Export</div>
            </div>
            <div className="row">
              <label className="field">
                <div className="fieldLabel">Échantillonnage</div>
                <select value={exportSampleRate} onChange={(e) => setExportSampleRate(Number(e.target.value))}>
                  <option value={22050}>22050 Hz</option>
                  <option value={46875}>46875 Hz</option>
                </select>
              </label>
              <label className="field">
                <div className="fieldLabel">Canaux</div>
                <select value={exportChannels} onChange={(e) => setExportChannels(Number(e.target.value) as 1 | 2)}>
                  <option value={1}>Mono</option>
                  <option value={2}>Stéréo</option>
                </select>
              </label>
            </div>
            <div className="hint exportHint">
              Export local uniquement (aucun upload). Format: WAV PCM16. Export bloqué si durée totale &gt; 20s.
            </div>
            <button className="btnOrange" type="button" disabled={!canExport} onClick={() => void onExport()}>
              Exporter WAV
            </button>
          </section>
        </div>
      </main>
    </div>
  )
}

export default App
