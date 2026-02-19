/**
 * ZMODEM transmission state and logic.
 *
 * @module zmodem2-js/transmission
 */

import { ZDLE, ZPAD, SUBPACKET_MAX_SIZE, SUBPACKET_PER_ACK } from './constants.js'
import { MalformedPacketError, MalformedFileNameError, MalformedFileSizeError, MalformedHeaderError, OutOfMemoryError, UnexpectedCrc16Error, UnexpectedCrc32Error, UnexpectedEofError, UnsupportedError } from './error.js'
import { Encoding, Frame, Header, ZACK_HEADER, ZDATA_HEADER, ZEOF_HEADER, ZFIN_HEADER, ZNAK_HEADER, ZRPOS_HEADER, ZRQINIT_HEADER, decodeHeader, createZrinit, writeSliceEscaped, Zrinit } from './header.js'
import { Crc16, Crc32 } from './crc.js'
import { UNZDLE_TABLE } from './zdle.js'

/**
 * The ZMODEM protocol subpacket type.
 */
export enum SubpacketType {
  /** End of frame, CRC next */
  ZCRCE = 0x68,
  /** Data continues, CRC next */
  ZCRCG = 0x69,
  /** Data continues, CRC next, ZACK expected */
  ZCRCQ = 0x6a,
  /** End of frame, CRC next, ZACK expected */
  ZCRCW = 0x6b
}

/**
 * Creates a SubpacketType from a byte value.
 * @param value - The byte value
 * @returns The SubpacketType
 * @throws MalformedPacketError if the value is not a valid subpacket type
 */
export function subpacketTypeFromByte (value: number): SubpacketType {
  switch (value) {
    case 0x68:
      return SubpacketType.ZCRCE
    case 0x69:
      return SubpacketType.ZCRCG
    case 0x6a:
      return SubpacketType.ZCRCQ
    case 0x6b:
      return SubpacketType.ZCRCW
    default:
      throw new MalformedPacketError(value)
  }
}

/**
 * A request for file data from the sender.
 */
export interface FileRequest {
  /** The offset in the file to read from */
  offset: number
  /** The number of bytes to read */
  len: number
}

/**
 * Events emitted by the Sender.
 */
export enum SenderEvent {
  /** File transfer complete */
  FileComplete = 'FileComplete',
  /** Session complete */
  SessionComplete = 'SessionComplete'
}

/**
 * Events emitted by the Receiver.
 */
export enum ReceiverEvent {
  /** File transfer starting */
  FileStart = 'FileStart',
  /** File transfer complete */
  FileComplete = 'FileComplete',
  /** Session complete */
  SessionComplete = 'SessionComplete'
}

/**
 * Internal state for reading a subpacket byte-by-byte.
 */
enum SubpacketState {
  Idle,
  Reading,
  Writing,
  Crc
}

/**
 * Internal state for ZPAD detection.
 */
enum ZpadState {
  Idle,
  Zpad,
  ZpadZpad
}

/**
 * Internal state for header reading.
 */
enum HeaderReadState {
  SeekingZpad,
  ReadingEncoding,
  ReadingData
}

/**
 * Internal state for the sender.
 */
enum SendState {
  WaitReceiverInit,
  ReadyForFile,
  WaitFilePos,
  NeedFileData,
  WaitFileAck,
  WaitFileDone,
  WaitFinish,
  Done
}

/**
 * Internal state for the receiver.
 */
enum RecvState {
  SessionBegin,
  FileBegin,
  FileReadingMetadata,
  FileReadingSubpacket,
  FileWaitingSubpacket,
  SessionEnd
}

/**
 * A simple buffer class for managing byte arrays.
 */
class Buffer {
  private data: number[]
  private writeOffset: number = 0

  constructor (private readonly capacity: number) {
    this.data = []
  }

  get length (): number {
    return this.data.length
  }

  clear (): void {
    this.data = []
    this.writeOffset = 0
  }

  push (byte: number): void {
    if (this.data.length >= this.capacity) {
      throw new OutOfMemoryError()
    }
    this.data.push(byte & 0xFF)
  }

  extend (bytes: Uint8Array | number[]): void {
    for (const byte of bytes) {
      this.push(byte)
    }
  }

  slice (start?: number, end?: number): Uint8Array {
    return new Uint8Array(this.data.slice(start, end))
  }

