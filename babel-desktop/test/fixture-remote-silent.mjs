// License: Apache-2.0 - see LICENSE
// Fixture remote-serve child: starts no listener and never announces one.
// It stays alive until the host terminates it, so a host that waits for its own
// child fails closed instead of adopting whatever answers on the port.
//
// It must die on the host's own termination: on POSIX the host sends SIGTERM
// (only Windows force-kills the tree), and a fixture that ignored it would keep
// both this process and the host's test run alive.
setInterval(() => {}, 1000);
