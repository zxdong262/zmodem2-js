/**
 * ZMODEM error types.
 *
 * @module zmodem2-js/error
 */

/**
 * Top-level error type for ZMODEM operations.
 */
export class ZmodemError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'ZmodemError'
  }
}

/**
 * Malformed encoding type error.
 */
export class MalformedEncodingError extends ZmodemError {
  public readonly byte: number

  constructor (byte: number) {
    super(`Malformed encoding type: 0x${byte.toString(16).padStart(2, '0')}`)
    this.name = 'MalformedEncodingError'
    this.byte = byte
  }
}

/**
 * Malformed file size error.
 */
export class MalformedFileSizeError extends ZmodemError {
  constructor () {
    super('Malformed file size')
    this.name = 'MalformedFileSizeError'
  }
}

/**
 * Malformed filename error.
 */
export class MalformedFileNameError extends ZmodemError {
  constructor () {
    super('Malformed filename')
    this.name = 'MalformedFileNameError'
  }
}

/**
 * Malformed frame type error.
 */
export class MalformedFrameError extends ZmodemError {
  public readonly byte: number

  constructor (byte: number) {
    super(`Malformed frame type: 0x${byte.toString(16).padStart(2, '0')}`)
    this.name = 'MalformedFrameError'
    this.byte = byte
  }
}

/**
 * Malformed header error.
 */
export class MalformedHeaderError extends ZmodemError {
  constructor () {
    super('Malformed header')
    this.name = 'MalformedHeaderError'
  }
}

/**
 * Malformed packet type error.
 */
export class MalformedPacketError extends ZmodemError {
  public readonly byte: number

  constructor (byte: number) {
    super(`Malformed packet type: 0x${byte.toString(16).padStart(2, '0')}`)
    this.name = 'MalformedPacketError'
    this.byte = byte
  }
}

/**
 * Not connected error.
 */
export class NotConnectedError extends ZmodemError {
  constructor () {
    super('Not connected')
    this.name = 'NotConnectedError'
  }
}

/**
 * Read error.
 */
export class ReadError extends ZmodemError {
  public readonly cause?: string

  constructor (cause?: string) {
    super(`Read: ${cause ?? 'unknown'}`)
    this.name = 'ReadError'
    this.cause = cause
  }
}

/**
 * Out of memory error.
 */
export class OutOfMemoryError extends ZmodemError {
  constructor () {
    super('Out of memory')
    this.name = 'OutOfMemoryError'
  }
}

/**
 * Unexpected CRC-16 error.
 */
export class UnexpectedCrc16Error extends ZmodemError {
  constructor () {
    super('Unexpected CRC-16')
    this.name = 'UnexpectedCrc16Error'
  }
}

/**
 * Unexpected CRC-32 error.
 */
export class UnexpectedCrc32Error extends ZmodemError {
  constructor () {
    super('Unexpected CRC-32')
    this.name = 'UnexpectedCrc32Error'
  }
}

/**
 * Unexpected EOF error.
 */
export class UnexpectedEofError extends ZmodemError {
  constructor () {
    super('Unexpected EOF')
    this.name = 'UnexpectedEofError'
  }
}

/**
 * Unsupported operation error.
 */
export class UnsupportedError extends ZmodemError {
  constructor () {
    super('Unsupported operation')
    this.name = 'UnsupportedError'
  }
}

/**
 * Write error.
 */
export class WriteError extends ZmodemError {
  public readonly cause?: string

  constructor (cause?: string) {
    super(`Write: ${cause ?? 'unknown'}`)
    this.name = 'WriteError'
    this.cause = cause
  }
}

/**
 * Union type of all ZMODEM errors.
 */
export type Error =
  | MalformedEncodingError
  | MalformedFileSizeError
  | MalformedFileNameError
  | MalformedFrameError
  | MalformedHeaderError
  | MalformedPacketError
  | NotConnectedError
  | ReadError
  | OutOfMemoryError
  | UnexpectedCrc16Error
  | UnexpectedCrc32Error
  | UnexpectedEofError
  | UnsupportedError
  | WriteError
