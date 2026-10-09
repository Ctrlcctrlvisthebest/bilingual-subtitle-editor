import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const artifact=resolve(root,'dist/minitool');
const built=spawnSync(process.execPath,[resolve(root,'build-minitool.mjs'),artifact],{cwd:root,stdio:'inherit'});
if(built.error)throw built.error;
if(built.status!==0)process.exit(built.status||1);
const tests=readdirSync(resolve(root,'minitool')).filter(name=>name.endsWith('.test.cjs')).sort().map(name=>resolve(root,'minitool',name));
const result=spawnSync(process.execPath,['--test',...tests],{cwd:root,stdio:'inherit',env:{...process.env,MINITOOL_ARTIFACT:artifact,MINITOOL_BUNDLE:resolve(artifact,'assets/app.js')}});
if(result.error)throw result.error;
process.exit(result.status||0);
