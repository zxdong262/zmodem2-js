/**
 * ZmodemSession class for handling ZMODEM transfers over a stream.
 *
 * This module provides a reusable ZMODEM session handler that can work with
 * any duplex stream (SSH, serial, WebSocket, etc.).
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, basename, extname } from 'path'
import { Sender, Receiver, SenderEvent, ReceiverEvent } from '../../dist/esm/index.js'

/**
 * Generate a unique filename if file already exists.
 * Adds .1, .2, .3 etc. suffix before the extension.
 * @param {string} dir - Directory path
 * @param {string} fileName - Original file name
 * @returns {string} - Unique file path
 */
function getUniqueFilePath (dir, fileName) {
  let filePath = join(dir, fileName)

  if (!existsSync(filePath)) {
    return filePath
  }

  // File exists, need to rename
  const ext = extname(fileName)
  const baseName = basename(fileName, ext)
  let counter = 1

  while (existsSync(filePath)) {
    const newFileName = `${baseName}.${counter}${ext}`
    filePath = join(dir, newFileName)
    counter++
  }

  return filePath
}

/**
 * ZmodemSession class for handling ZMODEM transfers.
 */
export class ZmodemSession {
  constructor (stream, options = {}) {
    this.stream = stream
    this.options = {
      downloadDir: options.downloadDir || './downloads',
      onProgress: options.onProgress || null,
      onFileStart: options.onFileStart || null,
      onFileComplete: options.onFileComplete || null,
      onSessionComplete: options.onSessionComplete || null
    }
    this.sender = null
    this.receiver = null
    this.state = 'idle'
    this.sessionComplete = false // Flag to track session completion
    this.currentFileName = ''
    this.currentFileSize = 0
    this.bytesTransferred = 0
    this.fileBuffer = null
    this.pendingData = []
    this.resolveSession = null
    this.rejectSession = null
  }

  /**
   * Detect ZModem header in incoming data.
   */
  detectZmodem (data) {
    const str = data.toString('binary')
    const zhexIndex = str.indexOf('\x2a\x2a\x18\x42')
    const zbinIndex = str.indexOf('\x2a\x18\x42')

    if (zhexIndex === -1 && zbinIndex === -1) {
      return { detected: false, direction: null, initialData: null }
    }

    const startIndex = zhexIndex !== -1 ? zhexIndex : zbinIndex
    const headerStart = startIndex + (zhexIndex !== -1 ? 4 : 3)

    if (headerStart + 2 <= str.length) {
      const hexFrameType = str.substring(headerStart, headerStart + 2)
      const frameType = parseInt(hexFrameType, 16)
      console.log('[ZMODEM] Detected frame type:', hexFrameType, '(decimal:', frameType, ')')

      // Extract only the ZMODEM data (from the header start)
      const zmodemData = data.slice(startIndex)

      if (frameType === 0x00) {
        // ZRQINIT - remote wants to send, we should receive
        console.log('[ZMODEM] ZRQINIT detected - remote wants to send file')
        return { detected: true, direction: 'receive', initialData: zmodemData }
      } else if (frameType === 0x01) {
        // ZRINIT - remote ready to receive, we should send
        console.log('[ZMODEM] ZRINIT detected - remote ready to receive file')
        return { detected: true, direction: 'send', initialData: zmodemData }
      }
    }

    // Extract only the ZMODEM data (from the header start)
    const zmodemData = data.slice(zhexIndex !== -1 ? zhexIndex : zbinIndex)
    return { detected: true, direction: 'receive', initialData: zmodemData }
  }

  /**
   * Start a receive session (sz command - remote sends file to us).
   */
  startReceive (initialData = null) {
    if (this.state !== 'idle') {
      console.log('[ZMODEM] startReceive called but state is not idle:', this.state)
      return
    }

    console.log('[ZMODEM] Starting receive session')
    this.state = 'receiving'
    this.receiver = new Receiver()
    this.fileBuffer = []

    if (initialData !== null) {
      this.feedIncoming(initialData)
    }
  }

