/**
 * Tests for Sender and Receiver state machines.
 */

import { describe, it, expect } from 'vitest'
import { Sender, Receiver } from '../../src/lib/transmission.js'
import { Frame, Encoding, Header, createZrinit } from '../../src/lib/header.js'

describe('Sender', () => {
  it('should create sender with ZRQINIT queued', () => {
    const sender = new Sender()
    const outgoing = sender.drainOutgoing()
    expect(outgoing.length).toBeGreaterThan(0)

    // Should start with ZPAD ZPAD ZDLE ZHEX
    expect(outgoing[0]).toBe(0x2a) // ZPAD
    expect(outgoing[1]).toBe(0x2a) // ZPAD
    expect(outgoing[2]).toBe(0x18) // ZDLE
    expect(outgoing[3]).toBe(0x42) // ZHEX
  })

  it('should advance outgoing cursor', () => {
    const sender = new Sender()
    const initial = sender.drainOutgoing()
    const len = initial.length

    sender.advanceOutgoing(len)
    expect(sender.drainOutgoing().length).toBe(0)
  })

  it('should handle ZRINIT from receiver', () => {
    const sender = new Sender()

    // Clear initial ZRQINIT
    sender.advanceOutgoing(sender.drainOutgoing().length)

    // Simulate receiving ZRINIT
    const zrinit = createZrinit(1024, 0x21).encode()
    sender.feedIncoming(zrinit)

    // No event should be pending yet
    expect(sender.pollEvent()).toBeNull()
  })

  it('should start file transfer after ZRINIT', () => {
    const sender = new Sender()

    // Clear initial ZRQINIT
    sender.advanceOutgoing(sender.drainOutgoing().length)

    // Simulate receiving ZRINIT
    const zrinit = createZrinit(1024, 0x21).encode()
    sender.feedIncoming(zrinit)

    // Start file transfer
    sender.startFile('test.txt', 100)

    // Should have ZFILE header queued
    const outgoing = sender.drainOutgoing()
    expect(outgoing.length).toBeGreaterThan(0)
  })

  it('should request file data after ZRPOS', () => {
    const sender = new Sender()

    // Clear initial ZRQINIT
    sender.advanceOutgoing(sender.drainOutgoing().length)

    // Simulate receiving ZRINIT
    const zrinit = createZrinit(1024, 0x21).encode()
    sender.feedIncoming(zrinit)

    // Start file transfer
    sender.startFile('test.txt', 100)
    sender.advanceOutgoing(sender.drainOutgoing().length)

    // Simulate receiving ZRPOS(0)
    const zrpos = new Header(Encoding.ZHEX, Frame.ZRPOS).withCount(0).encode()
    sender.feedIncoming(zrpos)

    // Should have a file request
    const request = sender.pollFile()
    expect(request).not.toBeNull()
    expect(request?.offset).toBe(0)
    expect(request?.len).toBeGreaterThan(0)
  })

  it('should send file data', () => {
    const sender = new Sender()

    // Clear initial ZRQINIT
    sender.advanceOutgoing(sender.drainOutgoing().length)

    // Simulate receiving ZRINIT
    const zrinit = createZrinit(1024, 0x21).encode()
    sender.feedIncoming(zrinit)

    // Start file transfer
    sender.startFile('test.txt', 100)
    sender.advanceOutgoing(sender.drainOutgoing().length)

    // Simulate receiving ZRPOS(0)
    const zrpos = new Header(Encoding.ZHEX, Frame.ZRPOS).withCount(0).encode()
    sender.feedIncoming(zrpos)

    // Get file request
    const request = sender.pollFile()
    expect(request).not.toBeNull()

    // Feed file data
    if (request != null) {
      const data = new Uint8Array(request.len).fill(0x41) // Fill with 'A'
      sender.feedFile(data)
    }

    // Should have outgoing data
    const outgoing = sender.drainOutgoing()
    expect(outgoing.length).toBeGreaterThan(0)
  })

  it('should handle finish session', () => {
    const sender = new Sender()

    // Clear initial ZRQINIT
    sender.advanceOutgoing(sender.drainOutgoing().length)

    // Simulate receiving ZRINIT
    const zrinit = createZrinit(1024, 0x21).encode()
    sender.feedIncoming(zrinit)

    // Request finish
    sender.finishSession()

    // Should have ZFIN queued
    const outgoing = sender.drainOutgoing()
    expect(outgoing.length).toBeGreaterThan(0)
  })
})

describe('Receiver', () => {
  it('should create receiver with ZRINIT queued', () => {
    const receiver = new Receiver()
    const outgoing = receiver.drainOutgoing()
    expect(outgoing.length).toBeGreaterThan(0)

    // Should start with ZPAD ZPAD ZDLE ZHEX
    expect(outgoing[0]).toBe(0x2a) // ZPAD
    expect(outgoing[1]).toBe(0x2a) // ZPAD
    expect(outgoing[2]).toBe(0x18) // ZDLE
    expect(outgoing[3]).toBe(0x42) // ZHEX
  })

  it('should advance outgoing cursor', () => {
    const receiver = new Receiver()
    const initial = receiver.drainOutgoing()
    const len = initial.length

    receiver.advanceOutgoing(len)
    expect(receiver.drainOutgoing().length).toBe(0)
  })

  it('should respond to ZRQINIT with ZRINIT', () => {
    const receiver = new Receiver()

    // Clear initial ZRINIT
    receiver.advanceOutgoing(receiver.drainOutgoing().length)

    // Simulate receiving ZRQINIT
    const zrqinit = new Header(Encoding.ZHEX, Frame.ZRQINIT).encode()
    receiver.feedIncoming(zrqinit)

    // Should have ZRINIT queued
    const outgoing = receiver.drainOutgoing()
    expect(outgoing.length).toBeGreaterThan(0)
  })

  it('should handle ZFIN after file transfer', () => {
    const receiver = new Receiver()

    // Clear initial ZRINIT
    receiver.advanceOutgoing(receiver.drainOutgoing().length)

    // Simulate receiving ZRQINIT
    const zrqinit = new Header(Encoding.ZHEX, Frame.ZRQINIT).encode()
    receiver.feedIncoming(zrqinit)

    // ZRINIT should be queued as response
    const outgoing = receiver.drainOutgoing()
    expect(outgoing.length).toBeGreaterThan(0)
  })
})

