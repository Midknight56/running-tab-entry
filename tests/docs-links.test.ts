import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function filesUnder(dir: string, extension: string): string[] {
  if (!existsSync(join(root, dir))) return []
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(path, extension) : extname(entry.name) === extension ? [path] : []
  })
}

function markdownFiles(): string[] {
  return ['README.md', ...filesUnder('docs', '.md')]
}

function checkedFiles(): string[] {
  return [
    ...markdownFiles(),
    'wrangler.jsonc',
    ...filesUnder('capture', '.py'),
    ...filesUnder('capture', '.ts'),
    ...readdirSync(root).filter(name => /^playwright.*\.config\.ts$/.test(name)),
    ...filesUnder('tests/live', '.mjs'),
  ]
}

describe('documentation links', () => {
  it('uses the hosted workers.dev host everywhere', () => {
    const expected = 'running-tab.midknight-labs.workers.dev'
    const failures: string[] = []
    for (const file of checkedFiles()) {
      const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        for (const match of line.matchAll(/(?:https?:\/\/)?([a-z0-9.-]+\.workers\.dev)\b/gi)) {
          if (match[1].toLowerCase() !== expected) failures.push(`${file}:${index + 1} ${match[1]}`)
        }
      })
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('points every relative markdown link at an existing file or folder', () => {
    const failures: string[] = []
    for (const file of markdownFiles()) {
      const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
          const link = match[1].trim().replace(/^<|>$/g, '')
          if (/^(https?:|mailto:)/i.test(link)) continue
          const path = link.split('#', 1)[0]
          if (!path) continue
          const target = path.startsWith('/') ? resolve(root, `.${path}`) : resolve(root, dirname(join(root, file)), path)
          if (!existsSync(target)) failures.push(`${file}:${index + 1} ${link}`)
        }
      })
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('links the hosted app root and health page from the readme', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const links = [...readme.matchAll(/\[[^\]]*\]\((https:\/\/[^)]+)\)/g)].map(match => match[1])
    expect(links).toContain('https://running-tab.midknight-labs.workers.dev/')
    expect(links).toContain('https://running-tab.midknight-labs.workers.dev/health')
  })
})
