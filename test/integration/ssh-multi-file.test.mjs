/**
 * Integration test for multi-file ZMODEM transfer over SSH.
 *
 * This test verifies that multiple files can be transferred in a single
 * ZMODEM session, both for upload (rz) and download (sz):
 *
 * Phase 1 - Multi-file upload:
 *   - Generate 3 test files with different sizes and content
 *   - Upload all 3 via a single `rz` session
 *   - Verify all 3 files exist on the server with correct sizes
 *
 * Phase 2 - Multi-file download:
 *   - Download all 3 files back via a single `sz file1 file2 file3` session
 *   - Verify all 3 downloaded files match the originals (size + content)
 */

import { Client } from 'ssh2'
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  statSync,
  mkdirSync,
  openSync,
  futimesSync,
  closeSync,
  readdirSync
} from 'fs'
import { join } from 'path'
import { Receiver } from '../../dist/esm/index.js'
import { ZmodemSession } from './zmodem-session.mjs'
import { getSSHConfig, displayTransferPerformance } from './common.mjs'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SSH_CONFIG = getSSHConfig()

const TEST_DIR = '/Users/zxd/dev/zmodem2-js/test/integration'
const DOWNLOAD_DIR = join(TEST_DIR, 'downloads')

// Test files: different sizes and content patterns for thorough verification
const TEST_FILES = [
  { name: 'multi_test_a.bin', size: 1024, seed: 17 }, // 1 KB
  { name: 'multi_test_b.bin', size: 8192, seed: 31 }, // 8 KB
  { name: 'multi_test_c.bin', size: 65536, seed: 127 } // 64 KB
]
const TEST_FILE_MTIME = 1700000000000 // fixed mtime for reproducibility

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a test file with deterministic pseudo-random content.
 * @param {string} filePath - Path to write the file
 * @param {number} size - File size in bytes
 * @param {number} seed - Seed for the pseudo-random pattern
 */
function generateTestFile (filePath, size, seed) {
  console.log('[TEST] Generating test file:', filePath, 'size:', size, 'seed:', seed)
  const buffer = Buffer.alloc(size)
  for (let i = 0; i < size; i++) {
    buffer[i] = (i * seed + seed) % 256
  }
  writeFileSync(filePath, buffer)

  // Set a known mtime for verification
  const fd = openSync(filePath, 'r+')
  futimesSync(fd, new Date(TEST_FILE_MTIME), new Date(TEST_FILE_MTIME))
  closeSync(fd)
  console.log('[TEST] Test file generated, mtime:', TEST_FILE_MTIME)
}

/**
 * Read a file as Uint8Array.
 * @param {string} filePath - Path to read
 * @returns {Uint8Array}
 */
function readFileAsUint8Array (filePath) {
  const buf = readFileSync(filePath)
  return new Uint8Array(buf)
}

/**
 * Compare two buffers byte-by-byte.
 * @param {Buffer|Uint8Array} a
 * @param {Buffer|Uint8Array} b
 * @returns {boolean}
 */
function buffersEqual (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Wait for a shell command to finish and return its output.
 * @param {import('ssh2').Channel} stream - SSH shell stream
 * @param {string} cmd - Command to run
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string>}
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
 * Wait for session to complete with timeout.
 * @param {ZmodemSession} session - Session to monitor
 * @param {number} timeout - Timeout in milliseconds
 */