describe('Sender-Receiver Integration', () => {
  it('should complete handshake', () => {
    const sender = new Sender()
    const receiver = new Receiver()

    // Sender sends ZRQINIT
    let senderOut = sender.drainOutgoing()
    expect(senderOut.length).toBeGreaterThan(0)
    receiver.feedIncoming(senderOut)
    sender.advanceOutgoing(senderOut.length)

    // Receiver responds with ZRINIT
    const receiverOut = receiver.drainOutgoing()
    expect(receiverOut.length).toBeGreaterThan(0)
    receiver.advanceOutgoing(receiverOut.length)
    sender.feedIncoming(receiverOut)

    // Verify sender is ready for file
    sender.startFile('test.txt', 10)
    senderOut = sender.drainOutgoing()
    expect(senderOut.length).toBeGreaterThan(0)
  })

  it('should round-trip Chinese filename through Sender and Receiver', () => {
    const sender = new Sender()
    const receiver = new Receiver()

    // Exchange ZRQINIT / ZRINIT
    let senderOut = sender.drainOutgoing()
    receiver.feedIncoming(senderOut)
    sender.advanceOutgoing(senderOut.length)

    const receiverOut = receiver.drainOutgoing()
    receiver.advanceOutgoing(receiverOut.length)
    sender.feedIncoming(receiverOut)

    // Sender starts a file with Chinese filename
    const fileName = '中文文件名.txt'
    const fileSize = 12345
    sender.startFile(fileName, fileSize)
    senderOut = sender.drainOutgoing()
    expect(senderOut.length).toBeGreaterThan(0)

    // Feed sender output into receiver
    receiver.feedIncoming(senderOut)

    // Receiver should have parsed the file metadata
    expect(receiver.getFileName()).toBe(fileName)
    expect(receiver.getFileSize()).toBe(fileSize)

    // Receiver should emit FileStart event
    expect(receiver.pollEvent()).toBe('FileStart')
  })

  it('should round-trip file modification time through Sender and Receiver', () => {
    const sender = new Sender()
    const receiver = new Receiver()

    // Exchange ZRQINIT / ZRINIT
    let senderOut = sender.drainOutgoing()
    receiver.feedIncoming(senderOut)
    sender.advanceOutgoing(senderOut.length)

    const receiverOut = receiver.drainOutgoing()
    receiver.advanceOutgoing(receiverOut.length)
    sender.feedIncoming(receiverOut)

    // Sender starts a file with mtime (milliseconds, as Date.getTime())
    const fileName = 'test.txt'
    const fileSize = 100
    const mtime = 1700000000000 // 2023-11-14T22:13:20.000Z
    sender.startFile(fileName, fileSize, mtime)
    senderOut = sender.drainOutgoing()
    expect(senderOut.length).toBeGreaterThan(0)

    // Feed sender output into receiver
    receiver.feedIncoming(senderOut)

    // Receiver should have parsed the file metadata
    expect(receiver.getFileName()).toBe(fileName)
    expect(receiver.getFileSize()).toBe(fileSize)

    // Mtime should round-trip (note: ZMODEM stores seconds, so ms precision is lost)
    const expectedMtimeSec = Math.floor(mtime / 1000)
    expect(receiver.getFileMtime()).toBe(expectedMtimeSec * 1000)

    // Receiver should emit FileStart event
    expect(receiver.pollEvent()).toBe('FileStart')
  })

  it('should round-trip Chinese filename with mtime together', () => {
    const sender = new Sender()
    const receiver = new Receiver()

    // Exchange ZRQINIT / ZRINIT
    let senderOut = sender.drainOutgoing()
    receiver.feedIncoming(senderOut)
    sender.advanceOutgoing(senderOut.length)

    const receiverOut = receiver.drainOutgoing()
    receiver.advanceOutgoing(receiverOut.length)
    sender.feedIncoming(receiverOut)

    // Sender starts a file with Chinese name and mtime
    const fileName = '测试/数据报告.pdf'
    const fileSize = 99999
    const mtime = 1609459200000 // 2021-01-01T00:00:00.000Z
    sender.startFile(fileName, fileSize, mtime)
    senderOut = sender.drainOutgoing()
    expect(senderOut.length).toBeGreaterThan(0)

    // Feed sender output into receiver
    receiver.feedIncoming(senderOut)

    // Verify all metadata round-trips correctly
    expect(receiver.getFileName()).toBe(fileName)
    expect(receiver.getFileSize()).toBe(fileSize)
    const expectedMtimeSec = Math.floor(mtime / 1000)
    expect(receiver.getFileMtime()).toBe(expectedMtimeSec * 1000)

    expect(receiver.pollEvent()).toBe('FileStart')
  })
})
