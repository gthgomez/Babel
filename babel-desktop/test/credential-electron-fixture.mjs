// License: Apache-2.0
// Synthetic Electron fixture only; no real profile/store is opened.
import {app,safeStorage} from 'electron';
import {join,resolve} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {configureCredentialProtection,sharedUserPreferencesPath,saveProviderCredential,removeProviderCredential,applyNativeCredentialEnvironment} from '../native/credentials.mjs';
const root=process.env.BABEL_CREDENTIAL_FIXTURE_ROOT;
if(!root)throw new Error('Fixture profile required');
app.setPath('userData',join(root,'electron-profile'));app.disableHardwareAcceleration();
app.whenReady().then(()=>{
  try{
    configureCredentialProtection(safeStorage);
    const configDirectory=join(root,'config'),key='fixture-native';
    const available=safeStorage.isEncryptionAvailable();
    if(!available){process.stdout.write(JSON.stringify({available:false})+'\n');app.exit(0);return;}
    saveProviderCredential({configDirectory,provider:'openrouter',apiKey:key});
    const env={};applyNativeCredentialEnvironment(env,{configDirectory,provider:'openrouter'});
    const bytes=readFileSync(join(configDirectory,'desktop-credentials.json'),'utf8');
    const roundTrip=env.OPENROUTER_API_KEY===key;
    removeProviderCredential({configDirectory,provider:'openrouter',scope:'private'});
    const removed={};applyNativeCredentialEnvironment(removed,{configDirectory,provider:'openrouter'});
    const sharedHomeMatches=resolve(sharedUserPreferencesPath(process.env,app.getPath('home'))).toLowerCase()===resolve(process.env.USERPROFILE||process.env.HOME,'.babel','preferences.json').toLowerCase();
    process.stdout.write(JSON.stringify({available:true,roundTrip,plaintextAbsent:!bytes.includes(key),dotenvAbsent:!existsSync(join(configDirectory,'.env')),removed:removed.OPENROUTER_API_KEY===undefined,sharedHomeMatches})+'\n');
    app.exit(0);
  }catch{process.stdout.write(JSON.stringify({failed:true})+'\n');app.exit(1);}
});
