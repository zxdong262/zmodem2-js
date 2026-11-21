import assert from 'node:assert/strict'
import test from 'node:test'
import { Sender, Receiver } from 'zmodem2'

test('transfers empty and nonempty files in one session and finishes on both ends', () => {
  const sender = new Sender()
  const receiver = new Receiver()
  sender.drainOutgoing()
  sender.feedIncoming(receiver.drainOutgoing())
  for (const content of ['', 'payload', '']) {
    sender.startFile('file', content.length)
    const chunks = []
    const events = []
    for (let step = 0; step < 20; step++) {
      receiver.feedIncoming(sender.drainOutgoing())
      chunks.push(Buffer.from(receiver.drainFile()))
      let event
      while ((event = receiver.pollEvent()) !== null) events.push(event)
      sender.feedIncoming(receiver.drainOutgoing())
      if (sender.pollEvent() === 'FileComplete') break
      const request = sender.pollFile()
      if (request) sender.feedFile(Buffer.from(content).subarray(request.offset, request.offset + request.len))
    }
    assert.deepEqual(events, ['FileStart', 'FileComplete'])
    assert.equal(Buffer.concat(chunks).toString(), content)
  }
  sender.finishSession()
  receiver.feedIncoming(sender.drainOutgoing())
  assert.equal(receiver.pollEvent(), 'SessionComplete')
  sender.feedIncoming(receiver.drainOutgoing())
  assert.equal(sender.pollEvent(), 'SessionComplete')
  assert.equal(Buffer.from(sender.drainOutgoing()).toString(), 'OO')
})
