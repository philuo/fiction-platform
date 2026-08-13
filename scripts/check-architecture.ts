import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { COMMAND_DEFINITIONS } from "../src/contracts/commands";
import { COMMANDS } from "../src/api/harness";
import { MODULAR_ROUTE_PATHS } from "../src/transport/http/routes";

const projectRoot = resolve(import.meta.dir, "..");
const sourceRoot = resolve(projectRoot, "src");
const extensions = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function sourceFiles(dir: string, output: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, output);
    else if (/\.(ts|tsx)$/.test(name)) output.push(path);
  }
  return output;
}

function importsOf(file: string, known: Set<string>): string[] {
  const source = readFileSync(file, "utf8");
  const output: string[] = [];
  const pattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.\.?\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const base = resolve(dirname(file), match[1]);
    const target = extensions.map((extension) => base + extension).find((candidate) => known.has(candidate));
    if (target) output.push(target);
  }
  return output;
}

const files = sourceFiles(sourceRoot);
const known = new Set(files);
const graph = new Map(files.map((file) => [file, importsOf(file, known)]));
const errors: string[] = [];
const rel = (file: string) => relative(projectRoot, file);

function isUnder(file: string, directory: string): boolean {
  return file.startsWith(resolve(sourceRoot, directory) + "/");
}

for (const [file, dependencies] of graph) {
  for (const dependency of dependencies) {
    if (isUnder(file, "contracts") && !isUnder(dependency, "contracts") && !isUnder(dependency, "shared")) {
      errors.push(`${rel(file)}: contracts may only import contracts/shared (${rel(dependency)})`);
    }
    if (isUnder(file, "domain") && !isUnder(dependency, "contracts") && !isUnder(dependency, "domain") && !isUnder(dependency, "shared")) {
      errors.push(`${rel(file)}: domain may only import contracts/domain/shared (${rel(dependency)})`);
    }
    if (isUnder(file, "application") && (isUnder(dependency, "infrastructure") || isUnder(dependency, "transport") || isUnder(dependency, "frontend") || isUnder(dependency, "components") || isUnder(dependency, "pages"))) {
      errors.push(`${rel(file)}: application cannot import outer layers (${rel(dependency)})`);
    }
    if (isUnder(file, "frontend") && (isUnder(dependency, "infrastructure") || isUnder(dependency, "transport"))) {
      errors.push(`${rel(file)}: frontend cannot import server implementation (${rel(dependency)})`);
    }
  }
}

const visiting = new Set<string>();
const visited = new Set<string>();
const stack: string[] = [];
const cycles = new Set<string>();

function walk(file: string): void {
  visiting.add(file);
  stack.push(file);
  for (const dependency of graph.get(file) ?? []) {
    if (!visited.has(dependency) && !visiting.has(dependency)) walk(dependency);
    else if (visiting.has(dependency)) {
      const start = stack.indexOf(dependency);
      const nodes = stack.slice(start);
      const rotations = nodes.map((_, index) => nodes.slice(index).concat(nodes.slice(0, index)).map(rel).join(" -> "));
      cycles.add(rotations.sort()[0]);
    }
  }
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}

for (const file of files) if (!visited.has(file)) walk(file);
for (const cycle of [...cycles].sort()) errors.push(`circular dependency: ${cycle}`);

const harnessIds = new Set(COMMANDS.map((command) => command.id));
for (const definition of COMMAND_DEFINITIONS) {
  if (!harnessIds.has(definition.type)) errors.push(`command ${definition.type} has no HARNESS entry`);
}
const definitionIds = new Set(COMMAND_DEFINITIONS.map((definition) => definition.type));
const modularPaths = new Set<string>(MODULAR_ROUTE_PATHS);
for (const definition of COMMAND_DEFINITIONS) {
  if (!modularPaths.has(definition.path)) errors.push(`command ${definition.type} canonical path has no modular handler: ${definition.path}`);
}
if (modularPaths.size !== MODULAR_ROUTE_PATHS.length) errors.push("modular route path is owned by more than one handler");
for (const command of COMMANDS) {
  if (command.trigger === "user" && command.level !== "L0" && !definitionIds.has(command.id as never)) {
    errors.push(`public HARNESS command ${command.id} has no command definition`);
  }
}

if (!existsSync(resolve(projectRoot, "docs/INSTRUCTION.md"))) errors.push("docs/INSTRUCTION.md is missing");

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Architecture OK: ${files.length} files, ${[...graph.values()].reduce((sum, list) => sum + list.length, 0)} imports, 0 cycles, ${COMMAND_DEFINITIONS.length} public commands.`);