  get (index: number): number {
    return this.data[index]
  }

  setWriteOffset (offset: number): void {
    this.writeOffset = offset
  }

  get writeOffsetValue (): number {
    return this.writeOffset
  }
}

/**
 * ZMODEM sender state machine.
 */
export class Sender {
  private state: SendState = SendState.WaitReceiverInit
  private fileName: string = ''
  private fileSize: number = 0
  private hasFile: boolean = false
  private pendingRequest: FileRequest | null = null
  private frameRemaining: number = 0
  private frameNeedsHeader: boolean = false
  private maxSubpacketSize: number = SUBPACKET_MAX_SIZE
  private maxSubpacketsPerAck: number = SUBPACKET_PER_ACK
  private readonly buf: Buffer = new Buffer(SUBPACKET_MAX_SIZE)
  private readonly outgoing: Buffer = new Buffer(2048)
  private outgoingOffset: number = 0
  private readonly headerReader: HeaderReader = new HeaderReader()
  private pendingEvent: SenderEvent | null = null
  private finishRequested: boolean = false
  readonly initiator: boolean = true

  /**
   * Creates a new sender instance.
   * @param initiator - If true, sender initiates by sending ZRQINIT. If false, waits for ZRINIT.
   */
  constructor (initiator: boolean = true) {
    this.initiator = initiator
    if (initiator) {
      this.queueZrqinit()
    }
  }

  /**
   * Starts sending a file with the provided metadata.
   * @param fileName - The name of the file
   * @param fileSize - The size of the file in bytes
   */
  startFile (fileName: string, fileSize: number): void {
    if (this.state === SendState.Done || this.state === SendState.WaitFinish ||
        (this.state !== SendState.WaitReceiverInit && this.state !== SendState.ReadyForFile)) {
      throw new UnsupportedError()
    }

    this.fileName = fileName
    this.fileSize = fileSize
    this.hasFile = true
    this.pendingRequest = null
    this.frameRemaining = 0
    this.frameNeedsHeader = false

    if (this.state === SendState.ReadyForFile) {
      if (this.hasOutgoing()) {
        throw new UnsupportedError()
      }
      this.queueZfile()
      this.state = SendState.WaitFilePos
    }
  }

  /**
   * Requests to finish the session after the current file completes.
   */
  finishSession (): void {
    this.finishRequested = true
    if (this.state === SendState.ReadyForFile) {
      if (this.hasOutgoing()) {
        throw new UnsupportedError()
      }
      this.queueZfin()
      this.state = SendState.WaitFinish
    }
  }

  /**
   * Returns a pending file data request, if any.
   */
  pollFile (): FileRequest | null {
    return this.pendingRequest
  }

  /**
   * Feeds a chunk of file data for the current request.
   * @param data - The file data to send
   */
  feedFile (data: Uint8Array): void {
    if (this.state !== SendState.NeedFileData) {
      throw new UnsupportedError()
    }
    if (this.pendingRequest === null) {
      throw new UnsupportedError()
    }

    const request = this.pendingRequest

    if (data.length === 0) {
      throw new UnexpectedEofError()
    }
    if (data.length > request.len) {
      throw new UnexpectedEofError()
    }
    const remaining = Math.max(0, this.fileSize - request.offset)
    if (data.length > remaining) {
      throw new UnexpectedEofError()
    }
    if (this.hasOutgoing()) {
      throw new UnsupportedError()
    }

    const offset = request.offset
    const nextOffset = offset + data.length
    const remainingAfter = Math.max(0, this.fileSize - nextOffset)
    const maxLen = Math.min(this.maxSubpacketSize, remainingAfter)
    const isLastInFrame =
      this.frameRemaining <= 1 || data.length < request.len || remainingAfter === 0
    const kind = isLastInFrame ? SubpacketType.ZCRCW : SubpacketType.ZCRCG

    this.queueZdata(offset, data, kind, this.frameNeedsHeader)
    this.frameNeedsHeader = false

    if (this.frameRemaining > 0) {
      this.frameRemaining--
    }

    if (isLastInFrame) {
      this.pendingRequest = null
      this.state = SendState.WaitFileAck
      this.frameRemaining = 0
    } else {
      this.pendingRequest = { offset: nextOffset, len: maxLen }
    }
  }

