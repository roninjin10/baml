import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ToolingRequest,
  ToolingResponse,
} from '../../pkg-baml-tooling/src/generated/tooling.js';

const repository = resolve(import.meta.dirname, '../../..');

describe('native and wasm tooling hosts', () => {
  it('return byte-identical responses for the same request corpus', async () => {
    const require = createRequire(import.meta.url);
    const nativeModule = require(
      resolve(
        repository,
        'baml_language/sdks/typescript/bridge_tooling/baml-tooling-node.js',
      ),
    ) as {
      BamlToolingBridge: new () => {
        dispatch(bytes: Uint8Array): Uint8Array;
      };
    };
    const wasmDirectory = resolve(
      repository,
      'typescript2/pkg-playground/wasm',
    );
    const wasmModule = (await import(
      resolve(wasmDirectory, 'bridge_wasm.js')
    )) as {
      default(input: { module_or_path: Uint8Array }): Promise<unknown>;
      toolingRequest(bytes: Uint8Array): Uint8Array;
    };
    await wasmModule.default({
      module_or_path: await readFile(
        resolve(wasmDirectory, 'bridge_wasm_bg.wasm'),
      ),
    });

    const native = new nativeModule.BamlToolingBridge();
    const dispatchPair = (request: ToolingRequest) => {
      const encoded = ToolingRequest.encode(request).finish();
      const nativeBytes = new Uint8Array(native.dispatch(encoded));
      const wasmBytes = wasmModule.toolingRequest(encoded);
      expect(wasmBytes).toEqual(nativeBytes);
      return ToolingResponse.decode(nativeBytes);
    };

    const root = resolve(repository, 'typescript2/pkg-ts-tooling-e2e/.parity');
    const path = resolve(root, 'main.baml');
    const configPath = resolve(root, 'baml.toml');
    const config = '[package]\nname = "parity"\n';
    const source =
      '/// Bag docs\nclass Bag { scores map<string, int> }\nfunction Read(input: Bag) -> string { "ok" }\n';
    const opened = dispatchPair({
      request: {
        $case: 'open',
        open: {
          files: [
            { path, text: source },
            { path: configPath, text: config },
          ],
          projectRoot: root,
          target: 'node',
        },
      },
    });
    if (opened.response?.$case !== 'project')
      throw new Error('open did not return project state');
    const projectId = opened.response.project.projectId;
    const bagOffset = Buffer.byteLength(
      source.slice(0, source.indexOf('Bag {')),
    );
    const requests: ToolingRequest[] = [
      { request: { $case: 'check', check: { projectId } } },
      { request: { $case: 'layout', layout: { projectId } } },
      { request: { $case: 'capabilities', capabilities: { projectId } } },
      {
        request: {
          $case: 'module',
          module: { importer: path, projectId, specifier: path },
        },
      },
      {
        request: {
          $case: 'definition',
          definition: { offsetUtf8: bagOffset, path, projectId, symbolId: '' },
        },
      },
      {
        request: {
          $case: 'references',
          references: { offsetUtf8: bagOffset, path, projectId, symbolId: '' },
        },
      },
      {
        request: {
          $case: 'hover',
          hover: { offsetUtf8: 0, path: '', projectId, symbolId: 'T:user.Bag' },
        },
      },
      {
        request: {
          $case: 'completions',
          completions: { offsetUtf8: 0, path: '', projectId, symbolId: '' },
        },
      },
      {
        request: {
          $case: 'prepareRename',
          prepareRename: {
            offsetUtf8: 0,
            path: '',
            projectId,
            symbolId: 'T:user.Bag',
          },
        },
      },
      {
        request: {
          $case: 'rename',
          rename: {
            newName: 'Container',
            offsetUtf8: 0,
            path: '',
            projectId,
            symbolId: 'T:user.Bag',
          },
        },
      },
      { request: { $case: 'runtimeModule', runtimeModule: { projectId } } },
    ];
    for (const request of requests) dispatchPair(request);
  }, 30_000);
});
