// Validate the buildless project's local assets, fragments and advertised tool count before deploying.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../src/mcp.mjs';
const root=fileURLToPath(new URL('../docs/site/',import.meta.url));
const html=await fs.readFile(path.join(root,'index.html'),'utf8');
const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
let checked=0;
async function check(ref){
 if(!ref||/^(?:https?:|data:|mailto:)/.test(ref))return;
 if(ref.startsWith('#')){if(!ids.has(ref.slice(1)))throw Error(`Missing fragment ${ref}`);return;}
 const file=path.resolve(root,ref.split(/[?#]/)[0]);
 if(file!==root.slice(0,-1)&&!file.startsWith(root))throw Error(`Outside website: ${ref}`);
 await fs.access(file);checked++;
}
for(const [,ref] of html.matchAll(/(?:href|src)="([^"]+)"/g))await check(ref);
const css=await fs.readFile(path.join(root,'style.css'),'utf8');
for(const [,ref] of css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g))await check(ref);
const png=await fs.readFile(path.join(root,'assets/social-card.png'));
if(png.subarray(1,4).toString()!=='PNG'||png.readUInt32BE(16)!==1200||png.readUInt32BE(20)!==630)throw Error('Sharing card must be 1200 × 630 PNG');
if(!html.includes(`${TOOLS.length} AGENT TOOLS`))throw Error('Website tool count is outdated');
const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
if(!pkg.files.includes('!docs/site'))throw Error('Website assets should be excluded from the npm package');
console.log(`Website OK: ${checked} local references, fragment destinations, sharing card, ${TOOLS.length} tools and npm exclusion.`);
