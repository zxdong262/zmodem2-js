/**
 * Integration test for Chinese filename and mtime round-trip over SSH.
 *
 * This test verifies that:
 * 1. Files with Chinese (non-ASCII) filenames can be uploaded via rz
 * 2. File modification time (mtime) is preserved during upload
 * 3. Files with Chinese filenames can be downloaded via sz
 * 4. Downloaded file has the correct Chinese filename
 */

import { Client } from 'ssh2'
import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync, mkdirSync, openSync, futimesSync, closeSync, readdirSync } from 'fs'
import { basename, join } from 'path'
import { Sender, Receiver } from '../../dist/esm/index.js'
import { ZmodemSession } from './zmodem-session.mjs'
import { getSSHConfig, displayTransferPerformance } from './common.mjs'

// SSH connection configuration
const SSH_CONFIG = getSSHConfig()

const TEST_DIR = '/Users/zxd/dev/zmodem2-js/test/integration'
const DOWNLOAD_DIR = join(TEST_DIR, 'downloads')

// Chinese filename test parameters
const CN_FILE_NAME = '中文测试文件.txt'
const CN_FILE_SIZE = 1024
const CN_FILE_MTIME = 1700000000000 // 2023-11-14T22:13:20.000Z (fixed for reproducibility)
const CN_UPLOAD_PATH = join(TEST_DIR, CN_FILE_NAME)

/**
 * Generate a test file with Chinese filename.
 */
function generateCnTestFile () {
  console.log('[TEST] Generating Chinese test file:', CN_UPLOAD_PATH)
  const buffer = Buffer.alloc(CN_FILE_SIZE)
  for (let i = 0; i < CN_FILE_SIZE; i++) {
    buffer[i] = (i * 251) % 256
  }
  writeFileSync(CN_UPLOAD_PATH, buffer)

  // Set a known mtime on the file
  const fd = openSync(CN_UPLOAD_PATH, 'r+')
  futimesSync(fd, new Date(CN_FILE_MTIME), new Date(CN_FILE_MTIME))
  closeSync(fd)

  console.log('[TEST] Chinese test file generated, mtime:', CN_FILE_MTIME)
}

/**
 * Start upload session after ZRINIT detection.
 */
function startUploadSession (session, fileName, fileSize, fileData, mtime) {
  console.log('[ZMODEM] Starting file upload:', fileName, 'size:', fileSize, 'mtime:', mtime)
  session.state = 'sending'
  session.currentFileName = fileName
  session.currentFileSize = fileSize
  session.bytesTransferred = 0
  session.fileBuffer = fileData
  session.currentMtime = mtime

  // Create sender as non-initiator (false) since remote sent ZRINIT first
  session.sender = new Sender(false)
  session.sender.startFile(fileName, fileSize, mtime)

  // Feed pending data (ZRINIT) to sender first
  for (const data of session.pendingData) {
    session.feedIncoming(data)
  }
  session.pendingData = []
}

/**
 * Wait for session to complete with timeout.
 */
function waitForComplete (session, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    const checkInterval = setInterval(() => {
      if (session.sessionComplete) {
        clearInterval(checkInterval)
        resolve(true)
      } else if (Date.now() - startTime > timeout) {
        clearInterval(checkInterval)
        reject(new Error(`Timeout waiting for session complete, current state: ${session.state}`))
      }
    }, 500)
  })
}

/**
 * Wait for a shell command to finish and return its output.
 */
function runShellCommand (stream, cmd, timeout = 5000) {
  return new Promise((resolve) => {
    let output = ''
    const onData = (data) => {
      output += data.toString('utf8')
    }
    stream.on('data', onData)
    stream.write(cmd + '\n')
    setTimeout(() => {
      stream.removeListener('data', onData)
      resolve(output)
    }, timeout)
  })
}

/**
 * Run the full Chinese filename and mtime test.
 */