  /**
   * Start a send session (rz command - we send file to remote).
   */
  startSend (fileName, fileSize, fileData) {
    if (this.state !== 'idle') {
      console.log('[ZMODEM] startSend called but state is not idle:', this.state)
      return
    }

    console.log('[ZMODEM] Starting send session for file:', fileName, 'size:', fileSize)
    this.state = 'sending'
    this.currentFileName = fileName
    this.currentFileSize = fileSize
    this.bytesTransferred = 0
    this.fileBuffer = fileData

    // Create sender as initiator (we start the transfer)
    this.sender = new Sender()
    this.sender.startFile(fileName, fileSize)

    // Process pending data first
    for (const data of this.pendingData) {
      this.feedIncoming(data)
    }
    this.pendingData = []

    this.processSenderOutgoing()
  }

  /**
   * Strip non-ZMODEM data from incoming buffer.
   * ZMODEM data starts with **^B (0x2a 0x2a 0x18 0x42) or *^B (0x2a 0x18 0x42)
   * Only strips data if a ZMODEM header is found somewhere in the buffer.
   * If no header found, returns data as-is (it might be file data).
   */
  stripNonZmodemData (data) {
    const str = data.toString('binary')
    const zhexIndex = str.indexOf('\x2a\x2a\x18\x42')
    const zbinIndex = str.indexOf('\x2a\x18\x42')

    // If no ZMODEM header found, pass data through as-is
    // (it might be file data that doesn't start with header)
    if (zhexIndex === -1 && zbinIndex === -1) {
      return data
    }

    const startIndex = zhexIndex !== -1 ? zhexIndex : zbinIndex
    if (startIndex === 0) {
      return data // Data already starts with ZMODEM
    }

    console.log('[ZMODEM] Stripping', startIndex, 'bytes of non-ZMODEM data')
    return data.slice(startIndex)
  }

  /**
   * Feed incoming data to sender or receiver.
   * Uses a loop pattern similar to WASM reference to ensure all data is processed.
   */
  feedIncoming (data) {
    if (this.receiver !== null) {
      // Don't strip non-ZMODEM data during active receiver session
      // The receiver handles raw ZMODEM protocol data including file data
      let offset = 0
      let loopCount = 0
      const u8 = new Uint8Array(data)

      while (offset < u8.length && loopCount++ < 1000) {
        if (this.receiver === null) break
        try {
          const chunk = u8.subarray(offset)
          const consumed = this.receiver.feedIncoming(chunk)
          offset += consumed

          // Process outgoing, events, and file data
          const drained = this.pumpReceiver()

          // If we didn't consume input and didn't generate output/events, we are stuck
          if (consumed === 0 && !drained) {
            if (loopCount > 1) console.warn('[ZMODEM] Receiver stuck: 0 consumed, 0 drained')
            break
          }
        } catch (err) {
          console.error('[ZMODEM] Receiver error:', err.message)
          // On error, cleanup and reset
          this.state = 'error'
          this.cleanup()
          break
        }
      }
      console.log('[ZMODEM] Receiver total consumed:', offset, 'bytes out of', u8.length)
    } else if (this.sender !== null) {
      let offset = 0
      let loopCount = 0
      const u8 = new Uint8Array(data)

      while (offset < u8.length && loopCount++ < 1000) {
        if (this.sender === null) break
        try {
          const chunk = u8.subarray(offset)
          const consumed = this.sender.feedIncoming(chunk)
          offset += consumed

          // Process outgoing, events, and file requests
          const drained = this.pumpSender()

          // If we didn't consume input and didn't generate output/events, we are stuck
          if (consumed === 0 && !drained) {
            if (loopCount > 1) console.warn('[ZMODEM] Sender stuck: 0 consumed, 0 drained')
            break
          }
        } catch (err) {
          console.error('[ZMODEM] Sender error:', err.message)
          // On error, cleanup and reset
          this.state = 'error'
          this.cleanup()
          break
        }
      }
      console.log('[ZMODEM] Sender total consumed:', offset, 'bytes out of', u8.length)
    } else {
      // Store pending data for later
      this.pendingData.push(data)
    }
  }

