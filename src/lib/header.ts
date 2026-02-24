/**
 * ZMODEM protocol header, encoding, and frame definitions.
 *
 * @module zmodem2-js/header
 */

import { ZDLE, ZPAD, XON, HEADER_PAYLOAD_SIZE } from './constants.js'
import { MalformedEncodingError, MalformedFrameError, MalformedHeaderError, UnexpectedCrc16Error, UnexpectedCrc32Error } from './error.js'
import { crc16Xmodem, crc32IsoHdlc } from './crc.js'
import { ZDLE_TABLE } from './zdle.js'

/**
 * The ZMODEM protocol frame encoding type.
 */
export enum Encoding {
  /** Binary encoding with 16-bit CRC */
  ZBIN = 0x41,
  /** Hexadecimal encoding with 16-bit CRC */
  ZHEX = 0x42,
  /** Binary encoding with 32-bit CRC */
  ZBIN32 = 0x43
}

/**
 * Creates an Encoding from a byte value.
 * @param value - The byte value
 * @returns The Encoding type
 * @throws MalformedEncodingError if the value is not a valid encoding
 */
export function encodingFromByte (value: number): Encoding {
  switch (value) {
    case 0x41:
      return Encoding.ZBIN
    case 0x42:
      return Encoding.ZHEX
    case 0x43:
      return Encoding.ZBIN32
    default:
      throw new MalformedEncodingError(value)
  }
}

/**
 * ZMODEM frame types.
 */
export enum Frame {
  /** Request receive init */
  ZRQINIT = 0,
  /** Receiver capabilities and packet size */
  ZRINIT = 1,
  /** Send init sequence (optional) */
  ZSINIT = 2,
  /** ACK to above */
  ZACK = 3,
  /** File name from sender */
  ZFILE = 4,
  /** To sender: skip this file */
  ZSKIP = 5,
  /** Last packet was garbled */
  ZNAK = 6,
  /** Abort batch transfers */
  ZABORT = 7,
  /** Finish session */
  ZFIN = 8,
  /** Resume data trans at this position */
  ZRPOS = 9,
  /** Data packet(s) follow */
  ZDATA = 10,
  /** End of file */
  ZEOF = 11,
  /** Fatal Read or Write error Detected */
  ZFERR = 12,
  /** Request for file CRC and response */
  ZCRC = 13,
  /** Receiver's Challenge */
  ZCHALLENGE = 14,
  /** Request is complete */
  ZCOMPL = 15,
  /** Other end canned session with CAN*5 */
  ZCAN = 16,
  /** Request for free bytes on filesystem */
  ZFREECNT = 17,
  /** Command from sending program */
  ZCOMMAND = 18,
  /** Output to standard error, data follows */
  ZSTDERR = 19
}

/**
 * Creates a Frame from a byte value.
 * @param value - The byte value
 * @returns The Frame type
 * @throws MalformedFrameError if the value is not a valid frame
 */
export function frameFromByte (value: number): Frame {
  if (value >= 0 && value <= 19) {
    return value as Frame
  }
  throw new MalformedFrameError(value)
}

/**
 * ZRINIT flags - receiver capabilities.
 */
export enum Zrinit {
  /** Can send and receive in full-duplex */
  CANFDX = 0x01,
  /** Can receive data in parallel with disk I/O */
  CANOVIO = 0x02,
  /** Can send a break signal */
  CANBRK = 0x04,
  /** Can decrypt */
  CANCRY = 0x08,
  /** Can uncompress */
  CANLZW = 0x10,
  /** Can use 32-bit frame check */
  CANFC32 = 0x20,
  /** Expects control character to be escaped */
  ESCCTL = 0x40,
  /** Expects 8th bit to be escaped */
  ESC8 = 0x80
}

/**
 * Data structure for holding a ZMODEM protocol header.
 */
export class Header {
  private readonly _encoding: Encoding
  private readonly _frame: Frame
  private readonly _flags: Uint8Array

