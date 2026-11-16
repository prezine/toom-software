// electron-builder "afterSign" hook: notarizes the signed Toom.app with Apple and staples the
// ticket, before the .dmg and .zip are made from it.
//
// Why not electron-builder's built-in `mac.notarize`: it waits for Apple without printing anything
// and without a time limit, so a slow or stuck notarization looks like a hung build until the CI
// job is cancelled. This one prints Apple's status every 30 seconds, gives up after
// NOTARIZE_TIMEOUT_MIN (default 40) with the submission ID, and prints Apple's own log when a
// build is rejected.
//
// Runs only when TOOM_NOTARIZE=1 (the signed build step in .github/workflows/release.yml), with
// APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID set.
const { execFile } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stdout, stderr })) : resolve(String(stdout))
    )
  )
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

exports.default = async function notarize(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.TOOM_NOTARIZE !== '1') {
    console.log('  • notarization skipped (TOOM_NOTARIZE is not 1)')
    return
  }
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env
  const missing = Object.entries({ APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID })
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length) throw new Error(`Notarization needs ${missing.join(', ')} (GitHub → Settings → Secrets → Actions).`)

  const auth = ['--apple-id', APPLE_ID, '--password', APPLE_APP_SPECIFIC_PASSWORD, '--team-id', APPLE_TEAM_ID]
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const arch = ARCH[context.arch] ?? String(context.arch)
  const limitMin = Number(process.env.NOTARIZE_TIMEOUT_MIN || 40)
  const tmp = mkdtempSync(join(tmpdir(), 'toom-notarize-'))
  const zip = join(tmp, `Toom-${arch}.zip`)
  const log = (msg) => console.log(`  • notarize (${arch})  ${msg}`)

  // Apple rejects anything not signed with a Developer ID certificate, with a long list of every
  // binary in the app. Catch that here, before the upload, and say what is actually wrong.
  const sig = await run('codesign', ['-dv', '--verbose=4', app]).then(
    (out) => out,
    (err) => String(err.stderr || err.message)
  )
  // codesign prints its details on stderr even when it succeeds
  const details = sig || (await new Promise((resolve) => execFile('codesign', ['-dv', '--verbose=4', app], (_e, _o, stderr) => resolve(String(stderr)))))
  if (!/Authority=Developer ID Application/.test(details)) {
    const found = await run('security', ['find-identity', '-v', '-p', 'codesigning']).catch(() => '')
    throw new Error(
      `Toom.app was not signed with a "Developer ID Application" certificate, so Apple would reject it.\n` +
        `Look further up this log for "skipped macOS application code signing": that line says why.\n` +
        `Usual causes: CSC_LINK points at the wrong file or CSC_KEY_PASSWORD is wrong; the .p12 holds an\n` +
        `"Apple Development" or "Mac App Distribution" certificate instead of "Developer ID Application";\n` +
        `or the .p12 was exported without its private key.\n` +
        `Signing certificates on this Mac:\n${found.trim() || '  (none)'}`
    )
  }

  try {
    log('signed; zipping the app for Apple')
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])

    log('uploading to Apple')
    let id
    try {
      const out = JSON.parse(await run('xcrun', ['notarytool', 'submit', zip, ...auth, '--no-wait', '--output-format', 'json']))
      id = out.id
    } catch (err) {
      throw new Error(
        `Apple refused the upload. Usually a wrong APPLE_ID, app-specific password or APPLE_TEAM_ID, or a new agreement to accept at developer.apple.com.\n${err.stderr || err.stdout || err.message}`
      )
    }
    log(`submission ${id}; waiting for Apple (up to ${limitMin} min)`)

    const started = Date.now()
    let status = 'In Progress'
    while (status === 'In Progress') {
      if (Date.now() - started > limitMin * 60_000) {
        throw new Error(
          `Apple hadn't finished notarizing after ${limitMin} minutes (submission ${id}).\n` +
            `This is on Apple's side: a team's first submissions can sit "In Progress" for hours.\n` +
            `Check it from any Mac:  xcrun notarytool info ${id} --apple-id <id> --team-id <team> --password <app-specific password>\n` +
            `Once it says Accepted, re-run this job: later submissions of the same build usually finish in minutes.`
        )
      }
      await sleep(30_000)
      try {
        status = JSON.parse(await run('xcrun', ['notarytool', 'info', id, ...auth, '--output-format', 'json'])).status
      } catch (err) {
        log(`couldn't ask Apple just now (${String(err.message).split('\n')[0]}); trying again`)
        continue
      }
      log(`${status} after ${Math.round((Date.now() - started) / 1000)}s`)
    }

    if (status !== 'Accepted') {
      const why = await run('xcrun', ['notarytool', 'log', id, ...auth]).catch((e) => e.stderr || e.message)
      throw new Error(`Apple rejected the build (${status}). Apple's log:\n${why}`)
    }

    log('accepted; stapling the ticket to the app')
    await run('xcrun', ['stapler', 'staple', app])
    log('done')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
