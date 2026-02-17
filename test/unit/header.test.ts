/**
 * Tests for Header encoding/decoding.
 */

import { describe, it, expect } from 'vitest'
import { Encoding, encodingFromByte, Frame, frameFromByte, Header, Zrinit, decodeHeader, createZrinit } from '../../src/lib/header.js'
import { MalformedEncodingError, MalformedFrameError } from '../../src/lib/error.js'

describe('Encoding', () => {
  it('should have correct values', () => {
    expect(Encoding.ZBIN).toBe(0x41)
    expect(Encoding.ZHEX).toBe(0x42)
    expect(Encoding.ZBIN32).toBe(0x43)
  })

  it('encodingFromByte should return correct encoding', () => {
    expect(encodingFromByte(0x41)).toBe(Encoding.ZBIN)
    expect(encodingFromByte(0x42)).toBe(Encoding.ZHEX)
    expect(encodingFromByte(0x43)).toBe(Encoding.ZBIN32)
  })

  it('encodingFromByte should throw for invalid byte', () => {
    expect(() => encodingFromByte(0x00)).toThrow(MalformedEncodingError)
    expect(() => encodingFromByte(0xFF)).toThrow(MalformedEncodingError)
  })
})

describe('Frame', () => {
  it('should have correct values', () => {
    expect(Frame.ZRQINIT).toBe(0)
    expect(Frame.ZRINIT).toBe(1)
    expect(Frame.ZFILE).toBe(4)
    expect(Frame.ZFIN).toBe(8)
    expect(Frame.ZDATA).toBe(10)
    expect(Frame.ZEOF).toBe(11)
  })

  it('frameFromByte should return correct frame', () => {
    expect(frameFromByte(0)).toBe(Frame.ZRQINIT)
    expect(frameFromByte(1)).toBe(Frame.ZRINIT)
    expect(frameFromByte(19)).toBe(Frame.ZSTDERR)
  })

  it('frameFromByte should throw for invalid byte', () => {
    expect(() => frameFromByte(20)).toThrow(MalformedFrameError)
    expect(() => frameFromByte(255)).toThrow(MalformedFrameError)
  })
})

describe('Header', () => {
  it('should create header with default flags', () => {
    const header = new Header(Encoding.ZBIN, Frame.ZRQINIT)
    expect(header.encoding).toBe(Encoding.ZBIN)
    expect(header.frame).toBe(Frame.ZRQINIT)
    expect(header.count).toBe(0)
  })

  it('should create header with custom flags', () => {
    const flags = new Uint8Array([0x01, 0x02, 0x03, 0x04])
    const header = new Header(Encoding.ZBIN, Frame.ZRINIT, flags)
    expect(header.flags).toEqual(flags)
    expect(header.count).toBe(0x04030201)
  })

  it('withCount should create new header with count', () => {
    const header = new Header(Encoding.ZHEX, Frame.ZRPOS)
    const withCount = header.withCount(0x12345678)
    expect(withCount.count).toBe(0x12345678)
    expect(header.count).toBe(0) // Original unchanged
  })

  it('readSize should return correct sizes', () => {
    expect(Header.readSize(Encoding.ZBIN)).toBe(7) // 5 + 2
    expect(Header.readSize(Encoding.ZBIN32)).toBe(9) // 5 + 4
    expect(Header.readSize(Encoding.ZHEX)).toBe(14) // (5 + 2) * 2
  })

  it('should encode ZHEX header correctly', () => {
    const header = new Header(Encoding.ZHEX, Frame.ZRQINIT)
    const encoded = header.encode()

    // Should start with ZPAD ZPAD ZDLE
    expect(encoded[0]).toBe(0x2a) // ZPAD
    expect(encoded[1]).toBe(0x2a) // ZPAD
    expect(encoded[2]).toBe(0x18) // ZDLE
    expect(encoded[3]).toBe(0x42) // ZHEX
  })

  it('should encode ZBIN header correctly', () => {
    const header = new Header(Encoding.ZBIN, Frame.ZRINIT, new Uint8Array([0x00, 0x04, 0x00, 0x21]))
    const encoded = header.encode()

    // Should start with ZPAD ZDLE
    expect(encoded[0]).toBe(0x2a) // ZPAD
    expect(encoded[1]).toBe(0x18) // ZDLE
    expect(encoded[2]).toBe(0x41) // ZBIN
  })

  it('should encode ZBIN32 header correctly', () => {
    const header = new Header(Encoding.ZBIN32, Frame.ZDATA)
    const encoded = header.encode()

    // Should start with ZPAD ZDLE
    expect(encoded[0]).toBe(0x2a) // ZPAD
    expect(encoded[1]).toBe(0x18) // ZDLE
    expect(encoded[2]).toBe(0x43) // ZBIN32
  })
})

