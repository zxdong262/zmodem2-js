/**
 * ZMODEM protocol constants.
 *
 * @module zmodem2-js/constants
 */

/**
 * ZPAD character - marks the beginning of a ZMODEM header
 */
export const ZPAD = 0x2a // '*'

/**
 * ZDLE character - escape character for ZMODEM
 */
export const ZDLE = 0x18

/**
 * XON character - flow control
 */
export const XON = 0x11

/**
 * Maximum size of an unescaped subpacket payload
 */
export const SUBPACKET_MAX_SIZE = 1024

/**
 * Number of subpackets per acknowledgment
 */
export const SUBPACKET_PER_ACK = 10

/**
 * Maximum size of an escaped header
 */
export const MAX_HEADER_ESCAPED = 128

/**
 * Maximum size of an escaped subpacket
 */
export const MAX_SUBPACKET_ESCAPED = SUBPACKET_MAX_SIZE * 2 + 2 + 8

/**
 * Wire buffer size
 */
export const WIRE_BUF_SIZE = MAX_HEADER_ESCAPED + MAX_SUBPACKET_ESCAPED

/**
 * Header payload size (frame type + flags)
 */
export const HEADER_PAYLOAD_SIZE = 5

/**
 * Header size with enough capacity for an escaped header
 */
export const HEADER_SIZE = 32

/**
 * Receiver event queue capacity
 */
export const RECEIVER_EVENT_QUEUE_CAP = 4