  /**
   * Feeds incoming wire data into the state machine.
   * @param input - The incoming data
   * @returns The number of bytes consumed
   */
  feedIncoming (input: Uint8Array): number {
    let consumed = 0

    while (true) {
      if (this.hasOutgoing() || this.state === SendState.Done || this.pendingRequest !== null) {
        break
      }

      const before = consumed
      const header = this.headerReader.read(input, consumed)
      if (header === null) {
        break
      }
      consumed = header.consumed

      this.handleHeader(header.header)

      if (consumed === before || consumed === input.length) {
        break
      }
    }

    return consumed
  }

  /**
   * Returns pending outgoing bytes and automatically advances the buffer.
   * This matches the WASM behavior where drain automatically advances.
   */
  drainOutgoing (): Uint8Array {
    const data = this.outgoing.slice(this.outgoingOffset)
    // Auto-advance to match WASM behavior
    this.outgoing.clear()
    this.outgoingOffset = 0
    return data
  }

  /**
   * Advances the outgoing cursor by n bytes.
   * @param n - The number of bytes to advance
   * @deprecated Use drainOutgoing() which auto-advances
   */
  advanceOutgoing (n: number): void {
    const remaining = this.outgoing.length - this.outgoingOffset
    n = Math.min(n, remaining)
    this.outgoingOffset += n
    if (this.outgoingOffset >= this.outgoing.length) {
      this.outgoing.clear()
      this.outgoingOffset = 0
    }
  }

  /**
   * Returns the next pending sender event.
   */
  pollEvent (): SenderEvent | null {
    const event = this.pendingEvent
    this.pendingEvent = null
    return event
  }

  private hasOutgoing (): boolean {
    return this.outgoingOffset < this.outgoing.length
  }

  private queueZrqinit (): void {
    const header = ZRQINIT_HEADER.encode()
    this.outgoing.clear()
    this.outgoing.extend(header)
    this.outgoingOffset = 0
  }

  private queueZfile (): void {
    const result: number[] = []

    // Write ZFILE header
    const header = new Header(Encoding.ZBIN32, Frame.ZFILE).encode()
    result.push(...header)

    // Build file info
    const fileInfo: number[] = []
    for (let i = 0; i < this.fileName.length; i++) {
      fileInfo.push(this.fileName.charCodeAt(i))
    }
    fileInfo.push(0) // null terminator
    const sizeStr = this.fileSize.toString()
    for (let i = 0; i < sizeStr.length; i++) {
      fileInfo.push(sizeStr.charCodeAt(i))
    }
    fileInfo.push(0) // null terminator

    // Write subpacket with ZCRCW
    const escaped = writeSliceEscaped(new Uint8Array(fileInfo))
    result.push(...escaped)
    result.push(ZDLE)
    result.push(SubpacketType.ZCRCW)

    // CRC32
    const crc = new Crc32()
    crc.update(new Uint8Array(fileInfo))
    crc.updateByte(SubpacketType.ZCRCW)
    const crcValue = crc.finalize()
    const crcBytes = new Uint8Array([
      crcValue & 0xFF,
      (crcValue >> 8) & 0xFF,
      (crcValue >> 16) & 0xFF,
      (crcValue >> 24) & 0xFF
    ])
    result.push(...writeSliceEscaped(crcBytes))

    this.outgoing.clear()
    this.outgoing.extend(result)
    this.outgoingOffset = 0
  }

  private queueZdata (offset: number, data: Uint8Array, kind: SubpacketType, includeHeader: boolean): void {
    const result: number[] = []

    if (includeHeader) {
      const header = ZDATA_HEADER.withCount(offset).encode()
      result.push(...header)
    }

    // Write escaped data
    result.push(...writeSliceEscaped(data))
    result.push(ZDLE)
    result.push(kind)

    // CRC32
    const crc = new Crc32()
    crc.update(data)
    crc.updateByte(kind)
    const crcValue = crc.finalize()
    const crcBytes = new Uint8Array([
      crcValue & 0xFF,
      (crcValue >> 8) & 0xFF,
      (crcValue >> 16) & 0xFF,
      (crcValue >> 24) & 0xFF
    ])
    result.push(...writeSliceEscaped(crcBytes))

    this.outgoing.clear()
    this.outgoing.extend(result)
    this.outgoingOffset = 0
  }

