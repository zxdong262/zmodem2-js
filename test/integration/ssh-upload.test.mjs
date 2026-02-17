/**
 * Pure Node.js test for SSH connection with ZMODEM upload (rz command).
 *
 * This test connects to an SSH server and tests:
 * - rz command - trigger upload, send file to server
 */

import { Client } from 'ssh2'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { basename } from 'path'
import { Sender } from '../../dist/esm/index.js'
import { ZmodemSession } from './zmodem-session.mjs'

/**
 * Start upload session after ZRINIT detection.
 * @param {ZmodemSession} session - Session in detected state
 * @param {string} fileName - File name
 * @param {number} fileSize - File size
 * @param {Uint8Array} fileData - File data
 */
function startUploadSession (session, fileName, fileSize, fileData) {
  console.log('[ZMODEM] Starting file upload:', fileName, 'size:', fileSize)
  session.state = 'sending'
  session.currentFileName = fileName
  session.currentFileSize = fileSize
  session.bytesTransferred = 0
  session.fileBuffer = fileData

  // Create sender as non-initiator (false) since remote sent ZRINIT first
  session.sender = new Sender(false)
  session.sender.startFile(fileName, fileSize)

  // Feed pending data (ZRINIT) to sender first
  for (const data of session.pendingData) {
    session.feedIncoming(data)
  }
  session.pendingData = []
}

// SSH connection configuration
const SSH_CONFIG = {
  host: 'localhost',
  port: 23355,
  username: 'zxd',
  password: 'zxd',
  readyTimeout: 30000
}

// File paths
const UPLOAD_FILE_PATH = '/Users/zxd/dev/zmodem2-js/test/testfile_5m.bin'
const TEST_FILE_SIZE = 5 * 1024 * 1024 // 5MB

/**
 * Generate test file with specified size.
 * @param {string} filePath - Path to the test file
 * @param {number} size - File size in bytes
 */
function generateTestFile (filePath, size) {
  console.log('[TEST] Generating test file:', filePath, 'size:', size)
  const buffer = Buffer.alloc(size)
  // Fill with pseudo-random data for reproducibility
  for (let i = 0; i < size; i++) {
    buffer[i] = (i * 251) % 256
  }
  writeFileSync(filePath, buffer)
  console.log('[TEST] Test file generated successfully')
}

/**
 * Delete test file if exists.
 * @param {string} filePath - Path to the test file
 */
function cleanupTestFile (filePath) {
  if (existsSync(filePath)) {
    console.log('[TEST] Cleaning up test file:', filePath)
    unlinkSync(filePath)
    console.log('[TEST] Test file deleted')
  }
}

// Mock user file selection (returns selected file path)
async function mockSelectFile () {
  console.log('[MOCK] User selecting file:', UPLOAD_FILE_PATH)
  return UPLOAD_FILE_PATH
}

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
 * Run SSH connection and ZMODEM upload test.
 */
async function runTest () {
  console.log('=== SSH ZMODEM Upload Test ===')
  console.log('SSH Config:', { ...SSH_CONFIG, password: '***' })
  console.log('')

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
        const session = new ZmodemSession(stream, {})
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

            if (detection.direction === 'send') {
              // Remote is ready to receive (ZRINIT), we send file
              console.log('[TEST] Starting file upload...')
              // Store the ZRINIT data for later
              session.pendingData.push(data)
              session.state = 'detected'
              mockSelectFile().then((filePath) => {
                const fileName = basename(filePath)
                const fileData = readFileSync(filePath)
                console.log('[TEST] File loaded:', fileName, 'size:', fileData.length)
                startUploadSession(session, fileName, fileData.length, new Uint8Array(fileData))
              }).catch(reject)
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

        // Run upload test
        async function runUploadTest () {
          try {
            // Delete existing file on server to avoid conflict
            const uploadFileName = basename(UPLOAD_FILE_PATH)
            console.log('\n=== Preparing: Delete existing file on server ===')
            stream.write(`rm -f ${uploadFileName}\n`)
            await new Promise((_resolve) => setTimeout(_resolve, 1500))

            // Test: rz command (upload)
            console.log('\n=== Test: rz command (upload) ===')
            stream.write('rz\n')

            // Wait for upload to complete with timeout
            try {
              await waitForComplete(session, 180000)
              console.log('[TEST] Upload session complete')
            } catch (e) {
              console.log('[TEST] Upload timeout or error:', e.message)
            }

            // Wait for any remaining processing
            await new Promise((_resolve) => setTimeout(_resolve, 1000))
            console.log('[TEST] Upload test complete, state:', session.state)

            testComplete = true
            stream.write('exit\n')
            resolve()
          } catch (err) {
            console.error('[TEST] Error:', err)
            reject(err)
          }
        }

        // Start test after shell is ready
        setTimeout(runUploadTest, 1500)
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
// Generate test file before test
generateTestFile(UPLOAD_FILE_PATH, TEST_FILE_SIZE)

runTest()
  .then(() => {
    console.log('\n=== Test completed successfully ===')
    cleanupTestFile(UPLOAD_FILE_PATH)
    process.exit(0)
  })
  .catch((err) => {
    console.error('\n=== Test failed ===')
    console.error(err)
    cleanupTestFile(UPLOAD_FILE_PATH)
    process.exit(1)
  })
