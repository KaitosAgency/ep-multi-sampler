let audioContext: AudioContext | null = null
let currentSource: AudioBufferSourceNode | null = null

function getCtx(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  return audioContext
}

export async function playWavBlob(blob: Blob): Promise<void> {
  const ctx = getCtx()
  await ctx.resume()

  const buf = await blob.arrayBuffer()
  const audioBuf = await ctx.decodeAudioData(buf.slice(0))

  stopPlayback()
  const src = ctx.createBufferSource()
  src.buffer = audioBuf
  src.connect(ctx.destination)
  src.start()
  currentSource = src
  src.onended = () => {
    if (currentSource === src) currentSource = null
  }
}

export function stopPlayback(): void {
  if (currentSource) {
    try {
      currentSource.stop()
    } catch {
      // ignore
    }
    currentSource.disconnect()
    currentSource = null
  }
}


