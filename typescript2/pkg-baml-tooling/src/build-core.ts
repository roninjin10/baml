import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { LoadProjectOptions } from './node.js';
import { loadProject } from './node.js';
import { type BamlProject, projectId } from './project.js';

export interface BamlPluginOptions {
  root?: string;
  include?: RegExp;
  exclude?: RegExp;
  target?: 'node' | 'web';
  cacheDir?: string | false;
  debug?: boolean;
}

export interface BuildHost {
  addWatchFile?(path: string): void;
  invalidate?(id: string): void;
  fullReload?(): void;
  development?: boolean;
}

export type ProjectFactory = (
  options: LoadProjectOptions,
) => Promise<BamlProject>;

export class BamlBuildCore {
  readonly #options: BamlPluginOptions;
  readonly #factory: ProjectFactory;
  #project?: BamlProject;
  #projectId = '';
  #resolved = new Map<string, { specifier: string; importer: string }>();
  #hashes = new Map<string, string>();
  #declarationHashes = new Map<string, string>();
  #lastGood = new Map<string, { code: string; watchFiles: string[] }>();
  #watchFiles: string[] = [];
  #development = false;
  #pendingShapeChange = false;

  constructor(
    options: BamlPluginOptions = {},
    factory: ProjectFactory = loadProject,
  ) {
    this.#options = options;
    this.#factory = factory;
  }

  async start(host: BuildHost = {}): Promise<void> {
    this.#development = host.development ?? this.#development;
    this.#project = await this.#factory({
      backend: 'auto',
      cacheDir:
        this.#options.cacheDir ?? (this.#development ? false : undefined),
      cwd: this.#options.root ?? process.cwd(),
      target: this.#options.target ?? 'node',
    });
    this.#projectId = projectId(
      this.#project.layout().roots[0] ?? this.#options.root ?? process.cwd(),
    );
    this.#watchFiles = this.#project.layout().watchFiles;
    for (const path of this.#watchFiles) host.addWatchFile?.(path);
  }

  enableDevelopment(): void {
    this.#development = true;
  }

  resolve(
    id: string,
    importer = resolve(this.#options.root ?? process.cwd(), 'index.ts'),
  ): string | undefined {
    if (!this.#project) throw new Error('BAML build core has not started');
    if (id.startsWith(`\0baml:${this.#projectId}:`)) return id;
    if (id !== 'baml:client' && !id.endsWith('.baml')) return undefined;
    if (this.#options.include && !this.#options.include.test(id))
      return undefined;
    if (this.#options.exclude?.test(id)) return undefined;
    const specifier =
      id === 'baml:client'
        ? id
        : isAbsolute(id)
          ? id
          : resolve(dirname(importer), id);
    if (
      specifier !== 'baml:client' &&
      (existsSync(`${specifier}.ts`) || existsSync(`${specifier}.d.ts`))
    )
      return undefined;
    const token =
      specifier === 'baml:client'
        ? 'client'
        : Buffer.from(specifier).toString('base64url');
    const virtual = `\0baml:${this.#projectId}:file:${token}`;
    this.#resolved.set(virtual, { importer, specifier });
    return virtual;
  }

  load(id: string): { code: string; watchFiles: string[] } | undefined {
    if (!this.#project) throw new Error('BAML build core has not started');
    if (id === `\0baml:${this.#projectId}:runtime`) {
      const result = this.#project.resolveModule(id);
      result.watchFiles = union(result.watchFiles, this.#watchFiles);
      this.#remember(id, result);
      return result;
    }
    const resolved = this.#resolved.get(id);
    if (!resolved) return undefined;
    const check = this.#project.check();
    const errors = check.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error',
    );
    if (errors.length > 0) {
      const previous = this.#lastGood.get(id);
      if (this.#development && previous) return previous;
      const first = errors[0];
      const error = new Error(first?.message ?? 'BAML compilation failed');
      Object.assign(error, {
        diagnostics: errors,
        id: first?.location?.path,
        pos: first?.location?.startUtf8,
      });
      throw error;
    }
    const result = this.#project.resolveModule(
      resolved.specifier,
      resolved.importer,
    );
    if (this.#development)
      result.code += '\nif (import.meta.hot) import.meta.hot.accept();\n';
    result.watchFiles = union(result.watchFiles, this.#watchFiles);
    this.#remember(id, result);
    this.#declarationHashes.set(
      id,
      declarationDigest(
        this.#project.resolveDts(resolved.specifier, resolved.importer).code,
      ),
    );
    return result;
  }

  watchChange(
    path: string,
    text: string | null | undefined,
    host: BuildHost = {},
  ): void {
    if (!this.#project) return;
    this.#development = true;
    const configChanged = path.endsWith('baml.toml');
    const sourceText =
      text === undefined
        ? (() => {
            try {
              return readFileSync(path, 'utf8');
            } catch {
              return null;
            }
          })()
        : text;
    this.#project.updateFile(path, sourceText);
    if (configChanged) {
      host.invalidate?.(`\0baml:${this.#projectId}:runtime`);
      host.fullReload?.();
      return;
    }
    const hasErrors = this.#project
      .check()
      .diagnostics.some((diagnostic) => diagnostic.severity === 'error');
    if (hasErrors) {
      for (const id of this.#resolved.keys()) host.invalidate?.(id);
      return;
    }
    let shapeChanged = false;
    for (const [id, resolved] of this.#resolved) {
      const nextDeclaration = this.#project.resolveDts(
        resolved.specifier,
        resolved.importer,
      ).code;
      const nextDeclarationHash = declarationDigest(nextDeclaration);
      if (
        this.#declarationHashes.has(id) &&
        this.#declarationHashes.get(id) !== nextDeclarationHash
      )
        shapeChanged = true;
      this.#declarationHashes.set(id, nextDeclarationHash);
      const next = this.#project.resolveModule(
        resolved.specifier,
        resolved.importer,
      );
      if (this.#hashes.get(id) !== digest(next.code)) host.invalidate?.(id);
    }
    host.invalidate?.(`\0baml:${this.#projectId}:runtime`);
    if (shapeChanged) this.#pendingShapeChange = true;
    if (this.#pendingShapeChange && host.fullReload) {
      host.fullReload();
      this.#pendingShapeChange = false;
    }
  }

  close(): void {
    this.#project?.dispose();
    this.#project = undefined;
    this.#resolved.clear();
    this.#hashes.clear();
    this.#declarationHashes.clear();
    this.#lastGood.clear();
    this.#watchFiles = [];
    this.#pendingShapeChange = false;
  }

  #remember(id: string, result: { code: string; watchFiles: string[] }): void {
    this.#hashes.set(id, digest(result.code));
    this.#lastGood.set(id, result);
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function declarationDigest(value: string): string {
  return digest(value.replace(/^\/\/ baml-fingerprint: [a-f0-9]+\r?\n/m, ''));
}

function union(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}
