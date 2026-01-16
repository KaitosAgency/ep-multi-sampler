export type WavInfo = {
  channels: number
  sampleRate: number
  bitsPerSample: number
  dataBytes: number
  durationSec: number
}

function readAscii4(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

/**
 * Parse minimal RIFF/WAV info from a Blob.
 * Works for PCM/IEEE_FLOAT/WAVE_FORMAT_EXTENSIBLE as long as fmt chunk provides
 * channels/sampleRate/bitsPerSample and a data chunk exists.
 */
export async function readWavInfo(file: Blob): Promise<WavInfo> {
  // Read the entire file because chunks can be anywhere; with a 20s cap this stays reasonable.
  const buf = await file.arrayBuffer()
  if (buf.byteLength < 12) {
    throw new Error('Fichier trop petit pour être un WAV')
  }
  const view = new DataView(buf)

  const riff = readAscii4(view, 0)
  const wave = readAscii4(view, 8)
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Header RIFF/WAVE invalide')
  }

  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataBytes = 0

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii4(view, offset)
    const chunkSize = view.getUint32(offset + 4, true)
    const chunkDataOffset = offset + 8

    if (chunkDataOffset + chunkSize > view.byteLength) {
      // Corrupt/truncated.
      break
    }

    if (chunkId === 'fmt ') {
      // WAVEFORMATEX (min 16 bytes)
      if (chunkSize >= 16) {
        // const audioFormat = view.getUint16(chunkDataOffset + 0, true)
        channels = view.getUint16(chunkDataOffset + 2, true)
        sampleRate = view.getUint32(chunkDataOffset + 4, true)
        bitsPerSample = view.getUint16(chunkDataOffset + 14, true)
      }
    } else if (chunkId === 'data') {
      dataBytes = chunkSize
    }

    // Next chunk (word aligned)
    offset = chunkDataOffset + chunkSize + (chunkSize % 2)
  }

  if (!channels || !sampleRate || !bitsPerSample || !dataBytes) {
    throw new Error('Impossible de lire les infos WAV (fmt/data manquant)')
  }

  const bytesPerSample = bitsPerSample / 8
  const byteRate = sampleRate * channels * bytesPerSample
  if (!Number.isFinite(byteRate) || byteRate <= 0) {
    throw new Error('WAV invalide (byteRate)')
  }

  const durationSec = dataBytes / byteRate
  return { channels, sampleRate, bitsPerSample, dataBytes, durationSec }
}