  private queueZeof (offset: number): void {
    const header = ZEOF_HEADER.withCount(offset).encode()
    this.outgoing.clear()
    this.outgoing.extend(header)
    this.outgoingOffset = 0
  }

  private queueZfin (): void {
    const header = ZFIN_HEADER.encode()
    this.outgoing.clear()
    this.outgoing.extend(header)
    this.outgoingOffset = 0
  }

  private queueNak (): void {
    const header = ZNAK_HEADER.encode()
    this.outgoing.clear()
    this.outgoing.extend(header)
    this.outgoingOffset = 0
  }

  private queueOo (): void {
    this.outgoing.clear()
    this.outgoing.extend([0x4f, 0x4f]) // "OO"
    this.outgoingOffset = 0
  }

  private handleHeader (header: Header): void {
    switch (header.frame) {
      case Frame.ZRINIT:
        this.onZrinit(header)
        break
      case Frame.ZRPOS:
      case Frame.ZACK:
        this.onZrpos(header.count)
        break
      case Frame.ZFIN:
        this.onZfin()
        break
      default:
        if (this.state === SendState.WaitReceiverInit) {
          this.queueZrqinit()
        }
    }
  }

  private onZrinit (header: Header): void {
    this.updateReceiverCaps(header)
    switch (this.state) {
      case SendState.WaitReceiverInit:
        if (this.hasFile) {
          this.queueZfile()
          this.state = SendState.WaitFilePos
        } else {
          this.state = SendState.ReadyForFile
          if (this.finishRequested) {
            this.queueZfin()
            this.state = SendState.WaitFinish
          }
        }
        break
      case SendState.WaitFileDone:
        this.pendingEvent = SenderEvent.FileComplete
        this.hasFile = false
        if (this.finishRequested) {
          this.queueZfin()
          this.state = SendState.WaitFinish
        } else {
          this.state = SendState.ReadyForFile
        }
        break
      case SendState.WaitFinish:
        this.queueOo()
        this.state = SendState.Done
        this.pendingEvent = SenderEvent.SessionComplete
        break
    }
  }

  private updateReceiverCaps (header: Header): void {
    const flags = header.flags
    const rxBufSize = flags[0] | (flags[1] << 8)
    const caps = flags[2] | (flags[3] << 8)
    const canOvio = (caps & Zrinit.CANOVIO) !== 0

    if (rxBufSize === 0) {
      this.maxSubpacketSize = SUBPACKET_MAX_SIZE
      this.maxSubpacketsPerAck = canOvio ? SUBPACKET_PER_ACK : 1
      return
    }

    this.maxSubpacketSize = Math.min(SUBPACKET_MAX_SIZE, rxBufSize)
    if (!canOvio) {
      this.maxSubpacketsPerAck = 1
      return
    }

    const subpackets = Math.floor(rxBufSize / this.maxSubpacketSize)
    this.maxSubpacketsPerAck = subpackets === 0 ? 1 : subpackets
  }

  private onZrpos (offset: number): void {
    switch (this.state) {
      case SendState.WaitReceiverInit:
        this.queueZrqinit()
        break
      case SendState.WaitFilePos:
      case SendState.WaitFileAck:
      case SendState.NeedFileData:
        if (offset >= this.fileSize) {
          this.queueZeof(offset)
          this.state = SendState.WaitFileDone
          this.pendingRequest = null
        } else {
          const remaining = this.fileSize - offset
          const maxSubpackets = Math.ceil(remaining / this.maxSubpacketSize)
          this.frameRemaining = Math.min(this.maxSubpacketsPerAck, maxSubpackets)
          this.frameNeedsHeader = true
          const len = Math.min(this.maxSubpacketSize, remaining)
          this.pendingRequest = { offset, len }
          this.state = SendState.NeedFileData
        }
        break
    }
  }

  private onZfin (): void {
    if (this.state === SendState.WaitFinish) {
      this.queueOo()
      this.state = SendState.Done
      this.pendingEvent = SenderEvent.SessionComplete
    }
  }
}

/**
 * ZMODEM receiver state machine.
 */