  /**
   * Pump receiver: drain outgoing, process events, drain file data.
   * Returns true if any work was done.
   */
  pumpReceiver () {
    if (this.receiver === null) return false
    let didWork = false

    // Drain and send outgoing data
    const outgoing = this.receiver.drainOutgoing()
    if (outgoing.length > 0) {
      console.log('[ZMODEM] Receiver sending outgoing data:', outgoing.length, 'bytes')
      this.stream.write(Buffer.from(outgoing))
      this.receiver.advanceOutgoing(outgoing.length)
      didWork = true
    }

    // Process events
    let event
    while ((event = this.receiver.pollEvent()) !== null) {
      console.log('[ZMODEM] Receiver event:', event)
      didWork = true
      switch (event) {
        case ReceiverEvent.FileStart:
          this.currentFileName = this.receiver.getFileName()
          this.currentFileSize = this.receiver.getFileSize()
          this.bytesTransferred = 0
          this.fileBuffer = []
          console.log('[ZMODEM] File start:', this.currentFileName, 'size:', this.currentFileSize)
          if (this.options.onFileStart !== null) {
            this.options.onFileStart(this.currentFileName, this.currentFileSize)
          }
          break

        case ReceiverEvent.FileComplete:
          console.log('[ZMODEM] File complete:', this.currentFileName)
          this.saveReceivedFile()
          if (this.options.onFileComplete !== null) {
            this.options.onFileComplete(this.currentFileName)
          }
          break

        case ReceiverEvent.SessionComplete:
          console.log('[ZMODEM] Receive session complete')
          this.state = 'complete'
          this.sessionComplete = true
          if (this.options.onSessionComplete !== null) {
            this.options.onSessionComplete()
          }
          if (this.resolveSession !== null) {
            this.resolveSession()
          }
          this.cleanup()
          return true
      }
    }

    // Drain file data
    const fileData = this.receiver.drainFile()
    if (fileData.length > 0) {
      this.fileBuffer.push(Buffer.from(fileData))
      this.bytesTransferred += fileData.length
      this.receiver.advanceFile(fileData.length)

      const percentage = this.currentFileSize > 0
        ? Math.round((this.bytesTransferred / this.currentFileSize) * 100)
        : 0
      console.log('[ZMODEM] Receive progress:', this.bytesTransferred, '/', this.currentFileSize, '(', percentage, '%)')

      if (this.options.onProgress !== null) {
        this.options.onProgress(this.bytesTransferred, this.currentFileSize, percentage)
      }
      didWork = true
    }

    return didWork
  }

