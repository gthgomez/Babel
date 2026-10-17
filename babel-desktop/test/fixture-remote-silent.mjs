// License: Apache-2.0 - see LICENSE
// Fixture remote-serve child: starts no listener and never announces one.
// It stays alive so the host must fail closed instead of adopting whatever
// process happens to answer on the requested port.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
setInterval(() => {}, 1000);
