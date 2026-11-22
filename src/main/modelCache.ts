// Hugging Face model files, kept on disk for good. The transcription worker asks for
// toom-models://hf/<repo>/resolve/<revision>/<file>; the first request downloads the file from
// huggingface.co while saving it, every later one is read from disk (and works offline).
//
// No Electron imports here, so it can be tested with plain Node (see modelCache.test.ts).
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const HF_ORIGIN = 'https://huggingface.co'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }
const TYPES: Record<string, string> = { '.json': 'application/json', '.onnx': 'application/octet-stream', '.txt': 'text/plain' }

/** Where `rel` (repo/resolve/rev/file) lives under `root`, or null if it would escape it. */
export function cachePath(root: string, rel: string): string | null {
  const clean = decodeURIComponent(rel).replace(/^\/+/, '')
  if (!clean || clean.split('/').some((p) => p === '..' || p === '.')) return null
  const p = normalize(join(root, clean))
  return p.startsWith(normalize(root) + sep) ? p : null
}

async function saveTo(path: string, body: ReadableStream<Uint8Array>, expected: number): Promise<void> {
  const part = `${path}.${process.pid}-${Date.now()}.part`
  try {
    await fs.mkdir(dirname(path), { recursive: true })
    await pipeline(Readable.fromWeb(body as never), createWriteStream(part))
    const { size } = await fs.stat(part)
    // a cut-off download must never be kept as the real file
    if (expected && size !== expected) throw new Error(`incomplete: ${size} of ${expected} bytes`)
    await fs.rename(part, path)
  } catch (err) {
    await fs.rm(part, { force: true })
    console.warn('[models] could not keep', path, err instanceof Error ? err.message : err)
  }
}

const inflight = new Map<string, Promise<void>>()

/**
 * Answer one model-file request: from disk when we have it, otherwise download it, handing the
 * bytes to the caller while they're saved. A download the caller abandons still finishes to disk.
 */
export async function modelFile(root: string, rel: string, fetchFn: typeof fetch): Promise<Response> {
  const path = cachePath(root, rel)
  if (!path) return new Response('Bad path', { status: 400, headers: CORS })
  const type = TYPES[extname(path)] ?? 'application/octet-stream'
  try {
    const { size } = await fs.stat(path)
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      status: 200,
      headers: { ...CORS, 'Content-Type': type, 'Content-Length': String(size) }
    })
  } catch {
    /* not on disk yet */
  }
  let up: Response
  try {
    up = await fetchFn(`${HF_ORIGIN}/${rel.replace(/^\/+/, '')}`)
  } catch {
    return new Response('Offline: the speech model needs an internet connection the first time.', { status: 503, headers: CORS })
  }
  // 404s for optional files are normal; pass them on and keep nothing
  if (!up.ok || !up.body) return new Response(up.body, { status: up.status, headers: CORS })
  const len = up.headers.get('content-length')
  const [toCaller, toDisk] = up.body.tee()
  const job = saveTo(path, toDisk, Number(len) || 0).finally(() => inflight.delete(path))
  inflight.set(path, job)
  return new Response(toCaller, { status: 200, headers: { ...CORS, 'Content-Type': type, ...(len ? { 'Content-Length': len } : {}) } })
}

/** Wait for files still being written (tests, and before reporting a model as ready). */
export async function settled(): Promise<void> {
  await Promise.all([...inflight.values()])
}

/** Download a model's files ahead of time. True when every one of them is on disk. */
export async function prefetchModel(
  root: string,
  repo: string,
  files: readonly string[],
  fetchFn: typeof fetch,
  revision = 'main'
): Promise<boolean> {
  let ok = true
  for (const f of files) {
    const rel = `${repo}/resolve/${revision}/${f}`
    const path = cachePath(root, rel)
    if (!path) return false
    if (await fs.stat(path).then(() => true, () => false)) continue
    const res = await modelFile(root, rel, fetchFn)
    if (!res.ok) {
      await res.body?.cancel()
      ok = false
      continue
    }
    // read it through so the copy being saved completes
    await res.arrayBuffer()
    await settled()
    if (!(await fs.stat(path).then(() => true, () => false))) ok = false
  }
  return ok
}

/** Is every file of this model on disk? */
export async function hasModel(root: string, repo: string, files: readonly string[], revision = 'main'): Promise<boolean> {
  for (const f of files) {
    const path = cachePath(root, `${repo}/resolve/${revision}/${f}`)
    if (!path || !(await fs.stat(path).then(() => true, () => false))) return false
  }
  return true
}
