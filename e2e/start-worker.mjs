// Starts the Worker for end to end runs: fresh local state, migrations, then wrangler dev pointed at the mock PayPal.
import { execSync, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

const state = '.wrangler/e2e-state'
const workerPort = Number(process.env.E2E_WORKER_PORT ?? 8793)
const mockPaypalPort = Number(process.env.MOCK_PAYPAL_PORT ?? 8799)
rmSync(state, { recursive: true, force: true })
execSync(`npx wrangler d1 migrations apply running-tab --local --env local --persist-to ${state}`, { stdio: 'inherit' })
const vars = [`PAYPAL_BASE:http://127.0.0.1:${mockPaypalPort}`, 'PAYPAL_CLIENT_ID:e2e-client', 'PAYPAL_CLIENT_SECRET:e2e-pass', 'SESSION_SECRET:e2e-session-key', 'LEDGER_SIGNING_KEY:e2e-ledger-key', 'DEV_FAKE_AI:1', 'AI_MODE:replay', 'DEBUG_SECRET:e2e-debug', 'PAYPAL_WEBHOOK_ID:e2e-webhook']
const args = ['wrangler', 'dev', '--env', 'local', '--port', String(workerPort), '--ip', '127.0.0.1', '--persist-to', state, ...vars.flatMap((v) => ['--var', v])]
const child = spawn('npx', args, { stdio: 'inherit', shell: true })
child.on('exit', (code) => process.exit(code ?? 0))
