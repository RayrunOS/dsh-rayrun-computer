import fs from 'node:fs'

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function dict(name) {
  const start = src.indexOf(`const ${name} = {`)
  const end = src.indexOf('\n    }', start)
  const block = src.slice(start, end)
  const keys = new Set()
  for (const line of block.split('\n')) {
    const match = line.match(/^ {6}([A-Za-z_][A-Za-z0-9_]*):/)
    if (match) keys.add(match[1])
  }
  return keys
}

const zh = dict('ZH')
const en = dict('EN')
const used = new Set([...src.matchAll(/\bt\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]))
for (const match of src.matchAll(/tf\(t, '([^']+)'/g)) used.add(match[1])

console.log('zh keys', zh.size, 'en keys', en.size, 'used', used.size)
console.log('missing zh:', [...used].filter((key) => !zh.has(key)).sort().join(', ') || 'none')
console.log('missing en:', [...used].filter((key) => !en.has(key)).sort().join(', ') || 'none')
console.log('zh only:', [...zh].filter((key) => !en.has(key)).join(', ') || 'none')
console.log('en only:', [...en].filter((key) => !zh.has(key)).join(', ') || 'none')
console.log('unused zh:', [...zh].filter((key) => !used.has(key)).sort().join(', ') || 'none')