export class Receiver {
  private state: RecvState = RecvState.SessionBegin
  private count: number = 0
  private fileName: string = ''
  private fileSize: number = 0
  private readonly buf: Buffer = new Buffer(SUBPACKET_MAX_SIZE)
  private bufWriteOffset: number = 0
  private dataEncoding: Encoding = Encoding.ZBIN
  private readonly headerReader: HeaderReader = new HeaderReader()
  private subpacketState: SubpacketState = SubpacketState.Idle
  private subpacketType: SubpacketType = SubpacketType.ZCRCG
  private subpacketEscapePending: boolean = false
  private crcEscapePending: boolean = false // Separate escape state for CRC reading (like Rust's RxCrc)
  private crcBytesRead: number = 0 // Number of CRC bytes read so far (persists across calls)
  private crcBuf: number[] = [] // Partial CRC bytes (persists across calls)
  private crc16: Crc16 = new Crc16()
  private crc32: Crc32 = new Crc32()
  private readonly outgoing: Buffer = new Buffer(2048)
  private outgoingOffset: number = 0
  private pendingEvents: Array<ReceiverEvent | null> = [null, null, null, null]
  private pendingEventHead: number = 0
  private pendingEventLen: number = 0

  /**
   * Creates a new receiver instance.
   */
  constructor () {
    this.queueZrinit()
  }

  /**
   * Feeds incoming wire data into the state machine.
   * @param input - The incoming data
   * @returns The number of bytes consumed
   */
  feedIncoming (input: Uint8Array): number {
    let consumed = 0

    while (true) {
      if (this.hasFileData() || this.pendingEventsFull()) {
        break
      }

      const before = consumed

      if (this.state === RecvState.FileReadingSubpacket || this.state === RecvState.FileReadingMetadata) {
        const result = this.processSubpacket(input, consumed)
        if (result.done) {
          consumed = result.consumed
          if (this.hasOutgoing() || this.hasFileData() || this.pendingEventsFull()) {
            break
          }
          if (consumed === before) {
            break
          }
          continue
        } else {
          consumed = result.consumed
          break
        }
      }

      const header = this.headerReader.read(input, consumed)
      if (header === null) {
        break
      }
      consumed = header.consumed

      this.handleHeader(header.header)

      if (this.pendingEventsFull()) {
        break
      }

      // Break if we have outgoing data to send
      if (this.hasOutgoing()) {
        break
      }

      if (consumed === before || consumed === input.length) {
        break
      }
    }

    return consumed
  }

  /**
   * Returns pending outgoing bytes and automatically advances the buffer.
   * This matches the WASM behavior where drain automatically advances.
   */
  drainOutgoing (): Uint8Array {
    const data = this.outgoing.slice(this.outgoingOffset)
    // Auto-advance to match WASM behavior
    this.outgoing.clear()
    this.outgoingOffset = 0
    return data
  }

  /**
   * Advances the outgoing cursor by n bytes.
   * @param n - The number of bytes to advance
   * @deprecated Use drainOutgoing() which auto-advances
   */
  advanceOutgoing (n: number): void {
    const remaining = this.outgoing.length - this.outgoingOffset
    n = Math.min(n, remaining)
    this.outgoingOffset += n
    if (this.outgoingOffset >= this.outgoing.length) {
      this.outgoing.clear()
      this.outgoingOffset = 0
    }
  }

  /**
   * Returns pending file data bytes and automatically advances the buffer.
   * This matches the WASM behavior where drain automatically advances.
   */
  drainFile (): Uint8Array {
    if (this.subpacketState === SubpacketState.Writing) {
      const data = this.buf.slice(this.bufWriteOffset)
      // Auto-advance and finish subpacket to match WASM behavior
      this.finishSubpacket(this.subpacketType)
      return data
    }
    return new Uint8Array(0)
  }

  /**
   * Advances the file output cursor by n bytes.
   * @param n - The number of bytes to advance
   */
  advanceFile (n: number): void {
    if (this.subpacketState !== SubpacketState.Writing) {
      return
    }

    const remaining = this.buf.length - this.bufWriteOffset
    n = Math.min(n, remaining)
    this.bufWriteOffset += n

    if (this.bufWriteOffset < this.buf.length) {
      return
    }

    this.finishSubpacket(this.subpacketType)
  }

  /**
   * Returns the next pending receiver event.
   */
  pollEvent (): ReceiverEvent | null {
    return this.popEvent()
  }

