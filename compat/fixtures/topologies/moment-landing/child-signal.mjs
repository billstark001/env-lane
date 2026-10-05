if (process.platform === 'win32') process.exit(1)
else process.kill(process.pid, 'SIGTERM')
