// License: Apache-2.0 - see LICENSE
// Fixture remote-serve child: announces the loopback listener it actually
// bound and answers /health, matching the real `babel remote serve` contract
// (including echoing the host-supplied per-launch instance label).
import {createServer} from 'node:http';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const requested = Number(portIndex >= 0 ? args[portIndex + 1] : 0);
const instance = (process.env.BABEL_BRIDGE_INSTANCE ?? '').trim();

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(
      JSON.stringify({
        ok: true,
        bind: `127.0.0.1:${server.address()?.port ?? requested}`,
        protocol: 'adr-010',
        ...(instance ? {instance} : {}),
      }),
    );
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(requested, '127.0.0.1', () => {
  console.log(`Babel Remote listening on http://127.0.0.1:${server.address().port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