  /**
   * Returns the current file name.
   */
  getFileName (): string {
    return this.fileName
  }

  /**
   * Returns the current file size.
   */
  getFileSize (): number {
    return this.fileSize
  }

  private hasOutgoing (): boolean {
    return this.outgoingOffset < this.outgoing.length
  }

  private hasFileData (): boolean {
    return this.subpacketState === SubpacketState.Writing
  }

  private pendingEventsFull (): boolean {
    return this.pendingEventLen >= 4
  }

  private pushEvent (event: ReceiverEvent): void {
    if (this.pendingEventsFull()) {
      throw new OutOfMemoryError()
    }
    const index = (this.pendingEventHead + this.pendingEventLen) % 4
    this.pendingEvents[index] = event
    this.pendingEventLen++
  }

  private popEvent (): ReceiverEvent | null {
    if (this.pendingEventLen === 0) {
      return null
    }
    const event = this.pendingEvents[this.pendingEventHead]
    this.pendingEvents[this.pendingEventHead] = null
    this.pendingEventHead = (this.pendingEventHead + 1) % 4
    this.pendingEventLen--
    return event
  }

  private queueZrinit (): void {
    const header = createZrinit(SUBPACKET_MAX_SIZE, Zrinit.CANFDX | Zrinit.CANFC32).encode()
    this.outgoing.clear()
    this.outgoing.extend(header)
    this.outgoingOffset = 0
  }

  private queueZrpos (count: number): void {
    const header = ZRPOS_HEADER.withCount(count).encode()
    this.outgoing.clear()
    this.outgoing.extend(header)
    this.outgoingOffset = 0
  }

  private queueZack (): void {
    const header = ZACK_HEADER.withCount(this.count).encode()
    this.outgoing.clear()
    this.outgoing.extend(header)
    this.outgoingOffset = 0
  }

  private queueZfin (): void {
    const header = ZFIN_HEADER.encode()
    this.outgoing.clear()
    this.outgoing.extend(header)
    this.outgoingOffset = 0
  }

  private queueNak (): void {
    const header = ZNAK_HEADER.encode()
    this.outgoing.clear()
    this.outgoing.extend(header)
    this.outgoingOffset = 0
  }

  private handleHeader (header: Header): void {
    switch (header.frame) {
      case Frame.ZRQINIT:
        if (this.state === RecvState.SessionBegin) {
          this.queueZrinit()
        }
        break
      case Frame.ZFILE:
        if (this.state === RecvState.SessionBegin || this.state === RecvState.FileBegin) {
          this.dataEncoding = header.encoding
          this.state = RecvState.FileReadingMetadata
          this.subpacketState = SubpacketState.Reading
          this.subpacketEscapePending = false
          this.resetCrc()
          this.buf.clear()
          this.bufWriteOffset = 0
        }
        break
      case Frame.ZDATA:
        if (this.state === RecvState.SessionBegin) {
          this.queueZrinit()
        } else if (this.state === RecvState.FileBegin || this.state === RecvState.FileWaitingSubpacket) {
          if (header.count !== this.count) {
            this.queueZrpos(this.count)
            return
          }
          this.dataEncoding = header.encoding
          this.state = RecvState.FileReadingSubpacket
          this.subpacketState = SubpacketState.Reading
          this.subpacketEscapePending = false
          this.resetCrc()
          this.buf.clear()
          this.bufWriteOffset = 0
        }
        break
      case Frame.ZEOF:
        if (this.state === RecvState.FileWaitingSubpacket && header.count === this.count) {
          this.queueZrinit()
          this.state = RecvState.FileBegin
          this.pushEvent(ReceiverEvent.FileComplete)
        }
        break
      case Frame.ZFIN:
        if (this.state === RecvState.FileWaitingSubpacket || this.state === RecvState.FileBegin) {
          this.queueZfin()
          this.state = RecvState.SessionEnd
          this.pushEvent(ReceiverEvent.SessionComplete)
        }
        break
    }
  }

  private resetCrc (): void {
    this.crc16 = new Crc16()
    this.crc32 = new Crc32()
    this.crcEscapePending = false // Reset CRC escape state (like Rust's RxCrc.reset())
    this.crcBytesRead = 0 // Reset CRC bytes read counter
    this.crcBuf = [] // Clear CRC buffer
  }