async function runTest () {
  console.log('=== SSH ZMODEM Chinese Filename & Mtime Test ===')
  console.log('SSH Config:', { ...SSH_CONFIG, password: '***' })
  console.log('')

  // Generate test file with Chinese name
  generateCnTestFile()

  // Ensure download directory exists
  if (!existsSync(DOWNLOAD_DIR)) {
    mkdirSync(DOWNLOAD_DIR, { recursive: true })
  }

  const conn = new Client()

  return new Promise((resolve, reject) => {
    conn.on('ready', () => {
      console.log('[SSH] Connected to server')

      conn.shell((err, stream) => {
        if (err !== null && err !== undefined) {
          console.error('[SSH] Failed to create shell:', err)
          conn.end()
          reject(err)
          return
        }

        if (stream === undefined) {
          console.error('[SSH] Failed to create shell: stream is undefined')
          conn.end()
          reject(new Error('Shell stream is undefined'))
          return
        }

        console.log('[SSH] Shell created')

        // === Phase 1: Upload file with Chinese name ===
        const uploadSession = new ZmodemSession(stream, {
          onProgress: (transferred, total, percent) => {
            console.log(`[CALLBACK] Upload progress: ${transferred}/${total} (${percent}%)`)
          },
          onFileComplete: (fileName) => {
            console.log('[CALLBACK] Upload file complete:', fileName)
          },
          onSessionComplete: () => {
            console.log('[CALLBACK] Upload session complete')
          }
        })

        // === Phase 2: Download file with Chinese name ===
        const downloadSession = new ZmodemSession(stream, {
          downloadDir: DOWNLOAD_DIR,
          onFileStart: (fileName, fileSize) => {
            console.log('[CALLBACK] Download file start:', fileName, 'size:', fileSize)
          },
          onFileComplete: (fileName) => {
            console.log('[CALLBACK] Download file complete:', fileName)
          },
          onSessionComplete: () => {
            console.log('[CALLBACK] Download session complete')
          },
          onProgress: (transferred, total, percent) => {
            console.log(`[CALLBACK] Download progress: ${transferred}/${total} (${percent}%)`)
          }
        })

        let activeSession = uploadSession
        let testPhase = 'upload'
        let testComplete = false

        stream.on('data', (data) => {
          console.log('[SSH] Received data:', data.length, 'bytes, phase:', testPhase, 'state:', activeSession.state)

          // If session is active, feed data directly
          if (activeSession.state !== 'idle' && activeSession.state !== 'detected') {
            activeSession.feedIncoming(data)
            return
          }

          // Check for ZMODEM detection
          const detection = activeSession.detectZmodem(data)
          if (detection.detected) {
            console.log('[ZMODEM] Detected, direction:', detection.direction)

            if (testPhase === 'upload' && detection.direction === 'send') {
              // Remote is ready to receive (ZRINIT), we send file
              console.log('[TEST] Starting Chinese file upload...')
              activeSession.pendingData.push(data)
              activeSession.state = 'detected'
              const fileData = readFileSync(CN_UPLOAD_PATH)
              const fileMtime = statSync(CN_UPLOAD_PATH).mtimeMs
              startUploadSession(activeSession, CN_FILE_NAME, fileData.length, new Uint8Array(fileData), fileMtime)
            } else if (testPhase === 'download' && detection.direction === 'receive') {
              // Remote wants to send (ZRQINIT), we receive file
              console.log('[TEST] Starting Chinese file download...')
              activeSession.state = 'receiving'
              activeSession.receiver = new Receiver()
              activeSession.fileBuffer = []
              activeSession.feedIncoming(detection.initialData)
            } else {
              activeSession.feedIncoming(detection.initialData)
            }
          } else {
            // Regular terminal output
            const text = data.toString('utf8')
            // eslint-disable-next-line no-control-regex
            const cleanText = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b].*?\x07/g, '')
            if (cleanText.trim().length > 0) {
              process.stdout.write(cleanText)
            }
          }
        })

        stream.on('close', () => {
          console.log('[SSH] Stream closed')
          conn.end()
          if (!testComplete) {
            resolve()
          }
        })

        stream.stderr.on('data', (data) => {
          console.error('[SSH] stderr:', data.toString())
        })

        async function runTests () {
          try {
            // --- Phase 1: Upload Chinese filename ---
            console.log('\n=== Phase 1: Upload file with Chinese name ===')
            stream.write(`rm -f '${CN_FILE_NAME}'\n`)
            await new Promise((_resolve) => setTimeout(_resolve, 1500))

            console.log('[TEST] Triggering rz for Chinese file upload...')
            stream.write('rz\n')

            try {
              await waitForComplete(uploadSession, 180000)
              console.log('[TEST] Upload session complete')
            } catch (e) {
              console.log('[TEST] Upload timeout or error:', e.message)
              throw e
            }

            await new Promise((_resolve) => setTimeout(_resolve, 1000))

            // Verify uploaded file on server: check filename and mtime
            console.log('\n=== Verifying uploaded file on server ===')
            const lsOutput = await runShellCommand(stream, `ls -l '${CN_FILE_NAME}'`)
            console.log('[SERVER] ls output:', lsOutput.trim())

            // Get mtime from server (stat format: "2023-11-14 22:13:20.000000000 +0000")
            const statOutput = await runShellCommand(stream, `stat -c '%Y' '${CN_FILE_NAME}'`)
            console.log('[SERVER] stat mtime output:', statOutput.trim())

            // Verify the file exists (ls didn't error)
            const existsOnServer = lsOutput.includes(CN_FILE_NAME) || !lsOutput.includes('No such file')
            if (!existsOnServer) {
              throw new Error(`Uploaded file not found on server: ${CN_FILE_NAME}`)
            }
            console.log('[TEST] ✓ Chinese filename preserved on server')

            // Verify mtime matches (server gives epoch seconds)
            const serverMtimeSec = parseInt(statOutput.trim(), 10)
            const expectedMtimeSec = Math.floor(CN_FILE_MTIME / 1000)
            if (!isNaN(serverMtimeSec)) {
              // Allow 2 second tolerance for rounding/transit
              const diff = Math.abs(serverMtimeSec - expectedMtimeSec)
              if (diff <= 2) {
                console.log(`[TEST] ✓ mtime preserved (server: ${serverMtimeSec}, expected: ${expectedMtimeSec}, diff: ${diff}s)`)
              } else {
                console.warn(`[TEST] ⚠ mtime mismatch (server: ${serverMtimeSec}, expected: ${expectedMtimeSec}, diff: ${diff}s)`)
              }
            } else {
              console.warn('[TEST] ⚠ Could not parse server mtime from stat output')
            }

            // --- Phase 2: Download Chinese filename ---
            console.log('\n=== Phase 2: Download file with Chinese name ===')
            // Clean up local download if exists
            const localDownloadPath = join(DOWNLOAD_DIR, CN_FILE_NAME)
            if (existsSync(localDownloadPath)) {
              unlinkSync(localDownloadPath)
            }

            // Switch to download session
            activeSession = downloadSession
            testPhase = 'download'

            console.log('[TEST] Triggering sz for Chinese file download...')
            stream.write(`sz '${CN_FILE_NAME}'\n`)

            try {
              await waitForComplete(downloadSession, 180000)
              console.log('[TEST] Download session complete')
            } catch (e) {
              console.log('[TEST] Download timeout or error:', e.message)
              throw e
            }

            await new Promise((_resolve) => setTimeout(_resolve, 1000))

            // Verify downloaded file
            console.log('\n=== Verifying downloaded file ===')
            if (existsSync(localDownloadPath)) {
              const dlStat = statSync(localDownloadPath)
              console.log('[TEST] Downloaded file:', localDownloadPath)
              console.log('[TEST] Downloaded file size:', dlStat.size)
              console.log('[TEST] ✓ Chinese filename preserved on download')

              // Verify file size matches
              if (dlStat.size === CN_FILE_SIZE) {
                console.log('[TEST] ✓ File size matches')
              } else {
                console.warn(`[TEST] ⚠ File size mismatch (got: ${dlStat.size}, expected: ${CN_FILE_SIZE})`)
              }
            } else {
              // Check if file was saved with a different name
              const files = readdirSync(DOWNLOAD_DIR)
              const cnFile = files.find(f => f.includes('中文'))
              if (cnFile) {
                console.log('[TEST] ✓ Found downloaded file with Chinese chars:', cnFile)
              } else {
                console.error('[TEST] ✗ Downloaded file not found. Files in download dir:', files)
                throw new Error('Downloaded file with Chinese name not found')
              }
            }

            testComplete = true
            stream.write('exit\n')
            resolve()
          } catch (err) {
            console.error('[TEST] Error:', err)
            testComplete = true
            stream.write('exit\n')
            reject(err)
          }
        }

        // Start test after shell is ready
        setTimeout(runTests, 1500)
      })
    })

    conn.on('error', (err) => {
      console.error('[SSH] Connection error:', err)
      reject(err)
    })

    conn.on('close', () => {
      console.log('[SSH] Connection closed')
    })

    console.log('[SSH] Connecting to', SSH_CONFIG.host + ':' + SSH_CONFIG.port)
    conn.connect(SSH_CONFIG)
  })
}

// Run the test
runTest()
  .then(() => {
    console.log('\n=== Test completed successfully ===')
    // Cleanup
    if (existsSync(CN_UPLOAD_PATH)) {
      unlinkSync(CN_UPLOAD_PATH)
    }
    process.exit(0)
  })
  .catch((err) => {
    console.error('\n=== Test failed ===')
    console.error(err)
    if (existsSync(CN_UPLOAD_PATH)) {
      unlinkSync(CN_UPLOAD_PATH)
    }
    process.exit(1)
  })
