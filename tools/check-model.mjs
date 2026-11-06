import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export function pageHasCurrentModel(pageText, modelId) {
  return pageText.includes(modelId) && !/Planned Deprecation|\bDeprecated\b(?!\s+in\s+favou?r\s+of)/i.test(pageText)
}

async function main() {
  const budget = await readFile(new URL('../src/ai/budget.ts', import.meta.url), 'utf8')
  const match = budget.match(/MODEL_ID\s*=\s*['"]([^'"]+)['"]/) 
  if (!match) throw new Error('Could not read MODEL_ID from src/ai/budget.ts')
  const modelId = match[1]
  const slug = modelId.split('/').at(-1)
  const response = await fetch(`https://developers.cloudflare.com/workers-ai/models/${slug}/`, { signal: AbortSignal.timeout(20_000) })
  if (response.status !== 200) throw new Error(`Model page returned HTTP ${response.status}`)
  const pageText = await response.text()
  if (!pageHasCurrentModel(pageText, modelId)) {
    throw new Error(pageText.includes(modelId) ? `${modelId} page contains a deprecation line` : `${modelId} page does not contain the full model id`)
  }
  console.log(`${modelId}: no deprecation line`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(`Model check failed: ${error.message}`)
    process.exitCode = 1
  })
}
