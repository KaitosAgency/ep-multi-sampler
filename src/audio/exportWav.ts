export type ExportOptions = {
  sampleRate: number
  channels: 1 | 2
}

function writeAscii(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
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


