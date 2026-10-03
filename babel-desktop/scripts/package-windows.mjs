// License: Apache-2.0
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '..');
const desktopPackage = JSON.parse(readFileSync(join(desktop,'package.json'),'utf8'));
const version = desktopPackage.version;
const nodeVersion = '24.13.1';
const nodeArchiveSha = 'fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279';
const electronVersion = '44.5.1';
const electronArchiveSha = '9b382492dcfee91f8f9e92c91f7972550a1b95d2299cac72279dab33a600d7db';
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const archive = resolve(option('node-archive') || '');
const electronArchive = resolve(option('electron-archive') || '');
const output = resolve(option('output') || join(desktop, 'artifacts', 'windows'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This preview builder supports Windows x64 only');
if (process.versions.node !== nodeVersion) throw new Error(`Build with Node ${nodeVersion} for the pinned runtime`);
if (!existsSync(archive) || sha(readFileSync(archive)) !== nodeArchiveSha) throw new Error('Provide --node-archive=<official node-v24.13.1-win-x64.zip>; checksum must match the pinned value');
if (desktopPackage.devDependencies.electron !== electronVersion) throw new Error('Update the pinned Electron archive and checksum when changing the Electron dependency');
if (!existsSync(electronArchive) || !statSync(electronArchive).isFile() || sha(readFileSync(electronArchive)) !== electronArchiveSha) throw new Error('Provide --electron-archive=<official electron-v44.5.1-win32-x64.zip>; checksum must match the pinned value');
const npmCli = option('npm-cli') || process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error('Provide --npm-cli=<npm/bin/npm-cli.js> or invoke through npm');
const command = (exe, args, cwd = repo) => execFileSync(exe, args, {cwd, windowsHide:true, encoding:'utf8', timeout:300000, maxBuffer:16*1024*1024});
const bundle = join(output, `Babel-Desktop-${version}-win-x64`);
if (existsSync(bundle) || existsSync(`${bundle}.zip`)) throw new Error('Output already exists; choose a new --output directory to retain prior builds');
mkdirSync(output, {recursive:true});
const sourceSha = command('git', ['rev-parse','HEAD']).trim();
const dirty = command('git', ['status','--porcelain','--untracked-files=normal']).trim();
if (dirty) throw new Error('Commit the candidate before packaging so source SHA identifies the complete build');
command(process.execPath, [join(desktop,'scripts','build.mjs')]);
const cliSource = join(repo, 'babel-cli');
command(process.execPath, [npmCli, 'run', 'build'], cliSource);
command(process.execPath, [join(cliSource,'scripts','stage_runtime_assets.mjs')]);
const pack = JSON.parse(command(process.execPath, [npmCli,'pack','--ignore-scripts','--json','--pack-destination',output], cliSource))[0];
// Never reuse node_modules/electron/dist: its installer can retain stale or changed files.
mkdirSync(bundle);
command('tar.exe', ['-xf',electronArchive,'-C',bundle]);
if (readFileSync(join(bundle,'version'),'utf8').trim() !== electronVersion) throw new Error('Verified Electron archive has an unexpected runtime version');
renameSync(join(bundle,'electron.exe'), join(bundle,'Babel Desktop.exe'));
const app = join(bundle, 'resources', 'app');
mkdirSync(app, {recursive:true});
for (const name of ['native','dist','assets','LICENSE','NOTICE']) cpSync(join(desktop,name), join(app,name), {recursive:true});
writeFileSync(join(app,'package.json'), JSON.stringify({name:'babel-north-star-desktop',version,main:'native/main.mjs',type:'module',private:true},null,2));
const runtime = join(bundle,'resources','babel-runtime');
const cli = join(runtime,'cli');
mkdirSync(cli, {recursive:true});
command('tar.exe', ['-xzf',join(output,pack.filename),'-C',cli,'--strip-components=1']);
// The same canonical lockfile resolves production dependencies; no lifecycle scripts or downloads at first launch.
cpSync(join(cliSource,'package-lock.json'), join(cli,'package-lock.json'));
command(process.execPath, [npmCli,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'], cli);
const nodeExtract = join(output, `node-${sourceSha.slice(0,12)}`);
mkdirSync(nodeExtract);
command('tar.exe', ['-xf',archive,'-C',nodeExtract]);
const nodeSource = join(nodeExtract, `node-v${nodeVersion}-win-x64`);
mkdirSync(join(runtime,'node'));
for (const name of ['node.exe','LICENSE']) cpSync(join(nodeSource,name),join(runtime,'node',name));
cpSync(join(desktop,'scripts','cli-launch.mjs'),join(runtime,'cli-launch.mjs'));
writeFileSync(join(bundle,'Babel CLI.cmd'),'@echo off\r\n"%~dp0resources\\babel-runtime\\node\\node.exe" "%~dp0resources\\babel-runtime\\cli-launch.mjs" %*\r\nexit /b %errorlevel%\r\n');
cpSync(join(desktop,'docs','INSTALL-WINDOWS.md'),join(bundle,'INSTALL.md'));
const metadata = {version,sourceSha,platform:'win32-x64',electron:electronVersion,electronArchiveSha256:electronArchiveSha,node:nodeVersion,nodeArchiveSha256:nodeArchiveSha,cliVersion:pack.version,cliArchiveSha256:sha(readFileSync(join(output,pack.filename))),signed:false};
writeFileSync(join(bundle,'BUILD.json'), JSON.stringify(metadata,null,2)+'\n');
const files = [];
// Match actual build-machine prefixes; upstream type declarations contain public
// example user paths which are not private build provenance.
const buildPrefixes = [homedir(), repo].flatMap(path => [path, path.replaceAll('\\','/'), path.replaceAll('\\','\\\\')]);
function inventory(dir, prefix='') {
  for(const item of readdirSync(dir,{withFileTypes:true})) {
    const rel = prefix+item.name, path = join(dir,item.name);
    if(item.isSymbolicLink()) throw new Error(`Unexpected link: ${rel}`);
    if(item.isDirectory()) inventory(path,rel+'/');
    else {
      if(/(?:^|\/)(?:\.env(?:\..*)?|\.git|auth\.json|ui-connection\.json|transcript\.jsonl)$|\.(?:log|pem|key)$/i.test(rel)) throw new Error(`Forbidden package file: ${rel}`);
      const bytes = readFileSync(path);
      if(buildPrefixes.some(prefix => bytes.includes(Buffer.from(prefix)))) throw new Error(`Personal build path in package: ${rel}`);
      files.push({path:rel,bytes:statSync(path).size,sha256:sha(bytes)});
    }
  }
}
inventory(bundle);
writeFileSync(join(output,'manifest.json'),JSON.stringify(files,null,2)+'\n');
command('tar.exe', ['-a','-cf',`${bundle}.zip`,'-C',output,basename(bundle)]);
writeFileSync(join(output,'SHA256SUMS'),`${sha(readFileSync(`${bundle}.zip`))}  ${basename(bundle)}.zip\n`);
console.log(JSON.stringify({...metadata,artifact:`${bundle}.zip`,bytes:statSync(`${bundle}.zip`).size,files:files.length},null,2));
