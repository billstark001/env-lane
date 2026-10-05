import { writeFileSync } from 'node:fs'

writeFileSync('.child-ready', String(process.pid))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    writeFileSync('.child-terminated', signal)
    process.exit(0)
  })
}
setInterval(() => {}, 1_000)
