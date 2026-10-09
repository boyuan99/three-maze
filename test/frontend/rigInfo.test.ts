// Rig-information JSON (scripts/rig-info-format.mjs, plan item REN-1) on fixture display and GPU
// lists shaped like Electron's screen.getAllDisplays() and app.getGPUInfo('basic').
import { describe, expect, it } from 'vitest'
import { describeRigInfo, formatRigInfo, SCHEMA } from '../../scripts/rig-info-format.mjs'

interface Bounds { x: number, y: number, width: number, height: number }

function display(id: number, bounds: Bounds, hz: number, scaleFactor = 1) {
  return {
    id, label: `Display ${id}`, bounds, workArea: bounds, size: { width: bounds.width, height: bounds.height },
    scaleFactor, displayFrequency: hz, rotation: 0, internal: false, colorDepth: 24, detected: true
  }
}

const nvidia = { vendorId: 0x10de, deviceId: 0x2f04, active: false, driverVersion: '32.0.15.9186', gpuPreference: 3 }
const nvidiaNone = { ...nvidia, gpuPreference: 0 }
const intel = { vendorId: 0x8086, deviceId: 0xa780, active: false, driverVersion: '32.0.101.7088', gpuPreference: 2 }
const warp = { vendorId: 0x1414, deviceId: 0x8c, active: false, driverVersion: '10.0.26100.9278', gpuPreference: 0 }
const angle = (gpu: string) => ({ context: 'webgl2', vendor: 'Google Inc.', renderer: `ANGLE (${gpu} Direct3D11 vs_5_0 ps_5_0, D3D11)` })

function input(overrides: Record<string, unknown> = {}) {
  return {
    takenAt: '2026-10-09T12:00:00.000Z',
    host: 'RIG',
    displays: [display(1, { x: 0, y: 0, width: 1920, height: 1080 }, 60)],
    primaryId: 1,
    gpuInfo: { gpuDevice: [nvidia, nvidiaNone, warp], auxAttributes: { optimus: false, amdSwitchable: false } },
    gpuFeatureStatus: { webgl2: 'enabled' },
    webgl: { default: angle('NVIDIA GeForce RTX 5070'), high_performance: angle('NVIDIA GeForce RTX 5070'), webgl1: angle('NVIDIA GeForce RTX 5070') },
    versions: { electron: '44.7.0', chromium: '152.0.7977.130', three: '0.169.0', rapier: '0.14.0' },
    system: { os: 'Windows 11 Pro', release: '10.0.26200', session: 'Console' },
    repo: { commit: 'abc' },
    errors: [],
    ...overrides
  }
}

describe('rig information', () => {
  it('one 60 Hz display on one GPU: primary named by its id, no warning', () => {
    const info = formatRigInfo(input())
    expect(info.schema).toBe(SCHEMA)
    expect(info.primary_display_id).toBe(1)
    expect(info.displays.map(d => [d.id, d.primary, d.refresh_hz, d.scale_factor])).toEqual([[1, true, 60, 1]])
    expect(info.facts).toMatchObject({ display_count: 1, primary_refresh_hz: 60, refresh_rates_hz: [60], mixed_refresh_rates: false, gpus: ['NVIDIA 0x2f04'], software_rendering: false, remote_session: false })
    expect(info.gpu.devices).toHaveLength(3) // kept as Electron lists them
    expect(info.warnings).toEqual([])
    expect(JSON.parse(JSON.stringify(info))).toEqual(info) // plain JSON
  })

  it('a stimulus display at another refresh rate than the primary display is a warning', () => {
    const info = formatRigInfo(input({
      displays: [display(10, { x: 0, y: 0, width: 1920, height: 1080 }, 60), display(11, { x: 1920, y: 0, width: 2560, height: 1440 }, 144, 1.25)],
      primaryId: 10
    }))
    expect(info.facts.refresh_rates_hz).toEqual([60, 144])
    expect(info.facts.mixed_refresh_rates).toBe(true)
    expect(info.facts.scale_factors).toEqual([1, 1.25])
    expect(info.warnings).toEqual([expect.stringContaining('different refresh rates (60, 144 Hz; primary 60 Hz)')])
  })

  it('names the primary display by its id, also where the app guesses another one from bounds', () => {
    // Bounds in DIPs are not always at 0,0 for the primary display (e.g. after a display is removed)
    const info = formatRigInfo(input({
      displays: [display(20, { x: 0, y: 0, width: 1920, height: 1080 }, 60), display(21, { x: -1920, y: 200, width: 1920, height: 1080 }, 60)],
      primaryId: 21
    }))
    expect(info.displays.find(d => d.primary)?.id).toBe(21)
    expect(info.displays.map(d => d.bounds_at_origin)).toEqual([true, false])
    expect(info.warnings).toEqual([expect.stringContaining('it would mark 20, but the primary display is 21')])
  })

  it('warns about remote desktop, software rendering, several GPUs and hybrid graphics', () => {
    const info = formatRigInfo(input({
      gpuInfo: { gpuDevice: [nvidia, intel, nvidiaNone, warp], auxAttributes: { optimus: true } },
      webgl: { default: angle('Intel(R) UHD Graphics 770'), high_performance: angle('NVIDIA GeForce RTX 5070'), webgl1: { error: 'webgl not available' } },
      system: { os: 'Windows 11 Pro', release: '10.0.26200', session: 'RDP-Tcp#3' }
    }))
    expect(info.facts.gpus).toEqual(['NVIDIA 0x2f04', 'Intel 0xa780'])
    expect(info.facts.remote_session).toBe(true)
    expect(info.system.remote_session).toBe(true)
    const text = info.warnings.join('\n')
    expect(text).toContain('remote-desktop session (SESSIONNAME=RDP-Tcp#3)')
    expect(text).toContain('the default WebGL context renders on "ANGLE (Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)" ' +
      'but a high-performance one on "ANGLE (NVIDIA GeForce RTX 5070 Direct3D11 vs_5_0 ps_5_0, D3D11)": a hybrid-GPU computer')
    expect(text).toContain('2 GPUs (NVIDIA 0x2f04, Intel 0xa780)')
    expect(text).toContain('switchable graphics (NVIDIA Optimus)')
    expect(text).toContain('WebGL webgl1: webgl not available')

    const soft = formatRigInfo(input({ webgl: { default: { renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)' } } }))
    expect(soft.facts.software_rendering).toBe(true)
    expect(soft.warnings).toEqual([expect.stringContaining('WebGL renders in software')])
  })

  it('reports a missing primary display and probe errors', () => {
    const info = formatRigInfo(input({ primaryId: 99, errors: ["app.getGPUInfo('basic'): failed"] }))
    expect(info.facts.primary_refresh_hz).toBeNull()
    expect(info.warnings).toEqual([expect.stringContaining("no display has the primary display's id 99"), "app.getGPUInfo('basic'): failed"])
  })

  it('summarises for the console', () => {
    const text = describeRigInfo(formatRigInfo(input()))
    expect(text).toContain('display 1 (primary): Display 1, 1920x1080 at 0,0, scale 1, 60 Hz')
    expect(text).toContain('GPUs: NVIDIA 0x2f04')
    expect(text).toContain('Electron 44.7.0, Chromium 152.0.7977.130, three 0.169.0, Rapier 0.14.0')
  })
})
