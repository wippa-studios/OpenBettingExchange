'use strict';
// Proves the snapshot is 0600 the moment backup() returns, and that a snapshot
// we cannot lock down is deleted rather than left readable.
process.env.SCRYPT_N='16384'; process.env.COMMISSION_RATE='0.025';
process.env.BOT_ENABLED='false'; process.env.DRIFT_ENABLED='false';
const assert=require('assert'), fs=require('fs'), path=require('path'), os=require('os');
const OPS=require('../lib/ops');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bk-'));
const {DatabaseSync}=require('node:sqlite');
function freshDb(){
  const f=path.join(dir,'src-'+Math.random().toString(36).slice(2)+'.db');
  const d=new DatabaseSync(f);
  d.exec('CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, pass_hash TEXT, balance_cents INTEGER)');
  d.prepare('INSERT INTO users(pass_hash,balance_cents) VALUES (?,?)').run('scrypt$deadbeef',1000);
  return d;
}
let checks=0;
const ok=(n,f)=>{try{f();checks++;console.log('  ok  ',n);}catch(e){console.log('  FAIL',n,'\n       ',e.message);process.exitCode=1;}};

// 1. mode
ok('snapshot is 0600, not the umask default',()=>{
  OPS.backup(freshDb(),{dir});
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.db'));
  assert.ok(files.length>0,'no snapshot produced');
  const mode=fs.statSync(path.join(dir,files[0])).mode & 0o777;
  assert.strictEqual(mode.toString(8),'600',`mode was ${mode.toString(8)}, expected 600`);
});
// 2. control: SQLite's default for a fresh file here really is 0644,
//    so check 1 is not passing because this umask already produces 0600.
ok('CONTROL: an unfixed snapshot would indeed be world-readable',()=>{
  const probe=path.join(dir,'control.db');
  require('node:sqlite');
  const {DatabaseSync}=require('node:sqlite');
  const d=new DatabaseSync(probe); d.exec('CREATE TABLE t(x)'); d.close();
  const mode=fs.statSync(probe).mode & 0o777;
  assert.notStrictEqual(mode.toString(8),'600',`umask here already yields 600 (${mode.toString(8)}); the test cannot fail`);
});
// 3. a chmod failure must delete the snapshot, not shrug and report success
ok('a snapshot that cannot be locked down is deleted, not left readable',()=>{
  const fsmod=require('fs');
  const real=fsmod.chmodSync;
  fsmod.chmodSync=()=>{const e=new Error('EPERM'); e.code='EPERM'; throw e;};
  try{
    assert.throws(()=>OPS.backup(freshDb(),{dir:path.join(dir,'fail')}),/permissions/i);
    const left=fs.existsSync(path.join(dir,'fail'))?fs.readdirSync(path.join(dir,'fail')):[];
    assert.strictEqual(left.length,0,`snapshot left behind: ${left.join(',')}`);
  } finally { fsmod.chmodSync=real; }
});
console.log(`\n${checks} checks passed`);
