import { Terminal, IDisposable } from '@xterm/xterm'
import { Receiver, Sender, SenderEvent, ReceiverEvent } from 'zmodem2-js'

export default class AddonZmodemWasm {
  _disposables: IDisposable[] = []
  socket: WebSocket | null = null
  term: Terminal | null = null
  receiver: Receiver | null = null
  sender: Sender | null = null
  wasmInitialized = false
  onDetect: ((type: 'receive' | 'send') => void) | null = null
  isPickingFile = false
  
  // FIX: Add a flag to prevent concurrent reads
  _reading = false
  
  // Buffer for read-ahead
  _fileBuffer: Uint8Array | null = null
  _fileBufferOffset = 0
  readonly BUFFER_SIZE = 10 * 1024 * 1024 // 10MB
  
  currentFile: { name: string, size: number, data: Uint8Array[] } | null = null
  sendingFile: File | null = null
  
  // Debug mode - set to true to enable verbose logging
  readonly DEBUG = false

  constructor() {
    this.initWasm()
  }

  /**
   * Send log to server via WebSocket
   */
  sendLogToServer(level: string, ...args: any[]) {
    const message = args.map(a => {
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      }
      return String(a)
    }).join(' ')
    
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: 'log', level, message }))
      } catch {
        // Ignore send errors
      }
    }
  }

  debug(...args: any[]) {
    if (this.DEBUG) {
      console.log('[ZMODEM]', ...args)
      this.sendLogToServer('DEBUG', ...args)
    }
  }

  info(...args: any[]) {
    console.log('[ZMODEM]', ...args)
    this.sendLogToServer('INFO', ...args)
  }

  error(...args: any[]) {
    console.error('[ZMODEM ERROR]', ...args)
    this.sendLogToServer('ERROR', ...args)
  }

  async initWasm() {
    this.wasmInitialized = true
    this.info('JS initialized')
  }

  activate(terminal: Terminal) {
    this.term = terminal
  }

  dispose() {
    this.receiver = null
    this.sender = null
    this._fileBuffer = null
    this._disposables.forEach(d => d.dispose())
    this._disposables = []
  }

  zmodemAttach(ctx: { socket: WebSocket, term: Terminal, onDetect?: (type: 'receive' | 'send') => void }) {
    this.socket = ctx.socket
    this.term = ctx.term
    this.socket.binaryType = 'arraybuffer'
    if (ctx.onDetect) this.onDetect = ctx.onDetect
    this.info('zmodemAttach called')
  }

  consume(data: ArrayBuffer | string) {
    try {
      this._consumeInternal(data)
    } catch (e) {
      this.error('Uncaught error in consume:', e)
      this.term?.writeln('\r\nZMODEM: Fatal error - ' + e)
      // Reset state to prevent further issues
      this.receiver = null
      this.sender = null
    }
  }

  _consumeInternal(data: ArrayBuffer | string) {
    if (!this.wasmInitialized) {
        if (typeof data === 'string') this.term?.write(data)
        else this.term?.write(new Uint8Array(data))
        return
    }

    if (this.receiver) {
      this.handleReceiver(data)
      return
    }

    if (this.sender) {
      this.handleSender(data)
      return
    }
    
    if (typeof data === 'string') {
      this.term?.write(data)
      return
    }

    const u8 = new Uint8Array(data)
    
    // Detection: ** + \x18 + B (ZHEX)
    let foundIdx = -1
    for (let i = 0; i < u8.length - 3; i++) {
      if (u8[i] === 0x2a && u8[i+1] === 0x2a && u8[i+2] === 0x18 && u8[i+3] === 0x42) {
        foundIdx = i
        break
      }
    }
    
    if (foundIdx >= 0) {
      // Check next 2 bytes for Frame Type (Hex Encoded)
      // ZRQINIT = 00 (0x30 0x30) -> Receiver
      // ZRINIT  = 01 (0x30 0x31) -> Sender
      if (foundIdx + 5 < u8.length) {
          const typeHex1 = u8[foundIdx + 4]
          const typeHex2 = u8[foundIdx + 5]
          
          if (typeHex1 === 0x30 && typeHex2 === 0x30) {
              this.info('ZRQINIT detected (Receive)')
               if (foundIdx > 0) {
                this.term?.write(u8.subarray(0, foundIdx))
              }
              this.startReceiver(u8.subarray(foundIdx))
              return
          } else if (typeHex1 === 0x30 && typeHex2 === 0x31) {
              this.info('ZRINIT detected (Send)')
              if (!this.isPickingFile) {
                  this.isPickingFile = true
                  this.onDetect?.('send')
              }
              return
          }
      }
      
      // Fallback if not sure
      this.term?.write(u8)
    } else {
      this.term?.write(u8)
    }
  }

  async sendFile(file: File) {
      this.isPickingFile = false
      this.sendingFile = file
      this.sender = new Sender()
      this._reading = false // Reset reading state
      this._fileBuffer = null
      this._fileBufferOffset = 0
      
      this.info(`Starting Sender for ${file.name} (${file.size} bytes)`)
      try {
          this.sender.startFile(file.name, file.size)
          this.pumpSender()
      } catch (e) {
          this.error('Failed to start sender', e)
          this.term?.writeln('\r\nZMODEM: Failed to start send - ' + e)
          this.sender = null
      }
  }

  handleSender(data: ArrayBuffer | Uint8Array | string) {
      if (!this.sender) return
      const u8 = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
      
      let offset = 0
      let loopCount = 0
      
      while (offset < u8.length && loopCount++ < 1000) {
          if (!this.sender) break
          try {
              const chunk = u8.subarray(offset)
              const consumed = this.sender.feedIncoming(chunk)
              this.debug(`Sender consumed ${consumed} bytes`)
              offset += consumed
              
              const drained = this.pumpSender()
              
              // If we didn't consume input and didn't generate output/events, we are stuck.
              if (consumed === 0 && !drained) {
                  // But maybe the sender is just waiting for file data and can't consume more ACKs?
                  if (loopCount > 1) this.debug('Sender stuck: 0 consumed, 0 drained')
                  break
              }
          } catch (e) {
              this.error('Sender error:', e)
              this.term?.writeln('\r\nZMODEM Sender Error: ' + e)
              this.sender = null
              this.sendingFile = null
              this._fileBuffer = null
              break
          }
      }
  }

  pumpSender(): boolean {
      if (!this.sender) return false
      let didWork = false
      
      const outgoingChunks: Uint8Array[] = []
      let totalOutgoingSize = 0
      const FLUSH_THRESHOLD = 64 * 1024 // 64KB

      const flushOutgoing = () => {
          if (outgoingChunks.length === 0) return
          if (outgoingChunks.length === 1) {
              this.socket?.send(outgoingChunks[0])
          } else {
              this.socket?.send(new Blob(outgoingChunks as any))
          }
          this.debug(`Flushed ${totalOutgoingSize} bytes`)
          outgoingChunks.length = 0
          totalOutgoingSize = 0
      }

      try {
          const outgoing = this.sender.drainOutgoing()
          if (outgoing && outgoing.length > 0) {
              this.debug(`Drained ${outgoing.length} outgoing bytes`)
              outgoingChunks.push(outgoing)
              totalOutgoingSize += outgoing.length
              didWork = true
          }

          while (true) {
              // Check for file data requests first
              const fileRequest = this.sender.pollFile()
              if (fileRequest) {
                  this.debug(`File request: offset=${fileRequest.offset}, len=${fileRequest.len}`)
                  const start = fileRequest.offset
                  const length = fileRequest.len

                  // 1. Try to serve from buffer synchronously
                  if (this._fileBuffer && 
                      start >= this._fileBufferOffset && 
                      (start + length) <= (this._fileBufferOffset + this._fileBuffer.byteLength)) {
                      
                      const relativeStart = start - this._fileBufferOffset
                      const chunk = this._fileBuffer.subarray(relativeStart, relativeStart + length)
                      this.sender.feedFile(chunk)
                      this.debug(`Fed ${chunk.length} bytes from buffer`)

                      // IMPORTANT: Drain outgoing data immediately after feeding
                      const outgoing = this.sender.drainOutgoing()
                      if (outgoing && outgoing.length > 0) {
                          outgoingChunks.push(outgoing)
                          totalOutgoingSize += outgoing.length
                          
                          if (totalOutgoingSize > FLUSH_THRESHOLD) {
                              flushOutgoing()
                          }
                      }
                      
                      // Continue loop synchronously
                      continue
                  }

                  // 2. Not in buffer, need to load
                  // FIX: Check if we are already reading to avoid race conditions
                  if (this.sendingFile && !this._reading) {
                      flushOutgoing() // Flush before async break
                      this._reading = true // Lock
                      this.loadBufferAndFeed(start, length)
                      
                      // Break loop to wait for async read
                      break 
                  } else if (this._reading) {
                      // Already reading, break loop and wait for that to finish
                      break
                  }
              }

              // Check for events
              const event = this.sender.pollEvent()
              if (!event) break

              didWork = true
              this.info('Sender event:', event)

              if (event === SenderEvent.FileComplete) {
                  this.term?.writeln('\r\nZMODEM: File sent.')
                  this.sender.finishSession()
              } else if (event === SenderEvent.SessionComplete) {
                  this.term?.writeln('\r\nZMODEM: Session complete.')
                  this.sender = null
                  this.sendingFile = null
                  this._fileBuffer = null
                  flushOutgoing() // Flush final packets
                  return true
              }
          }
      } catch (e) {
          this.error('Pump Sender Error:', e)
          this.term?.writeln('\r\nZMODEM Pump Error: ' + e)
          this.sender = null
      }
      
      flushOutgoing() // Flush anything remaining at end of loop
      return didWork
  }

  async loadBufferAndFeed(offset: number, length: number) {
      if (!this.sender || !this.sendingFile) {
          this._reading = false
          return
      }
      try {
          // Read a larger chunk to minimize I/O and async overhead
          const readSize = Math.max(length, this.BUFFER_SIZE)
          const end = Math.min(offset + readSize, this.sendingFile.size)
          const slice = this.sendingFile.slice(offset, end)

          this.debug(`Loading buffer: offset=${offset}, end=${end}, size=${end - offset}`)
          const buffer = await slice.arrayBuffer()
          if (!this.sender) return
          const u8 = new Uint8Array(buffer)

          // Update buffer
          this._fileBuffer = u8
          this._fileBufferOffset = offset

          // Feed the requested part
          // Since we read from 'offset', the requested data starts at 0 in the new buffer
          // Note: u8.length might be less than length if we hit EOF
          const feedLen = Math.min(length, u8.length)
          const chunk = u8.subarray(0, feedLen)
          
          this.debug(`Feeding ${chunk.length} bytes`)
          this.sender.feedFile(chunk)
          
          // Unlock BEFORE pumping
          this._reading = false 
          
          this.pumpSender()
      } catch (e) {
          this.error('Buffer read error', e)
          
          // Ensure we unlock on error
          this._reading = false
          
          // Try to pump again to see if we can recover
          try { this.pumpSender() } catch (_) {}
      }
  }

  startReceiver(initialData: Uint8Array) {
    this.info('Starting Receiver...')
    try {
        this.receiver = new Receiver()
        this.handleReceiver(initialData)
    } catch (e) {
        this.error('Failed to create Receiver', e)
        this.term?.writeln('\r\nZMODEM: Failed to start receiver - ' + e)
        this.receiver = null
    }
  }

  handleReceiver(data: ArrayBuffer | Uint8Array | string) {
    if (!this.receiver) return
    const u8 = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)

    this.debug(`handleReceiver: ${u8.length} bytes`)

    let offset = 0
    let loopCount = 0

    while (offset < u8.length && loopCount++ < 1000) {
        if (!this.receiver) break
        try {
            const chunk = u8.subarray(offset)
            const consumed = this.receiver.feedIncoming(chunk)
            this.debug(`Receiver consumed ${consumed} bytes`)
            offset += consumed
            
            const drained = this.pumpReceiver()
            
            if (consumed === 0 && !drained) {
                 if (loopCount > 1) this.debug('Receiver stuck: 0 consumed, 0 drained')
                 break
            }
        } catch (e) {
            this.error('Receiver error:', e, (e as any)?.details)
            this.term?.writeln('\r\nZMODEM: Error ' + e + ' ' + JSON.stringify((e as any)?.details || {}))
            this.receiver = null
            this.currentFile = null
            break
        }
    }
  }

  pumpReceiver(): boolean {
      if (!this.receiver) return false
      let didWork = false
      
      try {
        const outgoing = this.receiver.drainOutgoing()
        if (outgoing && outgoing.length > 0) {
            this.debug(`Sending ${outgoing.length} outgoing bytes`)
            this.socket?.send(outgoing)
            didWork = true
        }
        
        // Process events first
        while (true) {
            const event = this.receiver.pollEvent()
            if (!event) break
            
            this.info('Receiver Event:', event)
            didWork = true
            
            if (event === ReceiverEvent.FileStart) {
                const name = this.receiver.getFileName()
                const size = this.receiver.getFileSize()
                this.term?.writeln(`\r\nZMODEM: Receiving ${name} (${size} bytes)...`)
                this.currentFile = { name, size, data: [] }
            } else if (event === ReceiverEvent.FileComplete) {
                this.term?.writeln('\r\nZMODEM: File complete.')
                this.saveFile()
            } else if (event === ReceiverEvent.SessionComplete) {
                this.term?.writeln('\r\nZMODEM: Session complete.')
                this.receiver = null
                this.currentFile = null
                return true
            }
        }
        
        // Then drain file data
        const chunk = this.receiver.drainFile()
        if (chunk && chunk.length > 0) {
            this.debug(`Drained ${chunk.length} file bytes`)
            if (this.currentFile) {
                this.currentFile.data.push(chunk)
                didWork = true
            } else {
                this.error('Got file data but no currentFile!')
            }
        }
        
      } catch (e) {
          this.error('Receiver pump error:', e)
          this.term?.writeln('\r\nZMODEM: Error ' + e)
          this.receiver = null
          this.currentFile = null
      }
      return didWork
  }

  saveFile() {
    if (!this.currentFile) return
    try {
      const blob = new Blob(this.currentFile.data as any, { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = this.currentFile.name
      a.click()
      URL.revokeObjectURL(url)
      this.info(`Saved file: ${this.currentFile.name}`)
    } catch (e) {
      this.error('Failed to save file:', e)
      this.term?.writeln('\r\nZMODEM: Failed to save file - ' + e)
    }
    this.currentFile = null
  }
}
