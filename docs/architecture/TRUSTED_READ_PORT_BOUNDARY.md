# Trusted Read-Port Boundary

<!--
status: ACTIVE
last_verified: 2026-08-30
-->

`babel-cli/src/authority/trustedExecutionPort.ts` is the private factory for
the authoritative trusted-execution read port. The factory applies module-local
`Symbol` branding and freezes the returned object. The architectural test keeps
the factory and its authoritative caller inside the trusted authority lane and
keeps the CLI entrypoint from exporting them.

This is an in-process architecture boundary, not a hostile-process or
cryptographic security boundary. Code that can execute arbitrary JavaScript in
the same Node.js process can inspect module state, load private modules, or
otherwise bypass a TypeScript/package-export convention. Stronger threats must
be handled by the existing sandbox, process, filesystem, and policy controls;
the read-port branding is defense in depth for ordinary application modules.

The public claim is therefore narrow: application modules do not receive the
authoritative factory through normal source imports or package exports, and the
read port can be validated by its private brand. It is not claimed to prevent a
fully compromised same-process worker from forging authority.
