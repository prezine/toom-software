import { app, ipcMain, net, protocol } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { MODELS_SCHEME, WHISPER_FILES, WHISPER_MODELS, type WhisperModel } from '@shared/whisper'
import { hasModel, modelFile, prefetchModel } from './modelCache'

/**
 * Small ML models used on-device. Each downloads once into the app data folder and
 * is read from disk afterwards, so the features keep working offline.
 */
const MODELS: Record<string, { url: string; file: string }> = {
  'selfie-segmenter': {
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
    file: 'selfie_segmenter.tflite'
  },
  'face-detector': {
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite',
    file: 'blaze_face_short_range.tflite'
  }
}

// Text recognition (OCR) ships with the app — nothing to download.
const OCR_FILES: Record<'worker' | 'core' | 'eng', [packaged: string, dev: string]> = {
  worker: ['worker.min.js', 'node_modules/tesseract.js/dist/worker.min.js'],
  core: ['tesseract-core-simd-lstm.wasm.js', 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js'],
  eng: ['eng.traineddata.gz', 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz']
}
const ocrPath = (k: keyof typeof OCR_FILES): string =>
  app.isPackaged ? join(process.resourcesPath, 'ocr', OCR_FILES[k][0]) : join(app.getAppPath(), OCR_FILES[k][1])

const dir = (): string => join(app.getPath('userData'), 'models')
const inflight = new Map<string, Promise<Uint8Array>>()

async function getModel(name: string): Promise<Uint8Array> {
  const spec = MODELS[name]
  if (!spec) throw new Error(`Unknown model: ${name}`)
  const path = join(dir(), spec.file)
  try {
    return new Uint8Array(await fs.readFile(path))
  } catch {
    /* not cached yet */
  }
  let p = inflight.get(name)
  if (!p) {
    p = (async () => {
      let res: Response
      try {
        res = await fetch(spec.url)
      } catch {
        throw new Error('This feature needs an internet connection the first time, to download its model.')
      }
      if (!res.ok) throw new Error(`Model download failed (${res.status})`)
      const buf = new Uint8Array(await res.arrayBuffer())
      await fs.mkdir(dir(), { recursive: true })
      await fs.writeFile(path + '.tmp', buf)
      await fs.rename(path + '.tmp', path)
      return buf
    })().finally(() => inflight.delete(name))
    inflight.set(name, p)
  }
  return p
}

/** The speech models (Hugging Face files), under the same models folder: "Clear downloads" removes them too. */
const hfRoot = (): string => join(dir(), 'hf')
const netFetch = ((url: string) => net.fetch(url)) as typeof fetch

/** toom-models://hf/<repo>/resolve/<revision>/<file>: from disk, or downloaded once and kept. */
export function handleModelsProtocol(): void {
  protocol.handle(MODELS_SCHEME, (req) => {
    const url = new URL(req.url)
    if (url.host !== 'hf') return new Response('Not found', { status: 404 })
    return modelFile(hfRoot(), url.pathname, netFetch)
  })
}

let prefetching: Promise<void> | null = null
/**
 * Download the chosen speech model in the background (once), so the first transcription doesn't
 * wait for it. Waits while a recording is running; does nothing when the model is already here.
 */
export function prefetchWhisper(model: WhisperModel, busy: () => boolean): void {
  const spec = WHISPER_MODELS[model]
  if (!spec || prefetching) return
  prefetching = (async () => {
    if (await hasModel(hfRoot(), spec.id, WHISPER_FILES)) return
    while (busy()) await new Promise((r) => setTimeout(r, 30_000))
    const ok = await prefetchModel(hfRoot(), spec.id, WHISPER_FILES, netFetch)
    console.log(`[models] speech model ${spec.id}: ${ok ? 'ready' : 'not complete, will finish on first use'}`)
  })()
    .catch((err) => console.warn('[models] prefetch failed', err))
    .finally(() => (prefetching = null))
}

export function registerModelIpc(): void {
  ipcMain.handle('ocr:assets', async () => {
    const [worker, core, eng] = await Promise.all([
      fs.readFile(ocrPath('worker'), 'utf8'),
      fs.readFile(ocrPath('core'), 'utf8'),
      fs.readFile(ocrPath('eng'))
    ])
    return { worker, core, eng: new Uint8Array(eng) }
  })
  ipcMain.handle('models:get', (_e, name: string) => getModel(name))
  ipcMain.handle('models:status', async (_e, name: string) => {
    const spec = MODELS[name]
    if (!spec) return false
    try {
      await fs.access(join(dir(), spec.file))
      return true
    } catch {
      return false
    }
  })
}
