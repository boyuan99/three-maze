// Request/reply handling of the renderer's WebSocket client (src/services/MinimalBackendClient.js).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectedClient } from './fakeBackend.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('MinimalBackendClient.request', () => {
  it('rejects with the error of an experiment_error reply', async () => {
    const { client, sent, reply } = connectedClient()
    const pending = client.request('experiment_register', { filename: 'x.py', config: {} }, 30000)
    reply('experiment_error', { error: 'Could not open port COM3' }, sent[0].requestId)
    await expect(pending).rejects.toHaveProperty('message', 'Could not open port COM3')
  })

  it('rejects with the message of an internal error reply (code and message, no error field)', async () => {
    const { client, sent, reply } = connectedClient()
    const pending = client.request('experiment_register', {}, 30000)
    reply('error', { code: 'INTERNAL_ERROR', message: 'boom' }, sent[0].requestId)
    await expect(pending).rejects.toHaveProperty('message', 'boom')
  })

  it('resolves with the data of experiment_registered and does not broadcast the reply as an event', async () => {
    const { client, sent, reply } = connectedClient()
    const listener = vi.fn()
    client.on('experiment_registered', listener)
    const pending = client.request('experiment_register', {}, 30000)
    reply('experiment_registered', { hardwareMode: 'standalone' }, sent[0].requestId)
    await expect(pending).resolves.toEqual({ hardwareMode: 'standalone' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('applies a per-request timeout instead of the 5 s default', async () => {
    vi.useFakeTimers()
    const { client } = connectedClient()
    expect(client.requestTimeout).toBe(5000)
    const onError = vi.fn()
    client.request('slow', {}, 60).catch(onError)
    await vi.advanceTimersByTimeAsync(59)
    expect(onError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0]).toHaveProperty('message', 'Request timeout: slow')
  })

  it('marks a timed-out request with code TIMEOUT (the backend may still handle it later)', async () => {
    vi.useFakeTimers()
    const { client } = connectedClient()
    const failure = client.request('experiment_register', { filename: 'hallway02_experiment.py' }, 50)
      .then(() => null, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)
    const error = await failure
    expect(error).toBeInstanceOf(Error)
    expect(error).toHaveProperty('code', 'TIMEOUT')
  })
})

describe('MinimalBackendClient while the backend closes the socket', () => {
  // `connected` stays true until onclose fires; until then the socket is CLOSING (readyState 2)
  function closingClient () {
    const fake = connectedClient()
    Object.defineProperty(fake.client.ws, 'readyState', { value: 2 })
    return fake
  }

  it('drops a fire-and-forget message instead of sending it on the closing socket', () => {
    const { client, sent } = closingClient()
    expect(() => client.send('position_update', { seq: 1 })).not.toThrow()
    expect(sent).toHaveLength(0)
  })

  it('rejects a request at once', async () => {
    const { client, sent } = closingClient()
    await expect(client.request('experiment_stop', {}, 30000)).rejects.toHaveProperty('message', 'Connection closed')
    expect(sent).toHaveLength(0)
  })
})