  private updateCrc (byte: number): void {
    if (this.dataEncoding === Encoding.ZBIN32) {
      this.crc32.updateByte(byte)
    } else {
      this.crc16.updateByte(byte)
    }
  }

  private processSubpacket (input: Uint8Array, startOffset: number): { consumed: number, done: boolean } {
    let consumed = startOffset

    while (consumed < input.length) {
      const byte = input[consumed]

      switch (this.subpacketState) {
        case SubpacketState.Reading:
          if (this.subpacketEscapePending) {
            this.subpacketEscapePending = false
            try {
              const packetType = subpacketTypeFromByte(byte)
              this.updateCrc(packetType)
              this.subpacketType = packetType
              this.subpacketState = SubpacketState.Crc
            } catch {
              const unescaped = UNZDLE_TABLE[byte]
              this.buf.push(unescaped)
              this.updateCrc(unescaped)
            }
            consumed++
          } else if (byte === ZDLE) {
            this.subpacketEscapePending = true
            consumed++
          } else {
            this.buf.push(byte)
            this.updateCrc(byte)
            consumed++
          }
          break

        case SubpacketState.Crc: {
          const crcLen = this.dataEncoding === Encoding.ZBIN32 ? 4 : 2

          while (consumed < input.length && this.crcBytesRead < crcLen) {
            const currentByte = input[consumed]
            if (this.crcEscapePending) {
              this.crcEscapePending = false
              const unescaped = UNZDLE_TABLE[currentByte]
              this.crcBuf.push(unescaped)
              this.crcBytesRead++
              consumed++
            } else if (currentByte === ZDLE) {
              this.crcEscapePending = true
              consumed++
            } else {
              this.crcBuf.push(currentByte)
              this.crcBytesRead++
              consumed++
            }
          }

          if (this.crcBytesRead < crcLen) {
            return { consumed, done: false }
          }

          // Verify CRC - use the accumulated crcBuf
          if (this.dataEncoding === Encoding.ZBIN32) {
            const expected = this.crc32.finalize() >>> 0 // Ensure unsigned
            // Little-endian interpretation (as per ZMODEM spec)
            const received = (this.crcBuf[0] | (this.crcBuf[1] << 8) | (this.crcBuf[2] << 16) | (this.crcBuf[3] << 24)) >>> 0

            if (expected !== received) {
              throw new UnexpectedCrc32Error()
            }
          } else {
            const expected = this.crc16.finalize()
            const received = (this.crcBuf[0] << 8) | this.crcBuf[1]
            if (expected !== received) {
              throw new UnexpectedCrc16Error()
            }
          }

          if (this.state === RecvState.FileReadingMetadata) {
            this.parseZfileBuf()
            this.buf.clear()
            this.bufWriteOffset = 0
            this.resetCrc()
            this.subpacketEscapePending = false
            this.queueZrpos(0)
            this.state = RecvState.FileBegin
            this.subpacketState = SubpacketState.Idle
            this.pushEvent(ReceiverEvent.FileStart)
          } else {
            this.subpacketState = SubpacketState.Writing
            this.bufWriteOffset = 0
            if (this.buf.length === 0) {
              this.finishSubpacket(this.subpacketType)
            }
          }
          return { consumed, done: true }
        }

        case SubpacketState.Writing:
          return { consumed, done: true }

        default:
          throw new UnsupportedError()
      }
    }

    return { consumed, done: false }
  }

  private parseZfileBuf (): void {
    const payload = this.buf.slice()
    const fields: number[][] = []
    let current: number[] = []

    for (const byte of payload) {
      if (byte === 0) {
        fields.push(current)
        current = []
      } else {
        current.push(byte)
      }
    }
    if (current.length > 0) {
      fields.push(current)
    }

    if (fields.length === 0 || fields[0].length === 0) {
      throw new MalformedFileNameError()
    }

    this.fileName = String.fromCharCode(...fields[0])

    if (fields.length > 1) {
      const sizeField = fields[1]
      const spaceIndex = sizeField.findIndex(b => b === 0x20)
      const sizeBytes = spaceIndex >= 0 ? sizeField.slice(0, spaceIndex) : sizeField
      const sizeStr = String.fromCharCode(...sizeBytes)
      this.fileSize = parseInt(sizeStr, 10)
      if (isNaN(this.fileSize)) {
        throw new MalformedFileSizeError()
      }
    } else {
      this.fileSize = 0
    }

    this.count = 0
  }

