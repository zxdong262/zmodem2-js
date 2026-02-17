/**
 * Tests for CRC functions.
 */

import { describe, it, expect } from 'vitest'
import { crc16Xmodem, crc32IsoHdlc, Crc16, Crc32 } from '../../src/lib/crc.js'

describe('CRC-16-XMODEM', () => {
  it('should compute correct CRC-16 for empty data', () => {
    const result = crc16Xmodem(new Uint8Array(0))
    expect(result).toBe(0x0000)
  })

  it('should compute correct CRC-16 for "123456789"', () => {
    const data = new TextEncoder().encode('123456789')
    const result = crc16Xmodem(data)
    // CRC-16-XMODEM check value for "123456789" is 0x31C3
    expect(result).toBe(0x31C3)
  })

  it('should compute correct CRC-16 for single byte', () => {
    const data = new Uint8Array([0x00])
    const result = crc16Xmodem(data)
    expect(result).toBe(0x0000)
  })

  it('Crc16 class should produce same result as function', () => {
    const data = new TextEncoder().encode('Hello, World!')
    const funcResult = crc16Xmodem(data)

    const crc = new Crc16()
    crc.update(data)
    const classResult = crc.finalize()

    expect(classResult).toBe(funcResult)
  })

  it('Crc16 class should support incremental updates', () => {
    const data1 = new TextEncoder().encode('Hello')
    const data2 = new TextEncoder().encode(', World!')

    const crc = new Crc16()
    crc.update(data1)
    crc.update(data2)
    const result = crc.finalize()

    const expected = crc16Xmodem(new TextEncoder().encode('Hello, World!'))
    expect(result).toBe(expected)
  })

  it('Crc16 reset should work correctly', () => {
    const crc = new Crc16()
    crc.update(new TextEncoder().encode('test'))
    crc.reset()
    crc.update(new TextEncoder().encode('123456789'))
    const result = crc.finalize()

    expect(result).toBe(0x31C3)
  })
})

describe('CRC-32-ISO-HDLC', () => {
  it('should compute correct CRC-32 for empty data', () => {
    const result = crc32IsoHdlc(new Uint8Array(0))
    expect(result).toBe(0x00000000)
  })

  it('should compute correct CRC-32 for "123456789"', () => {
    const data = new TextEncoder().encode('123456789')
    const result = crc32IsoHdlc(data)
    // CRC-32 check value for "123456789" is 0xCBF43926
    expect(result).toBe(0xCBF43926)
  })

  it('should compute correct CRC-32 for single byte', () => {
    const data = new Uint8Array([0x00])
    const result = crc32IsoHdlc(data)
    expect(result).toBe(0xD202EF8D)
  })

  it('Crc32 class should produce same result as function', () => {
    const data = new TextEncoder().encode('Hello, World!')
    const funcResult = crc32IsoHdlc(data)

    const crc = new Crc32()
    crc.update(data)
    const classResult = crc.finalize()

    expect(classResult).toBe(funcResult)
  })

  it('Crc32 class should support incremental updates', () => {
    const data1 = new TextEncoder().encode('Hello')
    const data2 = new TextEncoder().encode(', World!')

    const crc = new Crc32()
    crc.update(data1)
    crc.update(data2)
    const result = crc.finalize()

    const expected = crc32IsoHdlc(new TextEncoder().encode('Hello, World!'))
    expect(result).toBe(expected)
  })

  it('Crc32 reset should work correctly', () => {
    const crc = new Crc32()
    crc.update(new TextEncoder().encode('test'))
    crc.reset()
    crc.update(new TextEncoder().encode('123456789'))
    const result = crc.finalize()

    expect(result).toBe(0xCBF43926)
  })
})
