/**
 * Pure Node.js test for SSH connection with ZMODEM download (sz command).
 *
 * This test connects to an SSH server and tests:
 * - sz command - trigger download, receive file from server
 */

import { Client } from 'ssh2'
import { existsSync, mkdirSync } from 'fs'
import { Receiver } from '../../dist/esm/index.js'
import { ZmodemSession } from './zmodem-session.mjs'
import { getSSHConfig, displayTransferPerformance } from './common.mjs'

/**
 * Start download session after ZRQINIT detection.
 * @param {ZmodemSession} session - Session in detected state
 * @param {Uint8Array} initialData - Initial ZMODEM data
 */
function startDownloadSession (session, initialData) {
  console.log('[ZMODEM] Starting file download session')
  session.state = 'receiving'
  session.receiver = new Receiver()
  session.fileBuffer = []

  // Feed initial data to receiver
  session.feedIncoming(initialData)
}

// SSH connection configuration
const SSH_CONFIG = getSSHConfig()

const DOWNLOAD_DIR = '/Users/zxd/dev/zmodem2-js/test/integration/downloads'

const DOWNLOAD_FILE_NAME = 'testfile_5m.bin'

let downloadStartTime = null
let downloadEndTime = null
let totalBytesTransferred = 0

/**
 * Wait for session to complete with timeout.
 * @param {ZmodemSession} session - Session to monitor
 * @param {number} timeout - Timeout in milliseconds
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
 * Run SSH connection and ZMODEM download test.
 */
async function runTest () {
  console.log('=== SSH ZMODEM Download Test ===')
  console.log('SSH Config:', { ...SSH_CONFIG, password: '***' })
  console.log('')

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
        const session = new ZmodemSession(stream, {
          downloadDir: DOWNLOAD_DIR,
          onFileStart: (fileName, fileSize) => {
            console.log('[CALLBACK] File start:', fileName, 'size:', fileSize)
            downloadStartTime = Date.now()
            totalBytesTransferred = 0
          },
          onFileComplete: (fileName) => {
            console.log('[CALLBACK] File complete:', fileName)
            downloadEndTime = Date.now()
          },
          onSessionComplete: () => {
            console.log('[CALLBACK] Session complete')
          },
          onProgress: (transferred, total, percent) => {
            totalBytesTransferred = transferred
            console.log(`[CALLBACK] Progress: ${transferred}/${total} (${percent}%)`)
          }
        })
        let testComplete = false

        stream.on('data', (data) => {
          const str = data.toString('binary')
          console.log('[SSH] Received data:', str.length, 'bytes', 'state:', session.state)

          // If session is active, feed data directly
          if (session.state !== 'idle' && session.state !== 'detected') {
            session.feedIncoming(data)
            return
          }

          // Check for ZMODEM detection
          const detection = session.detectZmodem(data)
          if (detection.detected) {
            console.log('[ZMODEM] Detected, direction:', detection.direction)

            if (detection.direction === 'receive') {
              // Remote wants to send (ZRQINIT), we receive file
              console.log('[TEST] Starting file download...')
              startDownloadSession(session, detection.initialData)
            } else {
              // Feed data to existing session
              console.log('[ZMODEM] Feeding data to existing session')
              session.feedIncoming(detection.initialData)
            }
          } else {
            // Regular terminal output
            const text = data.toString('utf8')
            // Filter out control sequences for cleaner output (ANSI escape sequences)
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

        // Run download test
        async function runDownloadTest () {
          try {
            // Test: sz command (download)
            console.log('\n=== Test: sz command (download) ===')
            console.log('[TEST] Requesting file:', DOWNLOAD_FILE_NAME)
            stream.write(`sz ${DOWNLOAD_FILE_NAME}\n`)

            // Wait for download to complete with timeout
            try {
              await waitForComplete(session, 180000)
              console.log('[TEST] Download session complete')
            } catch (e) {
              console.log('[TEST] Download timeout or error:', e.message)
            }

            // Wait for any remaining processing
            await new Promise((_resolve) => setTimeout(_resolve, 1000))
            console.log('[TEST] Download test complete, state:', session.state)

            // Calculate and display transfer speed
            displayTransferPerformance(downloadStartTime, downloadEndTime, totalBytesTransferred)

            testComplete = true
            stream.write('exit\n')
            resolve()
          } catch (err) {
            console.error('[TEST] Error:', err)
            reject(err)
          }
        }

        // Start test after shell is ready
        setTimeout(runDownloadTest, 1500)
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
    process.exit(0)
  })
  .catch((err) => {
    console.error('\n=== Test failed ===')
    console.error(err)
    process.exit(1)
  })
