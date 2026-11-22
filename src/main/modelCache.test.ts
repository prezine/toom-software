import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachePath, hasModel, modelFile, prefetchModel, settled } from './modelCache'

let root: string
let calls: string[]
const files: Record<string, string> = {
  'onnx-community/whisper-base_timestamped/resolve/main/config.json': '{"model_type":"whisper"}',
  'onnx-community/whisper-base_timestamped/resolve/main/onnx/encoder_model_quantized.onnx': 'x'.repeat(200_000)
}
const fakeFetch = (async (url: string) => {
  calls.push(url)
  const rel = url.replace('https://huggingface.co/', '')
  const body = files[rel]
  return body === undefined
    ? new Response('not found', { status: 404 })
    : new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } })
}) as typeof fetch

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'toom-models-'))
  calls = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('model cache', () => {
  const rel = 'onnx-community/whisper-base_timestamped/resolve/main/onnx/encoder_model_quantized.onnx'

  it('downloads a file once, then serves it from disk', async () => {
    const first = await modelFile(root, rel, fakeFetch)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-length')).toBe('200000')
    expect((await first.text()).length).toBe(200_000)
    await settled()
    expect(existsSync(cachePath(root, rel)!)).toBe(true)
    const second = await modelFile(root, rel, fakeFetch)
    expect((await second.text()).length).toBe(200_000)
    expect(calls).toHaveLength(1)
  })

  it('keeps the download even when the caller stops reading', async () => {
    const res = await modelFile(root, rel, fakeFetch)
    await res.body!.cancel()
    await settled()
    expect(readFileSync(cachePath(root, rel)!, 'utf8').length).toBe(200_000)
  })

  it('passes 404s on and keeps nothing; works offline once cached', async () => {
    const missing = await modelFile(root, 'onnx-community/whisper-base_timestamped/resolve/main/nope.json', fakeFetch)
    expect(missing.status).toBe(404)
    await settled()
    const offline = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    expect((await modelFile(root, rel, offline)).status).toBe(503)
    await (await modelFile(root, rel, fakeFetch)).text()
    await settled()
    expect((await modelFile(root, rel, offline)).status).toBe(200)
  })

  it('refuses paths that leave the cache folder', async () => {
    expect(cachePath(root, '../../etc/passwd')).toBeNull()
    expect(cachePath(root, 'a/%2e%2e/%2e%2e/x')).toBeNull()
    expect((await modelFile(root, '../secret', fakeFetch)).status).toBe(400)
  })

  it('prefetches a model and knows when it is all there', async () => {
    const list = ['config.json', 'onnx/encoder_model_quantized.onnx']
    expect(await hasModel(root, 'onnx-community/whisper-base_timestamped', list)).toBe(false)
    expect(await prefetchModel(root, 'onnx-community/whisper-base_timestamped', list, fakeFetch)).toBe(true)
    expect(await hasModel(root, 'onnx-community/whisper-base_timestamped', list)).toBe(true)
    calls = []
    expect(await prefetchModel(root, 'onnx-community/whisper-base_timestamped', list, fakeFetch)).toBe(true)
    expect(calls).toHaveLength(0)
    expect(await prefetchModel(root, 'onnx-community/whisper-base_timestamped', ['missing.json'], fakeFetch)).toBe(false)
  })
})
