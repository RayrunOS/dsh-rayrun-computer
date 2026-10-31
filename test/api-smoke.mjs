/**
 * Development smoke test for the Rayrun client. Not part of the bundle.
 *
 *   node test/api-smoke.mjs
 */
import { createRayrun } from '../lib/rayrun.js'

const id = process.argv[2]
if (!id) {
  console.error('usage: node test/api-smoke.mjs <sandbox-id>')
  process.exit(2)
}
const ray = createRayrun({ baseUrl: process.env.RAYRUN_API_URL ?? 'https://api.rayrunos.com/v1' }, {})

const connection = await ray.connection()
console.log('connection:', {
  baseUrl: connection.baseUrl,
  configured: connection.configured,
  tokenSource: connection.tokenSource,
})

const overview = await ray.overview()
console.log('overview:', {
  machines: overview.machines.length,
  agents: overview.agents.length,
  desktopMachines: overview.machines.filter((item) => item.remote_desktop).length,
  balance: overview.balance,
})
console.log(
  'live:',
  overview.machines.map((item) => ({
    name: item.name,
    status: item.status,
    desktop: item.remote_desktop,
    url: item.desktop_url,
    reason: item.desktop_reason,
  })),
)

const test = await ray.testConnection({})
console.log('testConnection:', test)

const detail = await ray.machine(id)
console.log('machine:', {
  name: detail.name,
  status: detail.status,
  desktop: detail.remote_desktop,
  url: detail.desktop_url,
  reason: detail.desktop_reason,
})

const exec = await ray.exec(id, { command: 'printf "hello from $(hostname)\\n"; rayrun-desktop status 2>&1 | head -20' })
console.log('exec:', { exit_code: exec.exit_code, stdout: exec.stdout, stderr: exec.stderr })

const password = await ray.desktopPassword(id)
console.log('desktopPassword:', { exit_code: password.exit_code, stdout: password.stdout, stderr: password.stderr })

const stopped = await ray.machineAction(id, 'stop')
console.log('stop:', stopped?.status)

await new Promise((resolve) => setTimeout(resolve, 3000))
const started = await ray.machineAction(id, 'start')
console.log('start:', started?.status)
