const capabilities=Object.freeze({schemaVersion:1 as const,credentialEnvironment:'native-resolved-v1' as const})

/** Local metadata only; no credentials, provider discovery or inference. */
export function desktopCapabilities():typeof capabilities{return capabilities}

/** Task text and combined command options cannot select the metadata path. */
export function isDesktopCapabilityProbe(argv:readonly string[]):boolean{
  return argv.length===3&&argv[2]==='--desktop-capabilities'
}
