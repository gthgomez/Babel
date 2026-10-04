import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
const built=new URL('../dist/index.html',import.meta.url);
test('portable bundle has an exact script CSP hash and parses as JavaScript',async()=>{
 const html=await readFile(built,'utf8');
 const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
 assert.equal(scripts.length,1);
 const script=scripts[0][1];
 assert.ok(html.includes(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`));
 assert.doesNotThrow(()=>new Script(script));
 assert.ok(!html.includes("script-src 'unsafe-inline'"));
});
test('portable bundle has no external resource or unfilled template dependency',async()=>{
 const html=await readFile(built,'utf8');
 assert.doesNotMatch(html,/__(?:LOGO|MENU|PLUS|CHEVRON|STOP|CLOSE|SETTINGS)__|\/\*(?:SCRIPT|STYLES)\*\//);
 assert.doesNotMatch(html,/<(?:script|link|img)[^>]+(?:src|href)=["']https?:/);
 assert.ok(html.includes("connect-src 'none'"));
 assert.ok(html.includes('REFERENCE PREVIEW'));
});