  /**
   * Creates a new Header instance.
   * @param encoding - The encoding type
   * @param frame - The frame type
   * @param flags - The 4-byte flags array
   */
  constructor (encoding: Encoding, frame: Frame, flags: Uint8Array = new Uint8Array(4)) {
    this._encoding = encoding
    this._frame = frame
    this._flags = new Uint8Array(flags)
  }

  /**
   * Returns the encoding of the frame.
   */
  get encoding (): Encoding {
    return this._encoding
  }

  /**
   * Returns the frame type.
   */
  get frame (): Frame {
    return this._frame
  }

  /**
   * Returns the count value for frame types that use this field.
   */
  get count (): number {
    return new DataView(this._flags.buffer).getUint32(0, true)
  }

  /**
   * Returns the flags array.
   */
  get flags (): Uint8Array {
    return this._flags
  }

  /**
   * Creates a new Header with the count field set.
   * @param count - The count value
   * @returns A new Header with the count set
   */
  withCount (count: number): Header {
    const flags = new Uint8Array(4)
    new DataView(flags.buffer).setUint32(0, count, true)
    return new Header(this._encoding, this._frame, flags)
  }

  /**
   * Returns the serialized size of the header payload (payload + CRC).
   * @param encoding - The encoding type
   * @returns The size in bytes
   */
  static readSize (encoding: Encoding): number {
    switch (encoding) {
      case Encoding.ZBIN:
        return HEADER_PAYLOAD_SIZE + 2
      case Encoding.ZBIN32:
        return HEADER_PAYLOAD_SIZE + 4
      case Encoding.ZHEX:
        return (HEADER_PAYLOAD_SIZE + 2) * 2
    }
  }

  /**
   * Encodes and writes the header to a byte array.
   * @returns The encoded header bytes
   */
  encode (): Uint8Array {
    const result: number[] = []

    // Write header start
    result.push(ZPAD)
    if (this._encoding === Encoding.ZHEX) {
      result.push(ZPAD)
    }
    result.push(ZDLE)
    result.push(this._encoding)

    // Build payload
    const payload: number[] = [this._frame as number, ...this._flags]

    // Calculate CRC
    const crcBytes: number[] = []
    if (this._encoding === Encoding.ZBIN32) {
      const crc = crc32IsoHdlc(new Uint8Array(payload))
      const view = new DataView(new ArrayBuffer(4))
      view.setUint32(0, crc, true)
      for (let i = 0; i < 4; i++) {
        crcBytes.push(view.getUint8(i))
      }
    } else {
      const crc = crc16Xmodem(new Uint8Array(payload))
      crcBytes.push((crc >> 8) & 0xFF)
      crcBytes.push(crc & 0xFF)
    }

    payload.push(...crcBytes)

    // Encode based on type
    if (this._encoding === Encoding.ZHEX) {
      // Hex encode
      const hexStr = payload.map(b => b.toString(16).padStart(2, '0')).join('')
      for (const c of hexStr) {
        result.push(c.charCodeAt(0))
      }
      // Add CR/LF
      result.push(0x0d) // CR
      result.push(0x0a) // LF
      // Add XON for non-ACK/ZFIN frames
      if (this._frame !== Frame.ZACK && this._frame !== Frame.ZFIN) {
        result.push(XON)
      }
    } else {
      // Binary encode with escaping
      for (const byte of payload) {
        const escaped = ZDLE_TABLE[byte]
        if (escaped !== byte) {
          result.push(ZDLE)
        }
        result.push(escaped)
      }
    }

    return new Uint8Array(result)
  }
}

/**
 * Pre-defined header constants.
 */
export const ZACK_HEADER = new Header(Encoding.ZHEX, Frame.ZACK)
export const ZDATA_HEADER = new Header(Encoding.ZBIN32, Frame.ZDATA)
export const ZEOF_HEADER = new Header(Encoding.ZBIN32, Frame.ZEOF)
export const ZFIN_HEADER = new Header(Encoding.ZHEX, Frame.ZFIN)
export const ZNAK_HEADER = new Header(Encoding.ZHEX, Frame.ZNAK)
export const ZRPOS_HEADER = new Header(Encoding.ZHEX, Frame.ZRPOS)
export const ZRQINIT_HEADER = new Header(Encoding.ZHEX, Frame.ZRQINIT)

