import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(process.cwd());
const demo = resolve(root, '.smithers/artifacts/upstream-ts-tooling/demos/type-error-project');
await (await import('node:fs/promises')).mkdir(demo, { recursive: true });
await writeFile(join(demo, 'package.json'), '{"private":true}');
await writeFile(join(demo, 'baml.toml'), '');
await writeFile(join(demo, 'person.baml'), 'class Person { name string }\n');
await writeFile(join(demo, 'consumer.ts'), "import { Person } from './person.baml';\nconst person: Person = { name: 42 };\nconsole.log(person);\n");
await writeFile(join(demo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowArbitraryExtensions: true, module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true, target: 'es2022' }, files: ['consumer.ts'] }));
const env = { ...process.env, BAML_TOOLING_BRIDGE_PATH: resolve(root, 'baml_language/sdks/typescript/bridge_tooling/baml_tooling_node.darwin-arm64.node') };
console.log('Generating compiler-owned .baml declaration sidecar...');
execFileSync(process.execPath, [resolve(root, 'typescript2/pkg-baml-tooling/dist/bin/baml-ts-gen.js')], { cwd: demo, env, stdio: 'inherit' });
console.log('\nTypeScript reports the invalid BAML-derived Person field:');
try { execFileSync(process.execPath, [resolve(root, 'typescript2/node_modules/typescript/lib/tsc.js'), '-p', 'tsconfig.json'], { cwd: demo, env, stdio: 'inherit' }); } catch { console.log('\nExpected typecheck failure surfaced successfully.'); }