  private finishSubpacket (packet: SubpacketType): void {
    this.count += this.buf.length
    this.buf.clear()
    this.bufWriteOffset = 0
    this.resetCrc()

    switch (packet) {
      case SubpacketType.ZCRCW:
        this.queueZack()
        this.state = RecvState.FileWaitingSubpacket
        this.subpacketState = SubpacketState.Idle
        this.subpacketEscapePending = false
        break
      case SubpacketType.ZCRCQ:
        this.queueZack()
        this.subpacketState = SubpacketState.Reading
        this.subpacketEscapePending = false
        break
      case SubpacketType.ZCRCG:
        this.subpacketState = SubpacketState.Reading
        this.subpacketEscapePending = false
        break
      case SubpacketType.ZCRCE:
        this.state = RecvState.FileWaitingSubpacket
        this.subpacketState = SubpacketState.Idle
        this.subpacketEscapePending = false
        break
    }
  }
}

/**
 * Header reader state machine.
 */
class HeaderReader {
  private state: HeaderReadState = HeaderReadState.SeekingZpad
  private zpadState: ZpadState = ZpadState.Idle
  private buf: number[] = []
  private encoding: Encoding | null = null
  private expectedLen: number = 0
  private escapePending: boolean = false

  /**
   * Reads a header from the input data.
   * @param input - The input data
   * @param startOffset - The starting offset in the input
   * @returns The header and consumed bytes, or null if not enough data
   */
  read (input: Uint8Array, startOffset: number): { header: Header, consumed: number } | null {
    let consumed = startOffset

    while (consumed < input.length) {
      switch (this.state) {
        case HeaderReadState.SeekingZpad: {
          const byte = input[consumed]
          consumed++

          if (this.advanceZpadState(byte)) {
            this.state = HeaderReadState.ReadingEncoding
          }
          break
        }

        case HeaderReadState.ReadingEncoding: {
          const byte = input[consumed]
          consumed++

          try {
            this.encoding = Encoding.ZBIN
            switch (byte) {
              case 0x41:
                this.encoding = Encoding.ZBIN
                break
              case 0x42:
                this.encoding = Encoding.ZHEX
                break
              case 0x43:
                this.encoding = Encoding.ZBIN32
                break
              default:
                this.reset()
                throw new MalformedPacketError(byte)
            }
          } catch {
            this.reset()
            throw new MalformedPacketError(byte)
          }

          this.expectedLen = Header.readSize(this.encoding)
          this.escapePending = false
          this.buf = []
          this.state = HeaderReadState.ReadingData
          break
        }

        case HeaderReadState.ReadingData:
          while (this.buf.length < this.expectedLen && consumed < input.length) {
            const byte = input[consumed]
            consumed++

            if (this.escapePending) {
              this.escapePending = false
              this.buf.push(UNZDLE_TABLE[byte])
            } else if (byte === ZDLE) {
              this.escapePending = true
            } else {
              this.buf.push(byte)
            }
          }

          if (this.buf.length >= this.expectedLen) {
            if (this.encoding === null) {
              this.reset()
              throw new MalformedHeaderError()
            }

            const header = decodeHeader(this.encoding, new Uint8Array(this.buf))
            this.reset()
            return { header, consumed }
          }
          break
      }
    }

    return null
  }

  private reset (): void {
    this.state = HeaderReadState.SeekingZpad
    this.zpadState = ZpadState.Idle
    this.encoding = null
    this.expectedLen = 0
    this.escapePending = false
    this.buf = []
  }

  private advanceZpadState (byte: number): boolean {
    switch (this.zpadState) {
      case ZpadState.Idle:
        if (byte === ZPAD) {
          this.zpadState = ZpadState.Zpad
        }
        break
      case ZpadState.Zpad:
      case ZpadState.ZpadZpad:
        if (byte === ZDLE) {
          this.zpadState = ZpadState.Idle
          return true
        }
        if (byte === ZPAD) {
          this.zpadState = ZpadState.ZpadZpad
        } else {
          this.zpadState = ZpadState.Idle
        }
        break
    }
    return false
  }
}