describe('createZrinit', () => {
  it('should create ZRINIT header with correct values', () => {
    const header = createZrinit(1024, Zrinit.CANFDX | Zrinit.CANFC32)
    expect(header.frame).toBe(Frame.ZRINIT)
    expect(header.encoding).toBe(Encoding.ZHEX)
    expect(header.flags[0]).toBe(0x00) // Buffer size low byte
    expect(header.flags[1]).toBe(0x04) // Buffer size high byte (1024 = 0x0400)
    expect(header.flags[3]).toBe(Zrinit.CANFDX | Zrinit.CANFC32)
  })
})

describe('decodeHeader', () => {
  it('should round-trip ZBIN header', () => {
    const original = new Header(Encoding.ZBIN, Frame.ZRINIT, new Uint8Array([0x01, 0x02, 0x03, 0x04]))
    const encoded = original.encode()

    // Extract the payload (skip header start bytes)
    let payloadStart = 0
    if (encoded[0] === 0x2a) payloadStart++
    if (encoded[payloadStart] === 0x2a) payloadStart++
    if (encoded[payloadStart] === 0x18) payloadStart++
    if (encoded[payloadStart] === 0x41 || encoded[payloadStart] === 0x42 || encoded[payloadStart] === 0x43) payloadStart++

    const payload = encoded.slice(payloadStart)
    const decoded = decodeHeader(Encoding.ZBIN, payload)

    expect(decoded.frame).toBe(original.frame)
    expect(decoded.count).toBe(original.count)
  })

  it('should round-trip ZHEX header', () => {
    const original = new Header(Encoding.ZHEX, Frame.ZRQINIT)
    const encoded = original.encode()

    // Extract the hex payload (skip header start bytes and CR/LF/XON)
    let payloadStart = 0
    if (encoded[0] === 0x2a) payloadStart++
    if (encoded[payloadStart] === 0x2a) payloadStart++
    if (encoded[payloadStart] === 0x18) payloadStart++
    if (encoded[payloadStart] === 0x42) payloadStart++

    // Find end of hex data (before CR/LF)
    let payloadEnd = payloadStart
    while (payloadEnd < encoded.length && encoded[payloadEnd] !== 0x0d) {
      payloadEnd++
    }

    const payload = encoded.slice(payloadStart, payloadEnd)
    const decoded = decodeHeader(Encoding.ZHEX, payload)

    expect(decoded.frame).toBe(original.frame)
    expect(decoded.count).toBe(original.count)
  })

  it('should round-trip ZBIN32 header', () => {
    const original = new Header(Encoding.ZBIN32, Frame.ZDATA, new Uint8Array([0x78, 0x56, 0x34, 0x12]))
    const encoded = original.encode()

    // Extract the payload
    let payloadStart = 0
    if (encoded[0] === 0x2a) payloadStart++
    if (encoded[payloadStart] === 0x2a) payloadStart++
    if (encoded[payloadStart] === 0x18) payloadStart++
    if (encoded[payloadStart] === 0x43) payloadStart++

    const payload = encoded.slice(payloadStart)
    const decoded = decodeHeader(Encoding.ZBIN32, payload)

    expect(decoded.frame).toBe(original.frame)
    expect(decoded.count).toBe(original.count)
  })
})
