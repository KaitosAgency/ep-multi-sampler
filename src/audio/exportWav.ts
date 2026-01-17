export type ExportOptions = {
  sampleRate: number
  channels: 1 | 2
}

function writeAscii(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
}

function writeAsciiTo(arr: Uint8Array, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) arr[offset + i] = s.charCodeAt(i)
}

function clampInt16(x: number): number {
  if (x > 1) x = 1
  if (x < -1) x = -1
  return (x < 0 ? x * 0x8000 : x * 0x7fff) | 0
}

async function decodeToAudioBuffer(file: Blob): Promise<AudioBuffer> {
  const ctx = new AudioContext()
  try {
    const buf = await file.arrayBuffer()
    return await ctx.decodeAudioData(buf.slice(0))
  } finally {
    // Close to avoid piling up contexts.
    void ctx.close()
  }
}

async function resample(buffer: AudioBuffer, sampleRate: number): Promise<AudioBuffer> {
  if (buffer.sampleRate === sampleRate) return buffer
  const length = Math.max(1, Math.round(buffer.duration * sampleRate))
  const offline = new OfflineAudioContext(buffer.numberOfChannels, length, sampleRate)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  src.start()
  return await offline.startRendering()
}

function toTargetChannels(buffer: AudioBuffer, channels: 1 | 2): AudioBuffer {
  if (channels === buffer.numberOfChannels || (channels === 2 && buffer.numberOfChannels >= 2)) {
    // Already ok (mono) or at least stereo available.
  }

  const ctx = new OfflineAudioContext(channels, buffer.length, buffer.sampleRate)
  const out = ctx.createBuffer(channels, buffer.length, buffer.sampleRate)

  if (channels === 1) {
    // Downmix: average all channels.
    const dst = out.getChannelData(0)
    dst.fill(0)
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch)
      for (let i = 0; i < src.length; i++) dst[i] += src[i]
    }
    const inv = 1 / buffer.numberOfChannels
    for (let i = 0; i < dst.length; i++) dst[i] *= inv
    return out
  }

  // Stereo target.
  const left = out.getChannelData(0)
  const right = out.getChannelData(1)

  if (buffer.numberOfChannels === 1) {
    const src = buffer.getChannelData(0)
    left.set(src)
    right.set(src)
    return out
  }

  left.set(buffer.getChannelData(0))
  right.set(buffer.getChannelData(1))
  return out
}

function interleavePcm16(buffer: AudioBuffer, channels: 1 | 2): Int16Array {
  const frames = buffer.length
  const out = new Int16Array(frames * channels)
  if (channels === 1) {
    const ch0 = buffer.getChannelData(0)
    for (let i = 0; i < frames; i++) out[i] = clampInt16(ch0[i])
    return out
  }
  const l = buffer.getChannelData(0)
  const r = buffer.getChannelData(1)
  for (let i = 0; i < frames; i++) {
    out[i * 2] = clampInt16(l[i])
    out[i * 2 + 1] = clampInt16(r[i])
  }
  return out
}

type AcDryRegion = {
  sample_start: number
  sample_end: number
  sample_lokey: number
  sample_hikey: number
  sound_rootnote: number
}

function buildAcDryRegions(sortedNotes: number[], frameLengthsByIndex: number[]): AcDryRegion[] {
  if (sortedNotes.length === 0) return []

  // Same midpoint logic as desktop: boundaries = [0, midpoints..., 127]
  const boundaries: number[] = [0]
  for (let i = 1; i < sortedNotes.length; i++) {
    boundaries.push(Math.floor((sortedNotes[i - 1] + sortedNotes[i] + 1) / 2))
  }
  boundaries.push(127)

  const regions: AcDryRegion[] = []
  let currentFrame = 0
  for (let i = 0; i < sortedNotes.length; i++) {
    const frames = frameLengthsByIndex[i] ?? 0
    if (frames <= 0) continue

    const start = currentFrame
    const end = currentFrame + frames
    const lokey = boundaries[i] ?? 0
    const hikey = boundaries[i + 1] ?? 127

    regions.push({
      sample_start: start,
      sample_end: end,
      sample_lokey: lokey,
      sample_hikey: hikey,
      sound_rootnote: sortedNotes[i]!,
    })

    currentFrame = end
  }

  return regions
}

