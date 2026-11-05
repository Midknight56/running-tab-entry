import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

const files = ['README.md', 'docs/DEVPOST-DRAFT.md']
const urls = new Set()
for (const file of files) {
  // The Devpost draft stays in the private repo only.
  if (!existsSync(new URL(`../../${file}`, import.meta.url))) continue
  const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const url = match[0].replace(/[),.;!?]+$/, '')
    urls.add(url)
  }
}

const list = [...urls]
const results = new Array(list.length)
let next = 0
async function check() {
  while (next < list.length) {
    const index = next++
    const url = list[index]
    if (new URL(url).hostname.endsWith('sandbox.paypal.com')) {
      results[index] = { status: 'SKIPPED', url }
      continue
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal })
      results[index] = { status: String(response.status), url }
      await response.body?.cancel()
    } catch (error) {
      results[index] = { status: `ERROR ${error.name === 'AbortError' ? 'TIMEOUT' : error.message}`, url }
    } finally {
      clearTimeout(timeout)
    }
  }
}

await Promise.all(Array.from({ length: Math.min(4, list.length) }, () => check()))
console.log('Status  URL')
for (const result of results) console.log(`${result.status.padEnd(7)} ${result.url}`)
if (results.some(result => !result.status.startsWith('2') && result.status !== 'SKIPPED')) process.exitCode = 1