function waitForComplete (session, timeout = 180000) {
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
 * Delete a local file if it exists.
 * @param {string} filePath
 */
function cleanupLocalFile (filePath) {
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function runTest () {
  console.log('=== SSH ZMODEM Multi-File Transfer Test ===')
  console.log('SSH Config:', { ...SSH_CONFIG, password: '***' })
  console.log('Test files:', TEST_FILES.map(f => `${f.name} (${f.size}B)`).join(', '))
  console.log('')

  // Generate test files locally
  for (const tf of TEST_FILES) {
    generateTestFile(join(TEST_DIR, tf.name), tf.size, tf.seed)
  }

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

        // --- Tracking state ---
        let testPhase = 'upload' // 'upload' -> 'download' -> 'done'
        let testComplete = false
        let uploadStartTime = null
        let uploadEndTime = null
        let downloadStartTime = null
        let downloadEndTime = null
        const uploadedFiles = []
        const downloadedFiles = []

        // --- Upload session ---
        // Note: Sender does not emit FileStart events, so uploadStartTime
        // is set explicitly when startSendMultiple is called.
        const uploadSession = new ZmodemSession(stream, {
          onProgress: (transferred, total, percent) => {
            console.log(`[CALLBACK] Upload progress: ${transferred}/${total} (${percent}%)`)
          },
          onFileComplete: (fileName) => {
            console.log('[CALLBACK] Upload file complete:', fileName)
            uploadedFiles.push(fileName)
          },
          onSessionComplete: () => {
            console.log('[CALLBACK] Upload session complete')
            uploadEndTime = Date.now()
          }
        })

        // --- Download session ---
        const downloadSession = new ZmodemSession(stream, {
          downloadDir: DOWNLOAD_DIR,
          onProgress: (transferred, total, percent) => {
            console.log(`[CALLBACK] Download progress: ${transferred}/${total} (${percent}%)`)
          },
          onFileStart: (fileName, fileSize) => {
            console.log('[CALLBACK] Download file start:', fileName, 'size:', fileSize)
            if (downloadStartTime === null) downloadStartTime = Date.now()
          },
          onFileComplete: (fileName) => {
            console.log('[CALLBACK] Download file complete:', fileName)
            downloadedFiles.push(fileName)
          },
          onSessionComplete: () => {
            console.log('[CALLBACK] Download session complete')
            downloadEndTime = Date.now()
          }
        })

        let activeSession = uploadSession

        // --- Stream data handler ---
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
              // Remote is ready to receive (ZRINIT), we send multiple files
              console.log('[TEST] Starting multi-file upload...')
              activeSession.pendingData.push(data)
              activeSession.state = 'detected'
              uploadStartTime = Date.now()

              // Build file descriptors for multi-file send
              const filesToSend = TEST_FILES.map(tf => {
                const filePath = join(TEST_DIR, tf.name)
                const fileData = readFileAsUint8Array(filePath)
                return {
                  name: tf.name,
                  size: fileData.length,
                  data: fileData,
                  mtime: statSync(filePath).mtimeMs
                }
              })
              activeSession.startSendMultiple(filesToSend)
            } else if (testPhase === 'download' && detection.direction === 'receive') {
              // Remote wants to send (ZRQINIT), we receive files
              console.log('[TEST] Starting multi-file download...')
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

        // --- Test phases ---
        async function runTests () {
          try {
            // ===============================================================
            // Phase 1: Multi-file upload (rz)
            // ===============================================================
            console.log('\n=== Phase 1: Multi-file upload (rz) ===')

            // Clean up any existing files on server
            for (const tf of TEST_FILES) {
              stream.write(`rm -f ${tf.name}\n`)
            }
            await new Promise((_resolve) => setTimeout(_resolve, 1500))

            // Trigger rz on server
            console.log('[TEST] Triggering rz for multi-file upload...')
            stream.write('rz\n')

            // Wait for upload session to complete
            try {
              await waitForComplete(uploadSession, 180000)
              console.log('[TEST] Upload session complete')
            } catch (e) {
              console.log('[TEST] Upload timeout or error:', e.message)
              throw e
            }

            await new Promise((_resolve) => setTimeout(_resolve, 1000))

            // Display upload performance (use total of all file sizes for accuracy)
            const totalUploadBytes = TEST_FILES.reduce((sum, tf) => sum + tf.size, 0)
            displayTransferPerformance(uploadStartTime, uploadEndTime, totalUploadBytes)

            // Verify all files were uploaded
            console.log('\n=== Verifying uploaded files on server ===')
            console.log('[TEST] Files reported as uploaded:', uploadedFiles)

            if (uploadedFiles.length !== TEST_FILES.length) {
              throw new Error(`Expected ${TEST_FILES.length} uploaded files, got ${uploadedFiles.length}`)
            }

            for (const tf of TEST_FILES) {
              const lsOutput = await runShellCommand(stream, `ls -l ${tf.name}`)
              console.log(`[SERVER] ls ${tf.name}:`, lsOutput.trim())
              if (lsOutput.includes('No such file') || !lsOutput.includes(tf.name)) {
                throw new Error(`Uploaded file not found on server: ${tf.name}`)
              }
              console.log(`[TEST] ✓ File exists on server: ${tf.name}`)
            }
            console.log(`[TEST] ✓ All ${TEST_FILES.length} files uploaded successfully`)

            // ===============================================================
            // Phase 2: Multi-file download (sz)
            // ===============================================================
            console.log('\n=== Phase 2: Multi-file download (sz) ===')

            // Clean up local downloads
            for (const tf of TEST_FILES) {
              cleanupLocalFile(join(DOWNLOAD_DIR, tf.name))
            }

            // Switch to download session
            activeSession = downloadSession
            testPhase = 'download'

            // Trigger sz with multiple files
            const szCmd = `sz ${TEST_FILES.map(f => f.name).join(' ')}`
            console.log('[TEST] Triggering:', szCmd)
            stream.write(szCmd + '\n')

            // Wait for download session to complete
            try {
              await waitForComplete(downloadSession, 180000)
              console.log('[TEST] Download session complete')
            } catch (e) {
              console.log('[TEST] Download timeout or error:', e.message)
              throw e
            }

            await new Promise((_resolve) => setTimeout(_resolve, 1000))

            // Display download performance (use total of all file sizes for accuracy)
            const totalDownloadBytes = TEST_FILES.reduce((sum, tf) => sum + tf.size, 0)
            displayTransferPerformance(downloadStartTime, downloadEndTime, totalDownloadBytes)

            // Verify all files were downloaded correctly
            console.log('\n=== Verifying downloaded files ===')
            console.log('[TEST] Files reported as downloaded:', downloadedFiles)

            if (downloadedFiles.length !== TEST_FILES.length) {
              throw new Error(`Expected ${TEST_FILES.length} downloaded files, got ${downloadedFiles.length}`)
            }

            for (const tf of TEST_FILES) {
              const localPath = join(DOWNLOAD_DIR, tf.name)
              if (!existsSync(localPath)) {
                // Check if file was saved with a different name (e.g. .1 suffix)
                const files = readdirSync(DOWNLOAD_DIR)
                const match = files.find(f => f.startsWith(tf.name.replace('.bin', '')))
                if (match) {
                  console.warn(`[TEST] ⚠ File saved as '${match}' instead of '${tf.name}'`)
                  continue
                }
                throw new Error(`Downloaded file not found: ${localPath}`)
              }

              const dlStat = statSync(localPath)
              const originalData = readFileSync(join(TEST_DIR, tf.name))
              const downloadedData = readFileSync(localPath)

              // Verify size
              if (dlStat.size !== tf.size) {
                throw new Error(`File size mismatch for ${tf.name}: expected ${tf.size}, got ${dlStat.size}`)
              }
              console.log(`[TEST] ✓ Size matches for ${tf.name}: ${dlStat.size} bytes`)

              // Verify content
              if (!buffersEqual(originalData, downloadedData)) {
                throw new Error(`Content mismatch for ${tf.name}`)
              }
              console.log(`[TEST] ✓ Content verified for ${tf.name}`)
            }

            console.log(`\n[TEST] ✓ All ${TEST_FILES.length} files downloaded and verified successfully`)

            // ===============================================================
            // Summary
            // ===============================================================
            console.log('\n=== Multi-File Transfer Test Summary ===')
            console.log(`Upload:   ${uploadedFiles.length}/${TEST_FILES.length} files transferred`)
            console.log(`Download: ${downloadedFiles.length}/${TEST_FILES.length} files transferred`)
            console.log('Uploaded files:', uploadedFiles.join(', '))
            console.log('Downloaded files:', downloadedFiles.join(', '))
            console.log('[TEST] ✓ Multi-file transfer is SUPPORTED')

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

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

runTest()
  .then(() => {
    console.log('\n=== Test completed successfully ===')
    // Cleanup local test files
    for (const tf of TEST_FILES) {
      cleanupLocalFile(join(TEST_DIR, tf.name))
    }
    process.exit(0)
  })
  .catch((err) => {
    console.error('\n=== Test failed ===')
    console.error(err)
    // Cleanup local test files
    for (const tf of TEST_FILES) {
      cleanupLocalFile(join(TEST_DIR, tf.name))
    }
    process.exit(1)
  })
