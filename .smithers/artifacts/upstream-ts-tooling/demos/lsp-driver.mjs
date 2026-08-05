import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(process.cwd());
const demo = resolve(root, '.smithers/artifacts/upstream-ts-tooling/demos/lsp-project');
await mkdir(demo, { recursive: true });
const baml = join(demo, 'main.baml');
const consumer = join(demo, 'consumer.ts');
const source = "import { b, Person } from './main.baml';\nconst person: Person = { name: 'Ada' };\nexport const greeting = b.Greet(person);\n";
await writeFile(join(demo, 'package.json'), '{"private":true}');
await writeFile(join(demo, 'baml.toml'), '');
await writeFile(baml, '/// A person imported directly into TypeScript.\nclass Person { name string }\n/// Greets a Person from BAML.\nfunction Greet(person: Person) -> string { "hello" }\n');
await writeFile(consumer, source);
await writeFile(join(demo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowNonTsExtensions: true, module: 'esnext', moduleResolution: 'bundler', strict: true, target: 'es2022', plugins: [{ name: '@boundaryml/baml-tooling/typescript-plugin', root: demo }] }, files: ['consumer.ts'] }));
const serverPath = resolve(root, 'typescript2/node_modules/typescript/lib/tsserver.js');
const probe = resolve(root, 'typescript2/pkg-ts-tooling-e2e/node_modules');
const child = spawn(process.execPath, [serverPath, '--pluginProbeLocations', probe, '--allowLocalPluginLoads'], { cwd: demo, env: { ...process.env, BAML_TOOLING_BRIDGE_PATH: resolve(root, 'baml_language/sdks/typescript/bridge_tooling/baml_tooling_node.darwin-arm64.node') }, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = Buffer.alloc(0), seq = 0; const pending = new Map();
child.stdout.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); while (true) { const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return; const n = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0,end).toString())?.[1]); const start=end+4; if (!n || buffer.length < start+n) return; const msg=JSON.parse(buffer.subarray(start,start+n)); buffer=buffer.subarray(start+n); if (msg.type==='response' && pending.has(msg.request_seq)) { pending.get(msg.request_seq)(msg.body); pending.delete(msg.request_seq); } } });
function request(command, args) { const id=++seq; child.stdin.write(JSON.stringify({seq:id,type:'request',command,arguments:args})+'\n'); return new Promise((ok,no)=>{ const t=setTimeout(()=>no(new Error(command+' timed out')),10000); pending.set(id, body=>{clearTimeout(t);ok(body)}); }); }
try {
  await request('open', { file: consumer, fileContent: source });
  await new Promise(ok => setTimeout(ok, 800));
  const offset = source.split('\n')[2].indexOf('Greet') + 1;
  let hover, definition;
  for (let attempt = 0; attempt < 80; attempt++) {
    hover = await request('quickinfo', { file: consumer, line: 3, offset });
    definition = await request('definition', { file: consumer, line: 3, offset });
    if (JSON.stringify(hover).includes('Greets a Person')) break;
    await new Promise(ok => setTimeout(ok, 50));
  }
  console.log('HOVER FROM .ts CONSUMER\n' + JSON.stringify(hover, null, 2));
  console.log('\nGO-TO-DEFINITION (physical BAML source)\n' + JSON.stringify(definition, null, 2));
} finally { child.kill(); }
