/**
 * ZMODEM file transfer protocol library for JavaScript/TypeScript.
 *
 * This library provides stream-like state machines for sending and receiving
 * files with the ZMODEM protocol.
 *
 * ## Usage
 *
 * The usage can be described at a high level with the following flow:
 *
 * 1. Create `Sender` or `Receiver`.
 * 2. Drain `drainOutgoing()` returned bytes into the wire and call
 *    `advanceOutgoing()` after writing. Then, feed incoming bytes with
 *    `feedIncoming()`.
 * 3. In the sender, complete `pollFile()` with `feedFile()` if required
 *    and handle events via `pollEvent()`.
 * 4. In the receiver, write `drainFile()` returned bytes into storage, and
 *    call `advanceFile()` after writing. Handle events via `pollEvent()`.
 *
 * @module zmodem2-js
 */

// Constants
export { ZPAD, ZDLE, XON, SUBPACKET_MAX_SIZE, SUBPACKET_PER_ACK } from './constants.js'

// Errors
export {
  ZmodemError,
  MalformedEncodingError,
  MalformedFileSizeError,
  MalformedFileNameError,
  MalformedFrameError,
  MalformedHeaderError,
  MalformedPacketError,
  NotConnectedError,
  ReadError,
  OutOfMemoryError,
  UnexpectedCrc16Error,
  UnexpectedCrc32Error,
  UnexpectedEofError,
  UnsupportedError,
  WriteError,
  type Error as ZmodemErrorType
} from './error.js'

// CRC
export { crc16Xmodem, crc32IsoHdlc, Crc16, Crc32 } from './crc.js'

// ZDLE encoding
export { ZDLE_TABLE, UNZDLE_TABLE, escapeByte, unescapeByte } from './zdle.js'

// Header types
export {
  Encoding,
  encodingFromByte,
  Frame,
  frameFromByte,
  Zrinit,
  Header,
  ZACK_HEADER,
  ZDATA_HEADER,
  ZEOF_HEADER,
  ZFIN_HEADER,
  ZNAK_HEADER,
  ZRPOS_HEADER,
  ZRQINIT_HEADER,
  decodeHeader,
  createZrinit,
  writeSliceEscaped,
  writeByteEscaped
} from './header.js'

// Transmission types
export {
  SubpacketType,
  subpacketTypeFromByte,
  type FileRequest,
  SenderEvent,
  ReceiverEvent,
  Sender,
  Receiver
} from './transmission.js'
