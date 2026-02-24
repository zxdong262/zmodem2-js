import dotenv from 'dotenv'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const envPath = join(__dirname, '../../.env')
dotenv.config({ path: envPath })

const SSH_HOST = process.env.TEST_HOST || 'localhost'
const SSH_PORT = parseInt(process.env.TEST_PORT || '23355', 10)
const SSH_USER = process.env.TEST_USER || 'zxd'
const SSH_PASS = process.env.TEST_PASS
const SSH_KEY_PATH = process.env.TEST_KEY_PATH

function getAuthConfig () {
  if (SSH_KEY_PATH) {
    return {
      privateKey: readFileSync(SSH_KEY_PATH).toString('utf8')
    }
  } else if (SSH_PASS) {
    return {
      password: SSH_PASS
    }
  } else {
    throw new Error('Either SSH_PASS or SSH_KEY_PATH must be configured')
  }
}

function getSSHConfig () {
  return {
    host: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    readyTimeout: 30000,
    ...getAuthConfig()
  }
}

function formatSpeed (bytesPerSecond) {
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`
  } else if (bytesPerSecond >= 1024) {
    return `${(bytesPerSecond / 1024).toFixed(2)} KB/s`
  } else {
    return `${bytesPerSecond.toFixed(2)} B/s`
  }
}

function formatBytes (bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  } else if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`
  } else {
    return `${bytes} B`
  }
}

function displayTransferPerformance (startTime, endTime, totalBytes) {
  if (startTime && endTime) {
    const durationSeconds = (endTime - startTime) / 1000
    const speed = totalBytes / durationSeconds
    console.log('\n=== Transfer Performance ===')
    console.log(`Total transferred: ${formatBytes(totalBytes)}`)
    console.log(`Duration: ${durationSeconds.toFixed(2)} seconds`)
    console.log(`Average speed: ${formatSpeed(speed)}`)
  }
}

export {
  getSSHConfig,
  formatSpeed,
  formatBytes,
  displayTransferPerformance
}