function buildListChunkTnge(regions: AcDryRegion[]): Uint8Array {
  // Format matches desktop: LIST (payload starts with INFO) containing a TNGE subchunk (JSON + null terminator)
  const rootnote = 60
  const tnge = {
    'sound.playmode': 'key',
    'sound.rootnote': rootnote,
    'sound.pitch': 0,
    'sound.pan': 0,
    'sound.amplitude': 100,
    'envelope.attack': 0,
    'envelope.release': 0,
    'time.mode': 'off',
    'sample.mode': 'multi',
    regions: regions.map((r) => ({
      'sample.start': r.sample_start,
      'sample.end': r.sample_end,
      'sample.lokey': r.sample_lokey,
      'sample.hikey': r.sample_hikey,
      'sound.rootnote': r.sound_rootnote,
      'sound.loopstart': -1,
      'sound.loopend': -1,
    })),
  }

  const enc = new TextEncoder()
  const tngeJson = enc.encode(JSON.stringify(tnge) + '\u0000')

  // INFO + TNGE + size + payload
  const infoLenNoPad = 4 + 4 + 4 + tngeJson.length // "INFO" + "TNGE" + uint32 + tnge
  const infoPad = infoLenNoPad % 2 === 0 ? 0 : 1
  const infoLen = infoLenNoPad + infoPad

  const listChunkSize = infoLen
  const out = new Uint8Array(8 + listChunkSize)
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)

  writeAsciiTo(out, 0, 'LIST')
  dv.setUint32(4, listChunkSize, true)

  let p = 8
  writeAsciiTo(out, p, 'INFO')
  p += 4
  writeAsciiTo(out, p, 'TNGE')
  p += 4
  dv.setUint32(p, tngeJson.length, true)
  p += 4
  out.set(tngeJson, p)
  p += tngeJson.length
  if (infoPad) out[p] = 0

  return out
}

function buildSmplChunk(sampleRate: number): Uint8Array {
  // Matches desktop: smpl chunk with no loops, unity note = 60.
  const samplePeriod = sampleRate > 0 ? Math.floor((1 / sampleRate) * 1e9) : 0
  const chunkSize = 36 // 9 * uint32
  const out = new Uint8Array(8 + chunkSize)
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)

  writeAsciiTo(out, 0, 'smpl')
  dv.setUint32(4, chunkSize, true)

  let p = 8
  dv.setUint32(p, 0, true) // manufacturer
  p += 4
  dv.setUint32(p, 0, true) // product
  p += 4
  dv.setUint32(p, samplePeriod, true) // sample period (ns)
  p += 4
  dv.setUint32(p, 60, true) // midi_unity_note
  p += 4
  dv.setUint32(p, 0, true) // midi_pitch_fraction
  p += 4
  dv.setUint32(p, 0, true) // smpte_format
  p += 4
  dv.setUint32(p, 0, true) // smpte_offset
  p += 4
  dv.setUint32(p, 0, true) // num_sample_loops
  p += 4
  dv.setUint32(p, 0, true) // sampler_data
  return out
}

function buildFmtChunkPcm(channels: number, sampleRate: number, bitsPerSample: number): Uint8Array {
  const chunkSize = 16
  const out = new Uint8Array(8 + chunkSize)
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)

  const bytesPerSample = bitsPerSample / 8
  const blockAlign = channels * bytesPerSample
  const byteRate = sampleRate * blockAlign

  writeAsciiTo(out, 0, 'fmt ')
  dv.setUint32(4, chunkSize, true)
  dv.setUint16(8, 1, true) // PCM
  dv.setUint16(10, channels, true)
  dv.setUint32(12, sampleRate, true)
  dv.setUint32(16, byteRate, true)
  dv.setUint16(20, blockAlign, true)
  dv.setUint16(22, bitsPerSample, true)

  return out
}