  /**
   * Pump sender: drain outgoing, process events, handle file requests.
   * Returns true if any work was done.
   */
  pumpSender () {
    if (this.sender === null) return false
    let didWork = false

    // Drain and send outgoing data
    const outgoing = this.sender.drainOutgoing()
    if (outgoing.length > 0) {
      console.log('[ZMODEM] Sender sending outgoing data:', outgoing.length, 'bytes')
      this.stream.write(Buffer.from(outgoing))
      this.sender.advanceOutgoing(outgoing.length)
      didWork = true
    }

    // Process events
    let event
    while ((event = this.sender.pollEvent()) !== null) {
      console.log('[ZMODEM] Sender event:', event)
      didWork = true
      switch (event) {
        case SenderEvent.FileComplete:
          console.log('[ZMODEM] Sender file complete:', this.currentFileName)
          if (this.options.onFileComplete !== null) {
            this.options.onFileComplete(this.currentFileName)
          }
          // After file complete, finish the session to send ZEOF and complete handshake
          console.log('[ZMODEM] Calling finishSession() to complete handshake')
          this.sender.finishSession()
          // Drain outgoing immediately after finishSession
          const finishOutgoing = this.sender.drainOutgoing()
          if (finishOutgoing.length > 0) {
            console.log('[ZMODEM] Sender sending finish outgoing:', finishOutgoing.length, 'bytes')
            this.stream.write(Buffer.from(finishOutgoing))
            this.sender.advanceOutgoing(finishOutgoing.length)
          }
          break

        case SenderEvent.SessionComplete:
          console.log('[ZMODEM] Send session complete')
          this.state = 'complete'
          this.sessionComplete = true
          if (this.options.onSessionComplete !== null) {
            this.options.onSessionComplete()
          }
          if (this.resolveSession !== null) {
            this.resolveSession()
          }
          this.cleanup()
          return true
      }
    }

    // Handle file requests
    const request = this.sender.pollFile()
    if (request !== null) {
      const { offset, len } = request
      const data = this.fileBuffer.slice(offset, offset + len)

      if (data.length > 0) {
        console.log('[ZMODEM] Sender feeding file data at offset:', offset, 'len:', data.length)
        this.sender.feedFile(data)
        this.bytesTransferred = offset + data.length

        const percentage = this.currentFileSize > 0
          ? Math.round((this.bytesTransferred / this.currentFileSize) * 100)
          : 0
        console.log('[ZMODEM] Send progress:', this.bytesTransferred, '/', this.currentFileSize, '(', percentage, '%)')

        if (this.options.onProgress !== null) {
          this.options.onProgress(this.bytesTransferred, this.currentFileSize, percentage)
        }

        // Drain outgoing after feeding file data
        const fileOutgoing = this.sender.drainOutgoing()
        if (fileOutgoing.length > 0) {
          console.log('[ZMODEM] Sender sending file outgoing:', fileOutgoing.length, 'bytes')
          this.stream.write(Buffer.from(fileOutgoing))
          this.sender.advanceOutgoing(fileOutgoing.length)
        }
        didWork = true
      } else if (offset >= this.currentFileSize) {
        console.log('[ZMODEM] Sender finishing session, offset:', offset, 'fileSize:', this.currentFileSize)
        this.sender.finishSession()
        // Drain outgoing after finish
        const endOutgoing = this.sender.drainOutgoing()
        if (endOutgoing.length > 0) {
          this.stream.write(Buffer.from(endOutgoing))
          this.sender.advanceOutgoing(endOutgoing.length)
        }
        didWork = true
      }
    }

    return didWork
  }

  /**
   * Save received file to disk.
   * Uses unique filename if file already exists.
   */
  saveReceivedFile () {
    if (this.currentFileName && this.fileBuffer.length > 0) {
      const downloadDir = this.options.downloadDir
      if (!existsSync(downloadDir)) {
        mkdirSync(downloadDir, { recursive: true })
      }

      // Get unique file path (adds .1, .2 etc. if file exists)
      const filePath = getUniqueFilePath(downloadDir, this.currentFileName)
      const fileData = Buffer.concat(this.fileBuffer)

      try {
        writeFileSync(filePath, fileData)
        console.log('[ZMODEM] File saved:', filePath, 'size:', fileData.length)
      } catch (err) {
        console.error('[ZMODEM] Failed to save file:', err.message)
      }
    }
  }

  /**
   * Clean up session state.
   */
  cleanup () {
    this.sender = null
    this.receiver = null
    this.state = 'idle'
    this.currentFileName = ''
    this.currentFileSize = 0
    this.bytesTransferred = 0
    this.fileBuffer = null
    this.pendingData = []
    // Note: sessionComplete flag is NOT reset here - it persists until explicitly reset
  }

  /**
   * Reset session for a new transfer.
   */
  reset () {
    this.cleanup()
    this.sessionComplete = false
  }

  /**
   * Wait for session to complete.
   */
  waitForComplete () {
    return new Promise((resolve, reject) => {
      this.resolveSession = resolve
      this.rejectSession = reject
    })
  }
}

export default ZmodemSession
