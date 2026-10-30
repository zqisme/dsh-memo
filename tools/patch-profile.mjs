/**
 * 把 dsh-memo 登记进某个 profile 的 `dsh.profile.bundles`。
 *
 * pnpm 只负责把包放进 node_modules；profile 还要把这个包列进 bundle 清单，
 * 它带的 cordis.patch.yml（插入 id: memo 那一行）才会被应用。
 *
 * 跑法：node tools/patch-profile.mjs <profile 目录>/package.json
 */
import { readFile, writeFile } from 'node:fs/promises';

const target = process.argv[2];
if (typeof target !== 'string' || target === '') {
  console.error('用法：node tools/patch-profile.mjs <profile>/package.json');
  process.exit(2);
}

const pkg = JSON.parse(await readFile(target, 'utf8'));
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
if (!bundles.includes('dsh-memo')) bundles.push('dsh-memo');
pkg.dsh.profile.bundles = bundles;

await writeFile(target, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`bundles: ${bundles.join(', ')}`);
