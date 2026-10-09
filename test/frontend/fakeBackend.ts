// A MinimalBackendClient connected to a fake socket: it records what the client sends and lets a
// test deliver backend messages as if they had arrived over the WebSocket.
import { MinimalBackendClient } from '../../src/services/MinimalBackendClient.js'

export interface SentMessage {
  type: string
  data: Record<string, unknown>
  requestId?: number
}

export function connectedClient() {
  const client = new MinimalBackendClient()  // never connects: no URL needed
  const sent: SentMessage[] = []
  client.connected = true
  client.ws = { send: (message: string) => { sent.push(JSON.parse(message)) } } as unknown as WebSocket
  const reply = (type: string, data: Record<string, unknown>, requestId?: number) =>
    client.handleMessage(JSON.stringify({ type, data, requestId }))
  return { client, sent, reply }
}