/**
 * Writes a slice of bytes with ZDLE escaping.
 * @param data - The data to escape and write
 * @returns The escaped bytes
 */
export function writeSliceEscaped (data: Uint8Array): Uint8Array {
  const result: number[] = []
  for (const byte of data) {
    const escaped = ZDLE_TABLE[byte]
    if (escaped !== byte) {
      result.push(ZDLE)
    }
    result.push(escaped)
  }
  return new Uint8Array(result)
}

/**
 * Writes a single byte with ZDLE escaping.
 * @param value - The byte to escape and write
 * @returns The escaped byte(s)
 */
export function writeByteEscaped (value: number): Uint8Array {
  const escaped = ZDLE_TABLE[value]
  if (escaped !== value) {
    return new Uint8Array([ZDLE, escaped])
  }
  return new Uint8Array([escaped])
}

/**
 * Decodes a header from raw data.
 * @param encoding - The encoding type
 * @param data - The raw header data
 * @returns The decoded Header
 * @throws MalformedHeaderError if the header is malformed
 * @throws UnexpectedCrc16Error if CRC-16 check fails
 * @throws UnexpectedCrc32Error if CRC-32 check fails
 */
export function decodeHeader (encoding: Encoding, data: Uint8Array): Header {
  let payload: Uint8Array

  if (encoding === Encoding.ZHEX) {
    if (data.length % 2 !== 0) {
      throw new MalformedHeaderError()
    }
    // Decode hex
    const hexStr = String.fromCharCode(...data)
    const bytes: number[] = []
    for (let i = 0; i < hexStr.length; i += 2) {
      const byte = parseInt(hexStr.substring(i, i + 2), 16)
      if (isNaN(byte)) {
        throw new MalformedHeaderError()
      }
      bytes.push(byte)
    }
    payload = new Uint8Array(bytes)
  } else {
    payload = data
  }

  const crcLen = encoding === Encoding.ZBIN32 ? 4 : 2
  if (payload.length < HEADER_PAYLOAD_SIZE + crcLen) {
    throw new MalformedHeaderError()
  }

  const headerPayload = payload.slice(0, HEADER_PAYLOAD_SIZE)
  const crcBytes = payload.slice(HEADER_PAYLOAD_SIZE)

  // Verify CRC
  if (encoding === Encoding.ZBIN32) {
    const expected = crc32IsoHdlc(headerPayload)
    const view = new DataView(new ArrayBuffer(4))
    view.setUint32(0, expected, true)
    const expectedBytes = new Uint8Array(view.buffer)
    if (crcBytes.length < 4 || !arraysEqual(crcBytes.slice(0, 4), expectedBytes)) {
      throw new UnexpectedCrc32Error()
    }
  } else {
    const expected = crc16Xmodem(headerPayload)
    const expectedBytes = new Uint8Array([(expected >> 8) & 0xFF, expected & 0xFF])
    if (crcBytes.length < 2 || !arraysEqual(crcBytes.slice(0, 2), expectedBytes)) {
      throw new UnexpectedCrc16Error()
    }
  }

  const frame = frameFromByte(headerPayload[0])
  const flags = headerPayload.slice(1, 5)

  return new Header(encoding, frame, flags)
}

/**
 * Compares two Uint8Arrays for equality.
 */
function arraysEqual (a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Creates a ZRINIT header.
 * @param bufferSize - The receiver buffer size
 * @param flags - The ZRINIT flags
 * @returns The ZRINIT header
 */
export function createZrinit (bufferSize: number = 1024, flags: number = Zrinit.CANFDX | Zrinit.CANOVIO | Zrinit.CANFC32): Header {
  const flagBytes = new Uint8Array(4)
  flagBytes[0] = bufferSize & 0xFF
  flagBytes[1] = (bufferSize >> 8) & 0xFF
  flagBytes[2] = 0
  flagBytes[3] = flags
  return new Header(Encoding.ZHEX, Frame.ZRINIT, flagBytes)
}
