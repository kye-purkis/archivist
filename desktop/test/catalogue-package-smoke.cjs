const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const asar=require('@electron/asar');

assert.equal(process.platform,'darwin','TT-004 package smoke is defined for macOS.');
assert.equal(process.arch,'arm64','TT-004 package smoke must run on macOS arm64.');
const out=path.resolve(__dirname,'../out');
const candidates=[];
if(fs.existsSync(out))for(const arch of fs.readdirSync(out)){const archPath=path.join(out,arch);if(!fs.statSync(archPath).isDirectory())continue;for(const item of fs.readdirSync(archPath)){if(item.endsWith('.app'))candidates.push(path.join(archPath,item));}}
assert.equal(candidates.length,1,'Build one clean macOS arm64 application package first.');
const appPath=candidates[0];
const archive=path.join(appPath,'Contents','Resources','app.asar');
const binaryDir=path.join(appPath,'Contents','MacOS');
const binaries=fs.readdirSync(binaryDir).filter(x=>fs.statSync(path.join(binaryDir,x)).isFile());
assert.ok(fs.existsSync(archive),'Packaged app archive exists.');
assert.equal(binaries.length,1,'Packaged app has one executable.');
const main=asar.extractFile(archive,'.vite/build/main.js').toString('utf8');
for(const table of ['works','editions','edition_contents','content_seasons','formats','edition_formats','owned_copies','acquisitions','currencies','catalogue_state','changesets','change_items'])assert.ok(main.includes(`CREATE TABLE ${table}`),`Bundled migration asset includes ${table}.`);
assert.ok(main.includes('ISO-4217-List-One-2026-09-17'),'Packaged core includes the attributed currency snapshot version.');
const nativeRelative=path.join('node_modules','better-sqlite3','build','Release','better_sqlite3.node');
assert.ok(fs.existsSync(`${archive}.unpacked/${nativeRelative}`),'Electron-ABI SQLite binary is unpacked beside the app archive.');
const smokeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'archivist-tt004-package-'));
const runPhase=(phase)=>{
  const result=spawnSync(path.join(binaryDir,binaries[0]),[`--catalogue-ipc-smoke=${phase}`],{encoding:'utf8',timeout:30000,env:{...process.env,ARCHIVIST_TT004_SMOKE_ROOT:smokeRoot}});
  const output=`${result.stdout||''}${result.stderr||''}`;
  assert.equal(result.error,undefined,`${phase} package process starts: ${result.error?.message}`);
  assert.equal(result.status,0,`${phase} package phase succeeds; exit=${result.status}; output=${output.replace(/\n/g,' ').slice(-1200)}`);
  const line=output.split('\n').find(x=>x.includes('TT004_PACKAGE_IPC_SMOKE_PASS'));
  assert.ok(line,`${phase} emits a successful packaged renderer IPC smoke result; output=${output.replace(/\n/g,' ').slice(-1600)}`);
  return JSON.parse(line.slice(line.indexOf('{')));
};
try{
  const write=runPhase('write');
  const read=runPhase('read');
  assert.equal(write.phase,'write');
  assert.equal(write.recordCount,4);
  assert.equal(write.revisionType,'number');
  assert.equal(write.untrustedCode,'ACCESS_DENIED');
  assert.equal(write.invalidCode,'VALIDATION_FAILED');
  assert.equal(read.phase,'read');
  assert.equal(read.replayed,true);
  assert.equal(read.recordCount,4);
  assert.equal(read.untrustedCode,'ACCESS_DENIED');
  console.log(JSON.stringify({result:'pass',package:'macOS-arm64',bundledMigration:'12 approved tables',nativeBinary:'unpacked in package and loaded through renderer IPC',trustedRendererCall:true,untrustedRendererDenied:true,typedNumericRevision:true,restartReplay:true,synthetic:true}));
}finally{fs.rmSync(smokeRoot,{recursive:true,force:true});}
