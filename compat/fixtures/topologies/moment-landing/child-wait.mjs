import { writeFileSync } from 'node:fs'

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    writeFileSync('.child-terminated', signal)
    process.exit(0)
  })
}
writeFileSync('.child-ready', String(process.pid))
setInterval(() => {}, 1_000)
