import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

// The owner's rules (9 Nov): what a visitor sees never says sandbox, test card, test money, fake, pretend, "for this demo",
// simulated, synthetic or sample history.
const BANNED = /sand ?box|test money|test card|fake|pretend|for this demo|simulat\w*|synthetic|sample (case|data|history|review|run|copy)|not real money|play money|fictional|scripted demonstration/i
const SRC = resolve(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
    return name.endsWith('.tsx') ? [path] : []
  })
}

// Comments and class names are not shown, so only the rest of each line is read.
function shownText(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/className=("[^"]*"|\{`[^`]*`\})/g, '')
}

it('no desk screen shows a showcase banned word', () => {
  const hits = sources(SRC).flatMap((file) => shownText(readFileSync(file, 'utf8')).split('\n')
    .filter((line) => BANNED.test(line)).map((line) => `${file.slice(SRC.length + 1)}: ${line.trim()}`))
  expect(hits).toEqual([])
})
