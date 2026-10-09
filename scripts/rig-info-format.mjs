// Turns what scripts/rig-info.cjs collects inside Electron into the rig-information JSON (plan item
// REN-1), and derives the facts and warnings the gate and the rendering settings need: is the
// stimulus display the primary display, do the displays share one refresh rate, which GPU renders,
// is this a remote-desktop session. Pure: no Electron and no I/O, so Vitest tests it on fixture
// display lists (test/frontend/rigInfo.test.ts).

export const SCHEMA = 'three-maze/rig-info@1'

const VENDORS = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel', 0x1414: 'Microsoft', 0x15ad: 'VMware', 0x5143: 'Qualcomm' }
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|microsoft basic render|\bwarp\b|software/i

const hex = (n) => (Number.isInteger(n) ? `0x${(n >>> 0).toString(16).padStart(4, '0')}` : null)

function display (d, primaryId) {
  return {
    id: d.id,
    label: d.label ?? '',
    primary: d.id === primaryId,
    // electron/main.js get-displays (:634) guesses the primary display from this
    bounds_at_origin: d.bounds?.x === 0 && d.bounds?.y === 0,
    bounds: d.bounds,
    work_area: d.workArea,
    size: d.size,
    scale_factor: d.scaleFactor,
    refresh_hz: d.displayFrequency,
    rotation: d.rotation,
    internal: d.internal,
    color_depth: d.colorDepth,
    detected: d.detected
  }
}

function gpuDevice (g) {
  return {
    vendor: VENDORS[g.vendorId] ?? null,
    vendor_id: hex(g.vendorId),
    device_id: hex(g.deviceId),
    active: !!g.active,
    driver_vendor: g.driverVendor,
    driver_version: g.driverVersion,
    gpu_preference: g.gpuPreference
  }
}

/**
 * input: { takenAt, host, displays (screen.getAllDisplays()), primaryId (screen.getPrimaryDisplay().id),
 *   gpuInfo (app.getGPUInfo('basic')), gpuFeatureStatus, webgl ({ default, high_performance, webgl1 }
 *   from a hidden window), versions, system, repo, errors }
 *
 * @param {{ takenAt: string, host: string, displays?: Array<Record<string, any>>, primaryId: number,
 *   gpuInfo?: any, gpuFeatureStatus?: any, webgl?: Record<string, any> | null,
 *   versions?: Record<string, string | null>, system?: Record<string, any>, repo?: Record<string, any>,
 *   errors?: string[] }} input
 */
export function formatRigInfo (input) {
  const displays = (input.displays || []).map(d => display(d, input.primaryId))
  const primary = displays.find(d => d.primary) || null
  const devices = ((input.gpuInfo && input.gpuInfo.gpuDevice) || []).map(gpuDevice)
  const webgl = input.webgl || {}
  const rates = [...new Set(displays.map(d => d.refresh_hz).filter(r => Number.isFinite(r)))].sort((a, b) => a - b)
  const session = input.system?.session ?? null
  const remote = typeof session === 'string' && /^rdp-/i.test(session)
  const renderers = ['default', 'high_performance', 'webgl1'].map(k => webgl[k]?.renderer).filter(Boolean)
  const software = renderers.some(r => SOFTWARE_RENDERER.test(r))
  const def = webgl.default?.renderer
  const high = webgl.high_performance?.renderer

  const warnings = []
  if (!primary) warnings.push(`no display has the primary display's id ${input.primaryId}`)
  if (rates.length > 1) {
    warnings.push(`the displays run at different refresh rates (${rates.join(', ')} Hz; primary ${primary?.refresh_hz ?? '?'} Hz): ` +
      'Chromium paces every window by the primary display, so a stimulus display at another rate fails the clock check (ADR-0003 Risks)')
  }
  const guessed = displays.filter(d => d.bounds_at_origin)
  if (primary && (guessed.length !== 1 || guessed[0].id !== primary.id)) {
    warnings.push(`the app's get-displays guesses the primary display from bounds at 0,0 (electron/main.js:634): it would mark ${guessed.map(d => d.id).join(', ') || 'none'}, ` +
      `but the primary display is ${primary.id}`)
  }
  if (remote) warnings.push(`remote-desktop session (SESSIONNAME=${session}): frame timing runs on a fallback timer; do not measure over remote desktop`)
  if (software) warnings.push(`WebGL renders in software (${renderers.find(r => SOFTWARE_RENDERER.test(r))})`)
  if (def && high && def !== high) {
    warnings.push(`the default WebGL context renders on "${def}" but a high-performance one on "${high}": a hybrid-GPU computer; ` +
      'the app uses the default context (REN-3 decides on force_high_performance_gpu)')
  }
  // Chromium lists a GPU once per power preference; Microsoft's adapter is the software renderer
  const hardware = [...new Map(devices.filter(g => g.vendor_id !== '0x1414')
    .map(g => [`${g.vendor_id}:${g.device_id}`, `${g.vendor || g.vendor_id} ${g.device_id}`])).values()]
  if (hardware.length > 1) {
    warnings.push(`${hardware.length} GPUs (${hardware.join(', ')}): check that the GPU that renders (${def || 'unknown'}) drives ` +
      'the primary display, or Chromium falls back to a timer (ADR-0003 Risks)')
  }
  const aux = input.gpuInfo?.auxAttributes || {}
  if (aux.optimus || aux.amdSwitchable) {
    warnings.push(`switchable graphics (${aux.optimus ? 'NVIDIA Optimus' : 'AMD switchable'}): a hybrid-GPU computer (REN-3 decides on force_high_performance_gpu)`)
  }
  for (const [k, v] of Object.entries(webgl)) if (v && v.error) warnings.push(`WebGL ${k}: ${v.error}`)
  for (const e of input.errors || []) warnings.push(e)

  return {
    schema: SCHEMA,
    taken_at: input.takenAt,
    host: input.host,
    system: { ...input.system, remote_session: remote },
    versions: input.versions,
    repo: input.repo,
    primary_display_id: input.primaryId,
    displays,
    gpu: {
      devices,
      webgl,
      feature_status: input.gpuFeatureStatus ?? null,
      aux: input.gpuInfo?.auxAttributes ?? null
    },
    facts: {
      display_count: displays.length,
      primary_refresh_hz: primary?.refresh_hz ?? null,
      refresh_rates_hz: rates,
      mixed_refresh_rates: rates.length > 1,
      scale_factors: [...new Set(displays.map(d => d.scale_factor))],
      gpus: hardware,
      webgl_renderer: def ?? null,
      software_rendering: software,
      remote_session: remote
    },
    warnings
  }
}

/** A few lines for the console */
export function describeRigInfo (info) {
  const lines = []
  for (const d of info.displays) {
    lines.push(`  display ${d.id}${d.primary ? ' (primary)' : ''}: ${d.label || 'no label'}, ${d.bounds?.width}x${d.bounds?.height} at ` +
      `${d.bounds?.x},${d.bounds?.y}, scale ${d.scale_factor}, ${d.refresh_hz} Hz`)
  }
  lines.push(`  GPUs: ${info.facts.gpus.join(', ') || 'none listed'}`)
  lines.push(`  WebGL: ${info.facts.webgl_renderer || 'unknown'}`)
  const v = info.versions || {}
  lines.push(`  Electron ${v.electron}, Chromium ${v.chromium}, three ${v.three}, Rapier ${v.rapier}; ${info.system?.os} ${info.system?.release}`)
  for (const w of info.warnings) lines.push(`  WARNING: ${w}`)
  return lines.join('\n')
}