function buildDataChunk(pcm: Int16Array): Uint8Array {
  const dataBytes = pcm.byteLength
  const pad = dataBytes % 2 === 0 ? 0 : 1
  const out = new Uint8Array(8 + dataBytes + pad)
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)

  writeAsciiTo(out, 0, 'data')
  dv.setUint32(4, dataBytes + pad, true)
  out.set(new Uint8Array(pcm.buffer), 8)
  if (pad) out[out.length - 1] = 0
  return out
}

export async function exportConcatenatedWavPcm16(
  filesInOrder: Blob[],
  options: ExportOptions,
): Promise<{ wavBytes: Uint8Array; durationSec: number }> {
  // Decode+resample each buffer, then concatenate PCM16 interleaved.
  const rendered: AudioBuffer[] = []
  let totalFrames = 0

  for (const f of filesInOrder) {
    const decoded = await decodeToAudioBuffer(f)
    const rs = await resample(decoded, options.sampleRate)
    const ch = toTargetChannels(rs, options.channels)
    rendered.push(ch)
    totalFrames += ch.length
  }

  const totalSamples = totalFrames * options.channels
  const pcm = new Int16Array(totalSamples)
  let writePos = 0
  for (const b of rendered) {
    const chunk = interleavePcm16(b, options.channels)
    pcm.set(chunk, writePos)
    writePos += chunk.length
  }

  const bytesPerSample = 2
  const blockAlign = options.channels * bytesPerSample
  const byteRate = options.sampleRate * blockAlign
  const dataBytes = pcm.byteLength

  // RIFF header (44 bytes total for PCM fmt+data)
  const wavSize = 44 + dataBytes
  const buf = new ArrayBuffer(wavSize)
  const view = new DataView(buf)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, wavSize - 8, true)
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, options.channels, true)
  view.setUint32(24, options.sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bits

  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer))

  const durationSec = totalFrames / options.sampleRate
  return { wavBytes: new Uint8Array(buf), durationSec }
}

export async function exportAcDryKitWavPcm16(
  items: { note: number; file: Blob }[],
  options: ExportOptions,
): Promise<{ wavBytes: Uint8Array; durationSec: number }> {
  // Desktop format: RIFF → fmt → LIST(INFO/TNGE) → smpl → data
  // We follow the same structure so external tools/device can detect it as a "kit".

  const itemsSorted = [...items].sort((a, b) => a.note - b.note)
  const rendered: AudioBuffer[] = []
  const notes: number[] = []
  const frameLengths: number[] = []
  let totalFrames = 0

  for (const it of itemsSorted) {
    const decoded = await decodeToAudioBuffer(it.file)
    const rs = await resample(decoded, options.sampleRate)
    const ch = toTargetChannels(rs, options.channels)
    if (ch.length <= 0) continue
    rendered.push(ch)
    notes.push(it.note)
    frameLengths.push(ch.length)
    totalFrames += ch.length
  }

  const totalSamples = totalFrames * options.channels
  const pcm = new Int16Array(totalSamples)
  let writePos = 0
  for (const b of rendered) {
    const chunk = interleavePcm16(b, options.channels)
    pcm.set(chunk, writePos)
    writePos += chunk.length
  }

  const regions = buildAcDryRegions(notes, frameLengths)
  const fmtChunk = buildFmtChunkPcm(options.channels, options.sampleRate, 16)
  const listChunk = buildListChunkTnge(regions)
  const smplChunk = buildSmplChunk(options.sampleRate)
  const dataChunk = buildDataChunk(pcm)

  const riffSize = 4 + fmtChunk.length + listChunk.length + smplChunk.length + dataChunk.length // "WAVE" + chunks
  const fileSize = 8 + riffSize
  const out = new Uint8Array(fileSize)
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)

  writeAsciiTo(out, 0, 'RIFF')
  dv.setUint32(4, riffSize, true)
  writeAsciiTo(out, 8, 'WAVE')

  let p = 12
  out.set(fmtChunk, p)
  p += fmtChunk.length
  out.set(listChunk, p)
  p += listChunk.length
  out.set(smplChunk, p)
  p += smplChunk.length
  out.set(dataChunk, p)

  const durationSec = totalFrames / options.sampleRate
  return { wavBytes: out, durationSec }
}



