/**
 * CRC-16-XMODEM and CRC-32-ISO-HDLC checksum implementations.
 *
 * @module zmodem2-js/crc
 */

/**
 * Performs a single byte update for CRC-16-XMODEM.
 */
function crc16Update (crc: number, byte: number): number {
  crc ^= (byte & 0xFF) << 8
  for (let i = 0; i < 8; i++) {
    if ((crc & 0x8000) !== 0) {
      crc = ((crc << 1) ^ 0x1021) & 0xFFFF
    } else {
      crc = (crc << 1) & 0xFFFF
    }
  }
  return crc
}

/**
 * Performs a single byte update for CRC-32-ISO-HDLC.
 */
function crc32Update (crc: number, byte: number): number {
  crc ^= (byte & 0xFF)
  for (let i = 0; i < 8; i++) {
    if ((crc & 1) !== 0) {
      crc = ((crc >>> 1) ^ 0xEDB88320) >>> 0
    } else {
      crc = (crc >>> 1) >>> 0
    }
  }
  return crc
}

/**
 * Computes the CRC-16-XMODEM checksum.
 * @param data - The data to compute the checksum for
 * @returns The CRC-16-XMODEM checksum
 */
export function crc16Xmodem (data: Uint8Array): number {
  let crc = 0x0000
  for (let i = 0; i < data.length; i++) {
    crc = crc16Update(crc, data[i])
  }
  return crc
}

/**
 * Computes the CRC-32-ISO-HDLC checksum.
 * @param data - The data to compute the checksum for
 * @returns The CRC-32-ISO-HDLC checksum
 */
export function crc32IsoHdlc (data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc = crc32Update(crc, data[i])
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/**
 * A stateful, iterative CRC-16-XMODEM calculator.
 */
export class Crc16 {
  private crc: number = 0x0000

  /**
   * Creates a new CRC-16 calculator.
   */
  constructor () {
    this.crc = 0x0000
  }

  /**
   * Resets the CRC state.
   */
  reset (): void {
    this.crc = 0x0000
  }

  /**
   * Updates the CRC state with a slice of bytes.
   * @param data - The data to update with
   */
  update (data: Uint8Array): void {
    for (const byte of data) {
      this.updateByte(byte)
    }
  }

  /**
   * Updates the CRC state with a single byte.
   * @param byte - The byte to update with
   */
  updateByte (byte: number): void {
    this.crc = crc16Update(this.crc, byte)
  }

  /**
   * Finalizes the CRC calculation and returns the checksum.
   * @returns The CRC-16-XMODEM checksum
   */
  finalize (): number {
    return this.crc
  }
}

/**
 * A stateful, iterative CRC-32-ISO-HDLC calculator.
 */
export class Crc32 {
  private crc: number

  /**
   * Creates a new CRC-32 calculator.
   */
  constructor () {
    this.crc = 0xFFFFFFFF
  }

  /**
   * Resets the CRC state.
   */
  reset (): void {
    this.crc = 0xFFFFFFFF
  }

  /**
   * Updates the CRC state with a slice of bytes.
   * @param data - The data to update with
   */
  update (data: Uint8Array): void {
    for (const byte of data) {
      this.updateByte(byte)
    }
  }

  /**
   * Updates the CRC state with a single byte.
   * @param byte - The byte to update with
   */
  updateByte (byte: number): void {
    this.crc = crc32Update(this.crc, byte)
  }

  /**
   * Finalizes the CRC calculation and returns the checksum.
   * @returns The CRC-32-ISO-HDLC checksum
   */
  finalize (): number {
    return (this.crc ^ 0xFFFFFFFF) >>> 0
  }
}
